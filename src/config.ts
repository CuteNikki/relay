/** The settings, from .env, checked before anything starts. */

const inboundKey = Bun.env.INBOUND_STREAM_KEY;
// Each platform is streamed to only if its key is set
export const TWITCH_KEY = Bun.env.TWITCH_STREAM_KEY || undefined;
export const YT_KEY = Bun.env.YOUTUBE_STREAM_KEY || undefined;

if (!inboundKey) {
  console.error('❌ Set INBOUND_STREAM_KEY in .env: OBS streams with it');
  process.exit(1);
}
// Typed as a string, now it's known to be set
export const INBOUND_KEY = inboundKey;

if (!TWITCH_KEY && !YT_KEY) {
  console.error(
    '❌ Set YOUTUBE_STREAM_KEY, TWITCH_STREAM_KEY or both in .env: there is nowhere to send the stream',
  );
  process.exit(1);
}

// Twitch takes less than YouTube, so its copy is scaled down and re-encoded
export const TWITCH_RESOLUTION = Bun.env.TWITCH_RESOLUTION || '1920x1080';
export const TWITCH_BITRATE = Bun.env.TWITCH_BITRATE || '6000k';
if (!/^\d+x\d+$/.test(TWITCH_RESOLUTION)) {
  console.error(
    `❌ TWITCH_RESOLUTION should be like 1920x1080, not ${TWITCH_RESOLUTION}`,
  );
  process.exit(1);
}
if (!/^\d+k$/.test(TWITCH_BITRATE)) {
  console.error(
    `❌ TWITCH_BITRATE should be like 6000k, not ${TWITCH_BITRATE}`,
  );
  process.exit(1);
}

// Where each platform takes streams. Twitch has servers nearer the VPS than
// its default one, and both can point somewhere else for testing.
export const TWITCH_INGEST =
  Bun.env.TWITCH_INGEST ?? 'rtmp://live.twitch.tv/app';
export const YT_INGEST =
  Bun.env.YOUTUBE_INGEST ?? 'rtmp://a.rtmp.youtube.com/live2';

// MediaMTX, which OBS streams to, and which takes a stream only with
// INBOUND_STREAM_KEY as its password; the relay reads it back from there
const RTMP_SERVER = Bun.env.RTMP_SERVER ?? 'rtmp-server';
export const PASS = encodeURIComponent(INBOUND_KEY);
export const INPUT_URL = `rtmp://${RTMP_SERVER}:1935/live?user=relay&pass=${PASS}`;
// Its API, which says when a stream has come in
export const STREAM_API = `http://${RTMP_SERVER}:9997/v3/paths/get/live`;

// What the dashboard reads to show whether the stream is live
export const STATUS_FILE = Bun.env.STATUS_FILE ?? '/tmp/relay/status.json';
// How often the status is written while live, at most
export const STATUS_EVERY_MS = 2000;
// How often MediaMTX is asked whether a stream has come in
export const WAIT_MS = 2000;
// How long a platform's FFmpeg waits to start again after failing, doubling
// each time it fails in a row, up to the most; a run that lasted
// STABLE_MS counts as having worked, and starts the wait over
export const RETRY_MIN_MS = 2000;
export const RETRY_MAX_MS = 30_000;
export const STABLE_MS = 60_000;
// How long a platform's FFmpeg can go without sending a frame before it's
// taken as hung and stopped, to be started again
export const STALL_MS = 15_000;
