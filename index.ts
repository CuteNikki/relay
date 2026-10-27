import { once } from 'node:events';

import {
  FALLBACK,
  FALLBACK_FOR_MS,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  STABLE_MS,
  WAIT_MS,
} from './src/config';
import { DESTINATIONS, idle, type Destination } from './src/destinations';
import { relay } from './src/ffmpeg';
import { INPUTS, reset, type Input } from './src/inputs';
import { log } from './src/log';
import { streamIsIn } from './src/mediamtx';
import { writeStatus } from './src/status';

let stopping = false;
// How long FFmpeg gets to end its streams on shutdown, within Docker's 10 s
const STOP_MS = 5000;
// How long OBS must have sent nothing before it went to count as dropped out.
// Stopping on purpose sends right up to the end, so it's quiet for a look or
// two at most; a dropped connection is quiet for MediaMTX's 5 s readTimeout,
// less the couple of seconds SRT's buffer keeps coming in: about 3 s.
const DROPPED_MS = 1500;
const WAITING = 'Waiting for a stream on port 1936 (RTMP) or 8890 (SRT)...';

/** "90 s" or "5 min" */
const seconds = (ms: number) =>
  ms < 120_000
    ? `${Math.round(ms / 1000)} s`
    : `${Math.round(ms / 60_000)} min`;

/**
 * Ends one of OBS's streams on every platform that gets it. SIGINT lets
 * FFmpeg end it properly, so the platforms see it end rather than drop.
 */
function end(input: Input, text: string) {
  reset(input);
  for (const destination of DESTINATIONS) {
    if (destination.input === input) destination.ffmpeg?.kill('SIGINT');
  }
  input.log.info(`${text} ${WAITING}`);
  writeStatus(true);
}

/** "Twitch (1080p at 6000 kb/s)", and which stream it gets once there are two */
function describe({ out, input }: Destination) {
  const which = INPUTS.length > 1 ? `, ${input.label.toLowerCase()}` : '';
  return `${out.name} (${out.sends}${which})`;
}

/** The main loop: looks at each of OBS's streams every WAIT_MS. */
async function watch() {
  log.info(`📤 Sends to ${DESTINATIONS.map(describe).join(', ')}`);
  log.info(`📡 ${WAITING}`);
  while (!stopping) {
    await Promise.all(INPUTS.map(look));
    writeStatus();
    await Bun.sleep(WAIT_MS);
  }
}

/** One look at one of OBS's streams, acting on what's changed. */
async function look(input: Input) {
  const online = await streamIsIn(input);
  if (online && !input.live) {
    input.live = true;
    input.since = Date.now();
    input.log.info('🔴 A stream came in, sending it on');
    writeStatus(true);
  } else if (online && input.fallbackSince) {
    input.log.info(
      `🟢 OBS is back after ${seconds(Date.now() - input.fallbackSince)}, sending it on again`,
    );
    input.fallbackSince = undefined;
    writeStatus(true);
  } else if (!online && input.live) {
    gone(input);
  }
  // On every look, not only when it came in, so a platform whose FFmpeg gave
  // up as the stream blipped is started again
  if (input.live) {
    for (const destination of DESTINATIONS) {
      if (destination.input === input && !destination.running) {
        void send(destination);
      }
    }
  }
}

/**
 * OBS has gone: end the stream if it stopped on purpose, or if it dropped out,
 * show the fallback for up to FALLBACK_FOR.
 */
function gone(input: Input) {
  if (!FALLBACK) return end(input, '📡 The stream ended.');
  if (input.fallbackSince) {
    if (Date.now() - input.fallbackSince >= FALLBACK_FOR_MS) {
      end(
        input,
        `⌛ OBS didn't come back within ${seconds(FALLBACK_FOR_MS)}, so the stream has ended.`,
      );
    }
    return;
  }
  const quiet = Date.now() - input.inbound.at;
  if (quiet < DROPPED_MS) return end(input, '📡 OBS stopped streaming.');
  input.fallbackSince = Date.now();
  writeStatus(true);
  input.log.warn(
    `📴 OBS dropped out, having sent nothing for ${seconds(quiet)}: showing the fallback for up to ${seconds(FALLBACK_FOR_MS)}`,
  );
}

/**
 * Keeps one platform's FFmpeg running while its stream is live, retrying with
 * a growing delay. Each platform has its own, so one failing leaves the
 * others going.
 */
async function send(destination: Destination) {
  destination.running = true;
  let delay = RETRY_MIN_MS;
  while (destination.input.live && !stopping) {
    const started = Date.now();
    const { how, why } = await relay(destination);
    // The stream ending isn't a failure. With the fallback, FFmpeg's input
    // never ends, so it's over only when end() says.
    if (stopping || !destination.input.live) break;
    if (!FALLBACK && !(await streamIsIn(destination.input))) break;
    if (Date.now() - started > STABLE_MS) delay = RETRY_MIN_MS;
    destination.out.state = 'retrying';
    destination.out.retries++;
    log
      .for(destination.out.name)
      .warn(
        `🔁 Failed (${why ?? `FFmpeg exited with ${how}`}), trying again in ${delay / 1000} s`,
      );
    writeStatus(true);
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }
  destination.out = idle(destination.out);
  destination.running = false;
  writeStatus(true);
}

/** Lets each FFmpeg end its streams properly, killing any that take too long. */
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info(`🛑 ${signal}: stopping, letting FFmpeg end the streams...`);
  const running = DESTINATIONS.flatMap(
    (destination) => destination.ffmpeg ?? [],
  );
  for (const ffmpeg of running) ffmpeg.kill('SIGINT');
  await Promise.race([
    Promise.all(running.map((ffmpeg) => once(ffmpeg, 'close'))),
    Bun.sleep(STOP_MS),
  ]);
  for (const ffmpeg of running) {
    if (ffmpeg.exitCode === null && ffmpeg.signalCode === null) {
      log.warn(`⚠️ FFmpeg didn't stop within ${STOP_MS / 1000} s, killing it`);
      ffmpeg.kill('SIGKILL');
    }
  }
  // Offline, for the dashboard, rather than live until it goes stale
  for (const input of INPUTS) reset(input);
  for (const destination of DESTINATIONS) {
    destination.out = idle(destination.out);
  }
  writeStatus(true);
  process.exit(0);
}

process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));

/** Logs what went unexpectedly wrong and exits, for Docker to restart it clean. */
function crash(error: unknown) {
  log.error(
    `💥 The relay crashed: ${error instanceof Error ? error.stack : error}`,
  );
  for (const destination of DESTINATIONS) destination.ffmpeg?.kill('SIGKILL');
  process.exit(1);
}
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

void watch();
