import { RETRY_MAX_MS, RETRY_MIN_MS, STABLE_MS, WAIT_MS } from './src/config';
import { DESTINATIONS, idle, type Destination } from './src/destinations';
import { relay } from './src/ffmpeg';
import { log } from './src/log';
import { streamIsIn } from './src/mediamtx';
import { stream, writeStatus } from './src/status';

let stopping = false;

/**
 * Asks MediaMTX the whole time whether a stream is coming in, and while one
 * is, sees that every platform is being sent it.
 */
async function watch() {
  log('📡 Waiting for a stream on port 1936...');
  while (!stopping) {
    const online = await streamIsIn();
    if (online && !stream.live) {
      stream.live = true;
      stream.since = Date.now();
      log('🔴 A stream came in, sending it on');
    } else if (!online && stream.live) {
      stream.live = false;
      stream.since = undefined;
      stream.input = {};
      log('📡 The stream ended. Waiting for the next one on port 1936...');
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
    const code = await relay(d);
    // Its input ending is the stream ending, not a failure
    if (stopping || !(await streamIsIn())) break;
    if (Date.now() - started > STABLE_MS) delay = RETRY_MIN_MS;
    d.out.state = 'retrying';
    d.out.retries++;
    log(
      `🔁 ${d.out.name}: FFmpeg exited with code ${code}, trying again in ${delay / 1000} s`,
    );
    writeStatus(true);
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }
  d.out = idle(d.out.name, d.out.sends);
  d.running = false;
  writeStatus(true);
}

function stop() {
  log('🛑 Stopping relay, killing FFmpeg...');
  stopping = true;
  for (const d of DESTINATIONS) d.ffmpeg?.kill('SIGINT');
  process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

void watch();
