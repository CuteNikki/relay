import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const INBOUND_KEY = Bun.env.INBOUND_STREAM_KEY;
// Each platform is streamed to only if its key is set
const TWITCH_KEY = Bun.env.TWITCH_STREAM_KEY || undefined;
const YT_KEY = Bun.env.YOUTUBE_STREAM_KEY || undefined;

if (!INBOUND_KEY) {
  console.error('❌ Set INBOUND_STREAM_KEY in .env: OBS streams with it');
  process.exit(1);
}
if (!TWITCH_KEY && !YT_KEY) {
  console.error(
    '❌ Set YOUTUBE_STREAM_KEY, TWITCH_STREAM_KEY or both in .env: there is nowhere to send the stream',
  );
  process.exit(1);
}

// Twitch takes less than YouTube, so its copy is scaled down and re-encoded
const TWITCH_RESOLUTION = Bun.env.TWITCH_RESOLUTION || '1920x1080';
const TWITCH_BITRATE = Bun.env.TWITCH_BITRATE || '6000k';
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
const TWITCH_INGEST = Bun.env.TWITCH_INGEST ?? 'rtmp://live.twitch.tv/app';
const YT_INGEST = Bun.env.YOUTUBE_INGEST ?? 'rtmp://a.rtmp.youtube.com/live2';

// MediaMTX, which OBS streams to, and which takes a stream only with
// INBOUND_STREAM_KEY as its password; the relay reads it back from there
const RTMP_SERVER = Bun.env.RTMP_SERVER ?? 'rtmp-server';
const PASS = encodeURIComponent(INBOUND_KEY);
const INPUT_URL = `rtmp://${RTMP_SERVER}:1935/live?user=relay&pass=${PASS}`;
// Its API, which says when a stream has come in
const STREAM_API = `http://${RTMP_SERVER}:9997/v3/paths/get/live`;

// What the dashboard reads to show whether the stream is live
const STATUS_FILE = Bun.env.STATUS_FILE ?? '/tmp/relay/status.json';
// How often the status is written while live, at most
const STATUS_EVERY_MS = 2000;
// How often MediaMTX is asked whether a stream has come in
const WAIT_MS = 2000;
// How long a platform's FFmpeg waits to start again after failing, doubling
// each time it fails in a row, up to the most; a run that lasted
// STABLE_MS counts as having worked, and starts the wait over
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30_000;
const STABLE_MS = 60_000;

// FFmpeg names its input and outputs by their full URL, keys and all, so
// they're hidden in everything printed, since the logs are shown elsewhere
const SECRETS = [INBOUND_KEY, PASS, TWITCH_KEY, YT_KEY].filter(
  (key): key is string => !!key,
);
function hide(text: string) {
  return SECRETS.reduce((out, key) => out.replaceAll(key, '***'), text);
}
function log(text: string) {
  process.stdout.write(hide(text.endsWith('\n') ? text : `${text}\n`));
}

/** How one platform is doing, each sent to by its own FFmpeg */
type Output = {
  name: string;
  /** What it gets, e.g. "as it comes in" or "1080p at 6000 kb/s" */
  sends: string;
  /**
   * Waiting for a stream; connecting to the platform; sending to it; or,
   * after FFmpeg failed while the stream was still coming in, waiting to
   * try again
   */
  state: 'waiting' | 'connecting' | 'live' | 'retrying';
  /** When it started sending, in milliseconds since 1970 */
  since?: number;
  fps?: number;
  /** e.g. "16000.5kbits/s" */
  bitrate?: string;
  /** How fast it keeps up, e.g. "1x": under 1 is falling behind */
  speed?: string;
  droppedFrames?: number;
  /** How many times it's been started again during this stream */
  retries: number;
  /** What FFmpeg last complained of when it failed, keys hidden */
  lastError?: string;
};

type Status = {
  live: boolean;
  /** When the stream came in, in milliseconds since 1970 */
  since?: number;
  /** What comes in, e.g. "h264, 2560x1440, 60 fps" and "aac, 48000 Hz, stereo" */
  input: { video?: string; audio?: string };
  // The outputs sending, taken together, as when one FFmpeg sent to them all
  /** The slowest one's */
  fps?: number;
  /** All of them together, e.g. "22000.5kbits/s" */
  bitrate?: string;
  /** The slowest one's, e.g. "1x": under 1 is falling behind */
  speed?: string;
  /** All of them together */
  droppedFrames?: number;
  outputs: Output[];
  /** When this was written, so a reader can tell a live one is current */
  updatedAt: number;
};

/** Twitch's bitrate as people say it: "6000k" → "6000 kb/s" */
const twitchSends = `${TWITCH_RESOLUTION.split('x')[1]}p at ${TWITCH_BITRATE.replace(/k$/, ' kb/s')}`;

/**
 * Where the stream goes, and FFmpeg's arguments for each: YouTube gets it as
 * it comes in, copied untouched, first; Twitch a copy scaled down and
 * re-encoded, as it takes less.
 */
const DESTINATIONS = [
  YT_KEY && {
    name: 'YouTube',
    sends: 'as it comes in',
    args: [
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      '-flvflags',
      'no_duration_filesize',
      '-f',
      'flv',
      `${YT_INGEST}/${YT_KEY}`,
    ],
  },
  TWITCH_KEY && {
    name: 'Twitch',
    sends: twitchSends,
    args: [
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'superfast',
      // A keyframe every 2 seconds, as Twitch asks, whatever the frame rate:
      // a fixed -g 120 was 2 s at 60 fps but 4 s at 30. Scene cuts add none
      // of their own, so they stay evenly spaced.
      '-force_key_frames',
      'expr:gte(t,n_forced*2)',
      '-sc_threshold',
      '0',
      '-b:v',
      TWITCH_BITRATE,
      '-maxrate',
      TWITCH_BITRATE,
      // Twice the bitrate, in the same unit
      '-bufsize',
      `${Number(TWITCH_BITRATE.slice(0, -1)) * 2}k`,
      '-s',
      TWITCH_RESOLUTION,
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-flvflags',
      'no_duration_filesize',
      '-f',
      'flv',
      `${TWITCH_INGEST}/${TWITCH_KEY}`,
    ],
  },
]
  .filter((d) => !!d)
  .map(({ name, sends, args }) => ({
    args,
    out: idle(name, sends),
    ffmpeg: undefined as ChildProcess | undefined,
    /** Whether send() is looking after it, so it's never started twice */
    running: false,
  }));
type Destination = (typeof DESTINATIONS)[number];

function idle(name: string, sends: string): Output {
  return { name, sends, state: 'waiting', retries: 0 };
}

// Whether a stream is coming in, by MediaMTX, since when, and what it is
let live = false;
let since: number | undefined;
let input: Status['input'] = {};
let lastWrite = 0;

/** Writes the status whole, through a temporary file, so it's never read half written. */
function writeStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < STATUS_EVERY_MS) return;
  lastWrite = now;
  const outputs = DESTINATIONS.map((d) => d.out);
  const status: Status = {
    live,
    since,
    input,
    ...together(outputs.filter((o) => o.state === 'live')),
    outputs,
    updatedAt: now,
  };
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true });
    writeFileSync(`${STATUS_FILE}.tmp`, JSON.stringify(status));
    renameSync(`${STATUS_FILE}.tmp`, STATUS_FILE);
  } catch (error) {
    log(`⚠️ Couldn't write the status: ${error}`);
  }
}

/**
 * The outputs sending, taken together, for whoever read the status when one
 * FFmpeg sent to them all: their bitrates and dropped frames added up, and
 * the slowest one's frame rate and speed, since that's the one falling behind
 */
function together(outputs: Output[]) {
  if (!outputs.length) return {};
  const numbers = (values: (string | number | undefined)[]) =>
    values.map((v) => parseFloat(`${v}`)).filter(Number.isFinite);
  const fps = numbers(outputs.map((o) => o.fps));
  const speeds = numbers(outputs.map((o) => o.speed));
  const kbits = numbers(outputs.map((o) => o.bitrate)).reduce((a, b) => a + b, 0);
  return {
    fps: fps.length ? Math.min(...fps) : undefined,
    bitrate: `${kbits.toFixed(1)}kbits/s`,
    speed: speeds.length ? `${Math.min(...speeds)}x` : undefined,
    droppedFrames: outputs.reduce((sum, o) => sum + (o.droppedFrames ?? 0), 0),
  };
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

/**
 * Asks MediaMTX the whole time whether a stream is coming in, and while one
 * is, sees that every platform is being sent it.
 */
async function watch() {
  log('📡 Waiting for a stream on port 1936...');
  while (!stopping) {
    const online = await streamIsIn();
    if (online && !live) {
      live = true;
      since = Date.now();
      log('🔴 A stream came in, sending it on');
    } else if (!online && live) {
      live = false;
      since = undefined;
      input = {};
      log('📡 The stream ended. Waiting for the next one on port 1936...');
    }
    // Every time, not only when it came in, so a platform whose FFmpeg gave
    // up as the stream went and came back quickly is started again
    if (live) for (const d of DESTINATIONS) if (!d.running) void send(d);
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
  while (live && !stopping) {
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

/** Runs one platform's FFmpeg until it exits, with the code it exits with. */
function relay(d: Destination) {
  const { out } = d;
  const tag = `[${out.name}]`;
  Object.assign(out, {
    state: 'connecting',
    since: undefined,
    fps: undefined,
    bitrate: undefined,
    speed: undefined,
    droppedFrames: undefined,
  });
  writeStatus(true);

  const ffmpeg = spawn('ffmpeg', [
    // Its progress as key=value lines on stdout, for the status, in place
    // of the line it would otherwise keep rewriting in the logs
    '-nostats',
    '-progress',
    'pipe:1',
    '-i',
    INPUT_URL,
    ...d.args,
  ]);
  d.ffmpeg = ffmpeg;

  // What it says about the stream: the input's streams come under
  // "Input #0", the outputs' under "Output #…"
  let section: 'input' | 'output' | undefined;
  // The last thing it complained of, for the status should it fail.
  // "Conversion failed!" is how it always ends, so says nothing.
  let complaint: string | undefined;
  createInterface({ input: ffmpeg.stderr! }).on('line', (line) => {
    log(`${tag} ${line}`);
    if (/^Input #0/.test(line)) {
      section = 'input';
    } else if (/^Output #/.test(line)) {
      section = 'output';
    } else if (section === 'input' && /Stream #.*: Video:/.test(line)) {
      input.video = describeVideo(line);
    } else if (section === 'input' && /Stream #.*: Audio:/.test(line)) {
      input.audio = describeAudio(line);
    }
    if (
      /error|fail|refused|denied|timed out|invalid|broken pipe/i.test(line) &&
      !/^Conversion failed!$/.test(line.trim())
    ) {
      complaint = line.trim();
    }
  });

  // Its progress, a block of key=value lines ending in "progress=…". The
  // first comes once it's connected to the platform and sending.
  createInterface({ input: ffmpeg.stdout! }).on('line', (line) => {
    const [key, value] = line.split('=', 2).map((s) => s.trim());
    if (key === 'fps') out.fps = Number(value);
    else if (key === 'bitrate') out.bitrate = value;
    else if (key === 'speed') out.speed = value;
    else if (key === 'drop_frames') out.droppedFrames = Number(value);
    else if (key === 'progress') {
      if (out.state === 'connecting') {
        out.state = 'live';
        out.since = Date.now();
        delete out.lastError;
        log(`✅ ${out.name}: sending`);
        writeStatus(true);
      } else writeStatus();
    }
  });

  return new Promise<number | null>((resolve) => {
    ffmpeg.on('close', (code) => {
      log(`${tag} FFmpeg exited with code ${code}`);
      if (code && complaint) out.lastError = hide(complaint);
      d.ffmpeg = undefined;
      resolve(code);
    });
  });
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
