/** The settings, from .env, checked before anything starts. */

import { hideInLogs, log } from './log';

/** Says what's wrong with the settings and stops: nothing can work without them. */
function fail(text: string): never {
  log.error(`❌ ${text}`);
  process.exit(1);
}

const inboundKey = Bun.env.INBOUND_STREAM_KEY;
if (!inboundKey) fail('Set INBOUND_STREAM_KEY in .env: OBS streams with it');
// Typed as a string, now it's known to be set
export const INBOUND_KEY = inboundKey;

/**
 * The streams OBS can send: the usual landscape one, and a vertical one for
 * platforms that want 9:16, such as YouTube Shorts and TikTok, which OBS
 * sends as a second stream of its own
 */
export const INPUT_NAMES = ['landscape', 'vertical'] as const;
export type InputName = (typeof INPUT_NAMES)[number];

/**
 * Somewhere the stream goes: an RTMP or RTMPS server, the key it takes,
 * which of OBS's streams it gets, and, if it's re-encoded rather than sent
 * as it comes in, at what resolution and bitrate, and with which of x264's
 * presets. Without a resolution, it keeps the size it comes in at.
 */
export type OutputSettings = {
  name: string;
  url: string;
  key: string;
  input: InputName;
  encode?: { resolution?: string; bitrate: string; preset: string };
};

// An empty setting, as KEY= in .env, is the same as none
const setting = (name: string) => Bun.env[name] || undefined;

function rtmpUrl(name: string, url: string) {
  if (!/^rtmps?:\/\/[^/]+/.test(url)) {
    fail(`${name} should be an rtmp:// or rtmps:// address, not ${url}`);
  }
  return url.replace(/\/+$/, '');
}
function checkResolution(name: string, value?: string) {
  if (value && !/^\d+x\d+$/.test(value)) {
    fail(`${name} should be like 1920x1080, not ${value}`);
  }
  return value;
}
function checkBitrate(name: string, value?: string) {
  if (value && !/^\d+k$/.test(value)) {
    fail(`${name} should be like 6000k, not ${value}`);
  }
  return value;
}
// x264's presets, from least CPU and worst picture for the bitrate to most
// and best. superfast, the default, is light; veryfast is what OBS uses
export const PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
];
function checkPreset(name: string, value?: string) {
  if (value && !PRESETS.includes(value)) {
    fail(`${name} should be one of ${PRESETS.join(', ')}, not ${value}`);
  }
  return value;
}

// YouTube and Twitch had settings of their own before they were outputs
// like any other. An .env from then would otherwise only say there's
// nowhere to send the stream, without saying why.
const REMOVED_SETTINGS = [
  'YOUTUBE_STREAM_KEY',
  'YOUTUBE_INGEST',
  'TWITCH_STREAM_KEY',
  'TWITCH_INGEST',
  'TWITCH_RESOLUTION',
  'TWITCH_BITRATE',
].filter((name) => setting(name));
if (REMOVED_SETTINGS.length) {
  fail(
    `${REMOVED_SETTINGS.join(', ')} ${REMOVED_SETTINGS.length > 1 ? 'are' : 'is'} no longer used: YouTube and Twitch are outputs like any other now, as OUTPUT_1_URL, OUTPUT_1_KEY and so on. See "Where it sends" in the README, and .env.example`,
  );
}

const outputs: OutputSettings[] = [];

// Where it sends, as OUTPUT_1_URL, OUTPUT_1_KEY and so on, numbered however
// suits, in the order of their numbers
const OUTPUT_FIELDS = [
  'NAME',
  'URL',
  'KEY',
  'INPUT',
  'RESOLUTION',
  'BITRATE',
  'PRESET',
];
const numbers = new Set<number>();
for (const name of Object.keys(Bun.env)) {
  const [, number, field] = name.match(/^OUTPUT_(\d+)_(.+)$/) ?? [];
  if (!number || !field) continue;
  // A misspelt field would otherwise be left out without a word
  if (!OUTPUT_FIELDS.includes(field)) {
    fail(`${name} isn't a setting: an output has ${OUTPUT_FIELDS.join(', ')}`);
  }
  numbers.add(Number(number));
}
for (const number of [...numbers].sort((a, b) => a - b)) {
  const prefix = `OUTPUT_${number}_`;
  const get = (field: string) => setting(prefix + field);
  const url = get('URL');
  if (!url) {
    if (OUTPUT_FIELDS.some((field) => get(field))) {
      fail(`Set ${prefix}URL in .env: it says where output ${number} goes`);
    }
    continue;
  }
  const name = get('NAME') ?? `Output ${number}`;
  const rtmpAddress = rtmpUrl(`${prefix}URL`, url);
  const resolution = checkResolution(`${prefix}RESOLUTION`, get('RESOLUTION'));
  const bitrate = checkBitrate(`${prefix}BITRATE`, get('BITRATE'));
  const preset = checkPreset(`${prefix}PRESET`, get('PRESET'));
  const input = get('INPUT') ?? 'landscape';
  if (!INPUT_NAMES.includes(input as InputName)) {
    fail(`${prefix}INPUT should be ${INPUT_NAMES.join(' or ')}, not ${input}`);
  }
  // Left out until it has a key, as a platform in .env.example is that's
  // not been filled in
  const key = get('KEY');
  if (!key) {
    log.info(`⏭️ ${name} has no ${prefix}KEY, so it's left out`);
    continue;
  }
  outputs.push({
    name,
    url: rtmpAddress,
    key,
    input: input as InputName,
    // Re-encoded if any of them is set, at 6000 kb/s and superfast unless said
    encode:
      resolution || bitrate || preset
        ? {
            resolution,
            bitrate: bitrate ?? '6000k',
            preset: preset ?? 'superfast',
          }
        : undefined,
  });
}

if (!outputs.length) {
  fail(
    "Set at least one output's address and key in .env, as OUTPUT_1_URL and OUTPUT_1_KEY: there is nowhere to send the stream",
  );
}
// Each is known by its name, in the logs and the status
for (const { name } of outputs) {
  if (outputs.filter((o) => o.name === name).length > 1) {
    fail(`Two outputs are named ${name}: give each its own OUTPUT_n_NAME`);
  }
}
export const OUTPUTS = outputs;

// MediaMTX, which OBS streams to, and which takes a stream only with
// INBOUND_STREAM_KEY as its password; the relay reads it back from there
export const RTMP_SERVER = setting('RTMP_SERVER') ?? 'rtmp-server';
export const PASS = encodeURIComponent(INBOUND_KEY);
hideInLogs(INBOUND_KEY, PASS, ...OUTPUTS.map((o) => o.key));

// What the dashboard reads to show whether the stream is live
export const STATUS_FILE = setting('STATUS_FILE') ?? '/tmp/relay/status.json';
// How often the status is written while live, at most
export const STATUS_EVERY_MS = 2000;
// How often MediaMTX is asked whether a stream has come in: often enough to
// tell OBS stopping, which sends right up to the end, from its dropping out,
// which goes quiet for seconds before MediaMTX gives up on it; over SRT, its
// buffer, a couple of seconds, keeps coming in first, so as few as 3
export const WAIT_MS = 250;
// How long a platform's FFmpeg waits to start again after failing, doubling
// each time it fails in a row, up to the most; a run that lasted
// STABLE_MS counts as having worked, and starts the wait over
export const RETRY_MIN_MS = 2000;
export const RETRY_MAX_MS = 30_000;
export const STABLE_MS = 60_000;
// How long a platform's FFmpeg can go without sending a frame before it's
// taken as hung and stopped, to be started again. Well over the gap before
// the fallback plays when OBS drops out: MediaMTX's 5 s readTimeout, plus a
// couple of seconds of SRT's buffer.
export const STALL_MS = 30_000;

/** "90s", "5m" or "1h" in milliseconds */
function duration(name: string, value: string) {
  const [, n, unit] = value.match(/^(\d+)(s|m|h)$/) ?? [];
  if (!n || !unit) fail(`${name} should be like 90s, 5m or 1h, not ${value}`);
  return (
    Number(n) * { s: 1000, m: 60_000, h: 3_600_000 }[unit as 's' | 'm' | 'h']
  );
}

// While OBS has dropped out, MediaMTX plays a clip in its place, if
// FALLBACK=true: the platforms keep the stream going, and nobody leaves. It
// ends the stream if OBS doesn't come back within FALLBACK_FOR. OBS stopping
// on purpose ends it at once, fallback or not.
const fallback = setting('FALLBACK') ?? 'false';
if (fallback !== 'true' && fallback !== 'false') {
  fail(`FALLBACK should be true or false, not ${fallback}`);
}
export const FALLBACK = fallback === 'true';
export const FALLBACK_FOR_MS = duration(
  'FALLBACK_FOR',
  setting('FALLBACK_FOR') ?? '5m',
);

// The clips, one for each of OBS's streams, checked here as MediaMTX won't
// start without them, taking RTMP and SRT down too, and turns OBS away,
// without a word, unless OBS sends what the clip is made of; OBS sends
// H.264, and AAC at 48 kHz in stereo, unless told otherwise
const FALLBACK_DIR = setting('FALLBACK_DIR') ?? '/fallback';
function checkClip(name: string, file: string, vertical: boolean) {
  const probe = Bun.spawnSync([
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,sample_rate,channels',
    '-of',
    'json',
    `${FALLBACK_DIR}/${file}`,
  ]);
  if (probe.exitCode !== 0) {
    fail(
      `${name} ${file} isn't a video in ./fallback that can be read (${probe.stderr.toString().trim()}): MediaMTX won't start without it`,
    );
  }
  const { streams = [] } = JSON.parse(probe.stdout.toString()) as {
    streams?: {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      sample_rate?: string;
      channels?: number;
    }[];
  };
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (
    video?.codec_name !== 'h264' ||
    audio?.codec_name !== 'aac' ||
    audio.sample_rate !== '48000' ||
    audio.channels !== 2
  ) {
    fail(
      `${name} ${file} should be H.264 video with AAC audio at 48 kHz in stereo, as OBS sends, or MediaMTX turns OBS away: it's ${video?.codec_name ?? 'no'} video and ${audio ? `${audio.codec_name} audio at ${audio.sample_rate} Hz in ${audio.channels} channels` : 'no audio'}`,
    );
  }
  // Works either way, but looks wrong on the platform
  const { width = 0, height = 0 } = video;
  if (vertical ? width > height : height > width) {
    log.warn(
      `⚠️ ${name} ${file} is ${width}x${height}, where ${vertical ? 'a vertical' : 'a landscape'} clip is wanted`,
    );
  }
}
if (FALLBACK) {
  checkClip(
    'FALLBACK_FILE',
    setting('FALLBACK_FILE') ?? 'be-right-back.mp4',
    false,
  );
  checkClip(
    'FALLBACK_VERTICAL_FILE',
    setting('FALLBACK_VERTICAL_FILE') ?? 'be-right-back-vertical.mp4',
    true,
  );
}
