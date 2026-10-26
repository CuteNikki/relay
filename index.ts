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
import { log } from './src/log';
import { quietBeforeLeaving, streamIsIn } from './src/mediamtx';
import { stream, writeStatus } from './src/status';

let stopping = false;
// How long FFmpeg is given to close its streams when the relay stops,
// within Docker's 10 seconds before it kills the container
const STOP_MS = 5000;
// OBS going quiet for longer than this before it went means it dropped out:
// stopping on purpose sends right up to the end, so it's quiet for at most
// two of the relay's looks at MediaMTX, a quarter of a second apart, where a
// dropped connection is quiet for the 5 seconds MediaMTX waits before giving
// up on it, less what SRT's buffer still had to give: 3 with OBS's 2
const DROPPED_MS = 1500;
const WAITING = 'Waiting for a stream on port 1936 (RTMP) or 8890 (SRT)...';

/** "90 s" or "5 min" */
const seconds = (ms: number) =>
  ms < 120_000
    ? `${Math.round(ms / 1000)} s`
    : `${Math.round(ms / 60_000)} min`;

/**
 * Ends the stream on every platform: each FFmpeg is stopped as Ctrl+C would,
 * so the platforms see the stream end rather than drop. Without the fallback,
 * they're ending anyway, as what they read from MediaMTX has.
 */
function end(text: string) {
  stream.live = false;
  stream.since = undefined;
  stream.fallbackSince = undefined;
  stream.input = {};
  for (const d of DESTINATIONS) d.ffmpeg?.kill('SIGINT');
  log.info(`${text} ${WAITING}`);
  writeStatus(true);
}

/**
 * Asks MediaMTX the whole time whether a stream is coming in, and while one
 * is, sees that every platform is being sent it.
 */
async function watch() {
  log.info(
    `📤 Sends to ${DESTINATIONS.map((d) => `${d.out.name} (${d.out.sends})`).join(', ')}`,
  );
  log.info(`📡 ${WAITING}`);
  while (!stopping) {
    const online = await streamIsIn();
    if (online && !stream.live) {
      stream.live = true;
      stream.since = Date.now();
      log.info('🔴 A stream came in, sending it on');
      writeStatus(true);
    } else if (online && stream.fallbackSince) {
      log.info(
        `🟢 OBS is back after ${seconds(Date.now() - stream.fallbackSince)}, sending it on again`,
      );
      stream.fallbackSince = undefined;
      writeStatus(true);
    } else if (!online && stream.live) {
      gone();
    }
    // Every time, not only when it came in, so a platform whose FFmpeg gave
    // up as the stream went and came back quickly is started again
    if (stream.live) for (const d of DESTINATIONS) if (!d.running) void send(d);
    // Every couple of seconds at most, and at once when something's changed
    writeStatus();
    await Bun.sleep(WAIT_MS);
  }
}

/**
 * What to do with OBS gone: without the fallback, or if it stopped on
 * purpose, end the stream; if it dropped out, let MediaMTX's clip play in its
 * place, for as long as FALLBACK_FOR, and end the stream after that.
 */
function gone() {
  if (!FALLBACK) return end('📡 The stream ended.');
  if (stream.fallbackSince) {
    if (Date.now() - stream.fallbackSince >= FALLBACK_FOR_MS) {
      end(
        `⌛ OBS didn't come back within ${seconds(FALLBACK_FOR_MS)}, so the stream has ended.`,
      );
    }
    return;
  }
  const quiet = quietBeforeLeaving();
  if (quiet < DROPPED_MS) return end('📡 OBS stopped streaming.');
  stream.fallbackSince = Date.now();
  writeStatus(true);
  log.warn(
    `📴 OBS dropped out, having sent nothing for ${seconds(quiet)}: showing the fallback for up to ${seconds(FALLBACK_FOR_MS)}`,
  );
}

/**
 * Sends the stream to one platform for as long as it comes in. Each has its
 * own FFmpeg, so one platform failing, say Twitch turning the key away or
 * its server dropping out, leaves the others going; FFmpeg is started again
 * by itself, waiting longer each time it fails in a row.
 */
async function send(d: Destination) {
  d.running = true;
  let delay = RETRY_MIN_MS;
  while (stream.live && !stopping) {
    const started = Date.now();
    const { how, why } = await relay(d);
    // Its input ending is the stream ending, not a failure. With the
    // fallback, its input never ends: the stream has ended when end() says.
    if (stopping || !stream.live) break;
    if (!FALLBACK && !(await streamIsIn())) break;
    if (Date.now() - started > STABLE_MS) delay = RETRY_MIN_MS;
    d.out.state = 'retrying';
    d.out.retries++;
    log
      .for(d.out.name)
      .warn(
        `🔁 Failed (${why ?? `FFmpeg exited with ${how}`}), trying again in ${delay / 1000} s`,
      );
    writeStatus(true);
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }
  d.out = idle(d.out.name, d.out.sends);
  d.running = false;
  writeStatus(true);
}

/**
 * Stops each FFmpeg as Ctrl+C would, so it ends its streams properly and the
 * platforms see them end rather than drop, killing any that don't in time.
 */
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info(`🛑 ${signal}: stopping, letting FFmpeg end the streams...`);
  const running = DESTINATIONS.flatMap((d) => d.ffmpeg ?? []);
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
  stream.live = false;
  stream.since = undefined;
  stream.fallbackSince = undefined;
  stream.input = {};
  for (const d of DESTINATIONS) d.out = idle(d.out.name, d.out.sends);
  writeStatus(true);
  process.exit(0);
}

process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));

// Something the relay didn't see coming: said in full, then exiting, for
// Docker to start it again, rather than going on in a state nobody knows
function crash(error: unknown) {
  log.error(
    `💥 The relay crashed: ${error instanceof Error ? error.stack : error}`,
  );
  for (const d of DESTINATIONS) d.ffmpeg?.kill('SIGKILL');
  process.exit(1);
}
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

void watch();
