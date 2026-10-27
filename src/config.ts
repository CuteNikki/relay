/** The settings, from .env, checked before anything starts. */

import { hideInLogs, log } from './log';

/** Says what's wrong with the settings and exits. */
function fail(text: string): never {
  log.error(`❌ ${text}`);
  process.exit(1);
}

const inboundKey = Bun.env.INBOUND_STREAM_KEY;
if (!inboundKey) fail('Set INBOUND_STREAM_KEY in .env: OBS streams with it');
export const INBOUND_KEY = inboundKey;

/** OBS's streams: the usual landscape one, and a 9:16 one for Shorts, TikTok and the like */
export const INPUT_NAMES = ['landscape', 'vertical'] as const;
export type InputName = (typeof INPUT_NAMES)[number];

/**
 * Somewhere the stream goes. With `encode`, it's re-encoded with x264, at
 * the size it comes in unless given a resolution.
 */
export type OutputSettings = {
  name: string;
  url: string;
  key: string;
  input: InputName;
  encode?: { resolution?: string; bitrate: string; preset: string };
};

// KEY= in .env counts as unset
const setting = (name: string) => Bun.env[name] || undefined;

function rtmpUrl(name: string, url: string) {
  if (!/^rtmps?:\/\/[^/]+/.test(url)) {
    fail(`${name} should be an rtmp:// or rtmps:// address, not ${url}`);
  }
  return url.replace(/\/+$/, '');
}

// x264's presets, least CPU and worst picture first. superfast is the
// default; OBS uses veryfast
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

// From before YouTube and Twitch were outputs like any other: an old .env
// would otherwise only say there's nowhere to send the stream
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

// Outputs are OUTPUT_<number>_<field>, numbered however suits, taken in order
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
  // Otherwise a misspelt field would be ignored without a word
  if (!OUTPUT_FIELDS.includes(field)) {
    fail(`${name} isn't a setting: an output has ${OUTPUT_FIELDS.join(', ')}`);
  }
  numbers.add(Number(number));
}
for (const number of [...numbers].sort((a, b) => a - b)) {
  const prefix = `OUTPUT_${number}_`;
  const get = (field: string) => setting(prefix + field);
  const check = (
    field: string,
    valid: (value: string) => boolean,
    expected: string,
  ) => {
    const value = get(field);
    if (value && !valid(value)) {
      fail(`${prefix}${field} should be ${expected}, not ${value}`);
    }
    return value;
  };

  const url = get('URL');
  if (!url) {
    if (OUTPUT_FIELDS.some((field) => get(field))) {
      fail(`Set ${prefix}URL in .env: it says where output ${number} goes`);
    }
    continue;
  }
  const name = get('NAME') ?? `Output ${number}`;
  const rtmpAddress = rtmpUrl(`${prefix}URL`, url);
  const resolution = check(
    'RESOLUTION',
    (value) => /^\d+x\d+$/.test(value),
    'like 1920x1080',
  );
  const bitrate = check(
    'BITRATE',
    (value) => /^\d+k$/.test(value),
    'like 6000k',
  );
  const preset = check(
    'PRESET',
    (value) => PRESETS.includes(value),
    `one of ${PRESETS.join(', ')}`,
  );
  const input = (check(
    'INPUT',
    (value) => INPUT_NAMES.includes(value as InputName),
    INPUT_NAMES.join(' or '),
  ) ?? 'landscape') as InputName;
  // .env.example lists platforms without keys: those are skipped
  const key = get('KEY');
  if (!key) {
    log.info(`⏭️ ${name} has no ${prefix}KEY, so it's left out`);
    continue;
  }
  outputs.push({
    name,
    url: rtmpAddress,
    key,
    input,
    // Any encode setting re-encodes, at 6000k and superfast unless given
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
for (const { name } of outputs) {
  if (outputs.filter((o) => o.name === name).length > 1) {
    fail(`Two outputs are named ${name}: give each its own OUTPUT_n_NAME`);
  }
}
export const OUTPUTS = outputs;

// MediaMTX, which OBS streams to. The relay reads the stream back from it,
// with INBOUND_STREAM_KEY as its password too.
export const RTMP_SERVER = setting('RTMP_SERVER') ?? 'rtmp-server';
export const PASS = encodeURIComponent(INBOUND_KEY);
hideInLogs(INBOUND_KEY, PASS, ...OUTPUTS.map((o) => o.key));

// What the dashboard reads
export const STATUS_FILE = setting('STATUS_FILE') ?? '/tmp/relay/status.json';
// At most this often while live
export const STATUS_EVERY_MS = 2000;
// How often MediaMTX is asked about each stream: often enough to tell OBS
// stopping from dropping out (see DROPPED_MS in index.ts)
export const WAIT_MS = 250;
// A failed FFmpeg waits RETRY_MIN_MS to start again, doubling up to
// RETRY_MAX_MS while it keeps failing; a run of STABLE_MS starts it over
export const RETRY_MIN_MS = 2000;
export const RETRY_MAX_MS = 30_000;
export const STABLE_MS = 60_000;
// An FFmpeg that sends no frame for this long is taken as hung. Well over
// the gap before the fallback plays: MediaMTX's 5 s readTimeout, plus a
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

// With FALLBACK=true, MediaMTX plays a clip while OBS has dropped out, for up
// to FALLBACK_FOR. OBS stopping on purpose still ends the stream at once.
const fallback = setting('FALLBACK') ?? 'false';
if (fallback !== 'true' && fallback !== 'false') {
  fail(`FALLBACK should be true or false, not ${fallback}`);
}
export const FALLBACK = fallback === 'true';
export const FALLBACK_FOR_MS = duration(
  'FALLBACK_FOR',
  setting('FALLBACK_FOR') ?? '5m',
);

// The clips are checked here because MediaMTX won't start without them,
// taking RTMP and SRT down too, and turns OBS away without a word unless
// the clip matches what OBS sends: H.264, and AAC at 48 kHz in stereo
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
