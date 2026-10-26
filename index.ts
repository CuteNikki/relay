import { once } from 'node:events';

import { RETRY_MAX_MS, RETRY_MIN_MS, STABLE_MS, WAIT_MS } from './src/config';
import { DESTINATIONS, idle, type Destination } from './src/destinations';
import { relay } from './src/ffmpeg';
import { log } from './src/log';
import { streamIsIn } from './src/mediamtx';
import { stream, writeStatus } from './src/status';

let stopping = false;
// How long FFmpeg is given to close its streams when the relay stops,
// within Docker's 10 seconds before it kills the container
const STOP_MS = 5000;

/**
 * Asks MediaMTX the whole time whether a stream is coming in, and while one
 * is, sees that every platform is being sent it.
 */
async function watch() {
  log.info('📡 Waiting for a stream on port 1936 (RTMP) or 8890 (SRT)...');
  while (!stopping) {
    const online = await streamIsIn();
    if (online && !stream.live) {
      stream.live = true;
      stream.since = Date.now();
      log.info('🔴 A stream came in, sending it on');
    } else if (!online && stream.live) {
      stream.live = false;
      stream.since = undefined;
      stream.input = {};
      log.info(
        '📡 The stream ended. Waiting for the next one on port 1936 (RTMP) or 8890 (SRT)...',
      );
    }
    // Every time, not only when it came in, so a platform whose FFmpeg gave
    // up as the stream went and came back quickly is started again
    if (stream.live) for (const d of DESTINATIONS) if (!d.running) void send(d);
    writeStatus(true);
    await Bun.sleep(WAIT_MS);
  }
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
    // Its input ending is the stream ending, not a failure
    if (stopping || !(await streamIsIn())) break;
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
