import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const INBOUND_KEY = Bun.env.INBOUND_STREAM_KEY;
const TWITCH_KEY = Bun.env.TWITCH_STREAM_KEY;
const YT_KEY = Bun.env.YOUTUBE_STREAM_KEY;

if (!INBOUND_KEY || !TWITCH_KEY || !YT_KEY) {
  console.error('❌ Missing stream keys in .env file!');
  process.exit(1);
}

// Where each platform takes streams. Twitch has servers nearer the VPS than
// its default one, and both can point somewhere else for testing.
const TWITCH_INGEST = Bun.env.TWITCH_INGEST ?? 'rtmp://live.twitch.tv/app';
const YT_INGEST = Bun.env.YOUTUBE_INGEST ?? 'rtmp://a.rtmp.youtube.com/live2';

// MediaMTX, which OBS streams to, and which takes a stream only with
// INBOUND_STREAM_KEY as its password; the relay reads it back from there
const RTMP_SERVER = Bun.env.RTMP_SERVER ?? 'rtmp-server';
const PASS = encodeURIComponent(INBOUND_KEY);
const INPUT_URL = `rtmp://${RTMP_SERVER}:1935/live?user=relay&pass=${PASS}`;
// Its API, which says when a stream has come in
const STREAM_API = `http://${RTMP_SERVER}:9997/v3/paths/get/live`;
const TWITCH_URL = `${TWITCH_INGEST}/${TWITCH_KEY}`;
const YT_URL = `${YT_INGEST}/${YT_KEY}`;

// What the dashboard reads to show whether the stream is live
const STATUS_FILE = Bun.env.STATUS_FILE ?? '/tmp/relay/status.json';
// How often the status is written while live, at most
const STATUS_EVERY_MS = 2000;
// How often MediaMTX is asked whether a stream has come in
const WAIT_MS = 2000;

// FFmpeg names its input and outputs by their full URL, keys and all, so
// they're hidden in everything printed, since the logs are shown elsewhere
const SECRETS = [INBOUND_KEY, PASS, TWITCH_KEY, YT_KEY];
function hide(text: string) {
  return SECRETS.reduce((out, key) => out.replaceAll(key, '***'), text);
}
function log(text: string) {
  process.stdout.write(hide(text.endsWith('\n') ? text : `${text}\n`));
}

type Status = {
  live: boolean;
  /** When the stream came in, in milliseconds since 1970 */
  since?: number;
  /** What comes in, e.g. "h264, 2560x1440, 60 fps" and "aac, 48000 Hz, stereo" */
  input: { video?: string; audio?: string };
  fps?: number;
  /** All the outputs together, e.g. "22000.5kbits/s" */
  bitrate?: string;
  /** How fast it keeps up, e.g. "1x": under 1 is falling behind */
  speed?: string;
  droppedFrames?: number;
  outputs: { name: string; sends: string }[];
  /** When this was written, so a reader can tell a live one is current */
  updatedAt: number;
};

const OUTPUTS = [
  { name: 'YouTube', sends: 'as it comes in' },
  { name: 'Twitch', sends: '1080p at 6000 kb/s' },
];

let status: Status = { live: false, input: {}, outputs: OUTPUTS, updatedAt: 0 };
let lastWrite = 0;

/** Writes the status whole, through a temporary file, so it's never read half written. */
function writeStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < STATUS_EVERY_MS) return;
  lastWrite = now;
  status.updatedAt = now;
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true });
    writeFileSync(`${STATUS_FILE}.tmp`, JSON.stringify(status));
    renameSync(`${STATUS_FILE}.tmp`, STATUS_FILE);
  } catch (error) {
    log(`⚠️ Couldn't write the status: ${error}`);
  }
}

/** "Stream #0:0: Video: h264 (High), yuv420p(…), 2560x1440 [SAR 1:1 DAR 16:9], 16000 kb/s, 60 fps, …" → "h264, 2560x1440, 60 fps" */
function describeVideo(line: string) {
  const codec = line.match(/Video: (\w+)/)?.[1];
  const size = line.match(/\b(\d{2,5}x\d{2,5})\b/)?.[1];
  const fps = line.match(/([\d.]+) fps/)?.[1];
  return [codec, size, fps && `${fps} fps`].filter(Boolean).join(', ');
}

/** "Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp, 160 kb/s" → "aac, 48000 Hz, stereo" */
function describeAudio(line: string) {
  const codec = line.match(/Audio: (\w+)/)?.[1];
  const rate = line.match(/(\d+ Hz)/)?.[1];
  const layout = line.match(/Hz, ([\w.()]+)/)?.[1];
  return [codec, rate, layout].filter(Boolean).join(', ');
}

let ffmpeg: ChildProcess | undefined;
let stopping = false;

/** Whether OBS is streaming to MediaMTX, by its API: until it is, there's no such path. */
async function streamIsIn() {
  try {
    const res = await fetch(STREAM_API, {
      headers: { Authorization: `Basic ${btoa(`relay:${INBOUND_KEY}`)}` },
      signal: AbortSignal.timeout(WAIT_MS),
    });
    if (!res.ok) return false;
    return ((await res.json()) as { online?: boolean }).online === true;
  } catch {
    // MediaMTX not up yet, as just after the stack starts
    return false;
  }
}

/** Waits for a stream to come in, then relays it. */
async function start() {
  status = { live: false, input: {}, outputs: OUTPUTS, updatedAt: 0 };
  writeStatus(true);
  log('📡 Waiting for a stream on port 1936...');
  while (!(await streamIsIn())) {
    if (stopping) return;
    await Bun.sleep(WAIT_MS);
  }
  relay();
}

function relay() {
  ffmpeg = spawn('ffmpeg', [
    // Its progress as key=value lines on stdout, for the status, in place
    // of the line it would otherwise keep rewriting in the logs
    '-nostats',
    '-progress',
    'pipe:1',
    '-i',
    INPUT_URL,

    // -------------------------------------------------------------------------
    // OUTPUT 1: YOUTUBE STREAM (Pure 1440p Passthrough Copy - FIRST)
    // -------------------------------------------------------------------------
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    'copy', // Take the raw 16000 Kbps 1440p stream...
    '-c:a',
    'copy', // ...and pristine audio packets directly.
    '-flvflags',
    'no_duration_filesize',
    '-f',
    'flv',
    YT_URL, // Push straight out to YouTube first.

    // -------------------------------------------------------------------------
    // OUTPUT 2: TWITCH STREAM (Downscaled 1080p @ 6000k - SECOND)
    // -------------------------------------------------------------------------
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    'libx264', // Branch off a separate encoder instance.
    '-preset',
    'superfast',
    '-g',
    '120',
    '-b:v',
    '6000k',
    '-maxrate',
    '6000k',
    '-bufsize',
    '12000k',
    '-s',
    '1920x1080', // Compress and downscale this track alone.
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-flvflags',
    'no_duration_filesize',
    '-f',
    'flv',
    TWITCH_URL,
  ]);

  // What it says about the stream: the input's streams come under
  // "Input #0", the outputs' under "Output #…"
  let section: 'input' | 'output' | undefined;
  createInterface({ input: ffmpeg.stderr! }).on('line', (line) => {
    log(line);
    if (/^Input #0/.test(line)) {
      section = 'input';
      status.live = true;
      status.since = Date.now();
      writeStatus(true);
    } else if (/^Output #/.test(line)) {
      section = 'output';
    } else if (section === 'input' && /Stream #.*: Video:/.test(line)) {
      status.input.video = describeVideo(line);
    } else if (section === 'input' && /Stream #.*: Audio:/.test(line)) {
      status.input.audio = describeAudio(line);
    }
  });

  // Its progress, a block of key=value lines ending in "progress=…"
  createInterface({ input: ffmpeg.stdout! }).on('line', (line) => {
    const [key, value] = line.split('=', 2).map((s) => s.trim());
    if (key === 'fps') status.fps = Number(value);
    else if (key === 'bitrate') status.bitrate = value;
    else if (key === 'speed') status.speed = value;
    else if (key === 'drop_frames') status.droppedFrames = Number(value);
    else if (key === 'progress') writeStatus();
  });

  ffmpeg.on('close', (code) => {
    log(`\n❌ FFmpeg exited with code ${code}`);
    status = { live: false, input: {}, outputs: OUTPUTS, updatedAt: 0 };
    writeStatus(true);
    // Waiting for the next stream, rather than leaving Docker to restart the
    // container, which it does more slowly each time it exits quickly
    if (!stopping) void start();
  });
}

function stop() {
  log('🛑 Stopping relay, killing FFmpeg...');
  stopping = true;
  ffmpeg?.kill('SIGINT');
  process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

void start();
