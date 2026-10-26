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
 * Somewhere the stream goes: an RTMP or RTMPS server, the key it takes, and,
 * if it's re-encoded rather than sent as it comes in, at what resolution and
 * bitrate, and with which of x264's presets. Without a resolution, it keeps
 * the size it comes in at.
 */
export type OutputSettings = {
  name: string;
  url: string;
  key: string;
  encode?: { resolution?: string; bitrate: string; preset: string };
};

// An empty setting, as KEY= in .env, is the same as none
const setting = (name: string) => Bun.env[name] || undefined;

function ingest(name: string, url: string) {
  if (!/^rtmps?:\/\/[^/]+/.test(url)) {
    fail(`${name} should be an rtmp:// or rtmps:// address, not ${url}`);
  }
  return url.replace(/\/+$/, '');
}
function resolution(name: string, value?: string) {
  if (value && !/^\d+x\d+$/.test(value)) {
    fail(`${name} should be like 1920x1080, not ${value}`);
  }
  return value;
}
function bitrate(name: string, value?: string) {
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
function preset(name: string, value?: string) {
  if (value && !PRESETS.includes(value)) {
    fail(`${name} should be one of ${PRESETS.join(', ')}, not ${value}`);
  }
  return value;
}

// YouTube and Twitch had settings of their own before they were outputs
// like any other. An .env from then would otherwise only say there's
// nowhere to send the stream, without saying why.
const OLD = [
  'YOUTUBE_STREAM_KEY',
  'YOUTUBE_INGEST',
  'TWITCH_STREAM_KEY',
  'TWITCH_INGEST',
  'TWITCH_RESOLUTION',
  'TWITCH_BITRATE',
].filter((name) => setting(name));
if (OLD.length) {
  fail(
    `${OLD.join(', ')} ${OLD.length > 1 ? 'are' : 'is'} no longer used: YouTube and Twitch are outputs like any other now, as OUTPUT_1_URL, OUTPUT_1_KEY and so on. See "Where it sends" in the README, and .env.example`,
  );
}

const outputs: OutputSettings[] = [];

// Where it sends, as OUTPUT_1_URL, OUTPUT_1_KEY and so on, numbered however
// suits, in the order of their numbers
const PARTS = ['NAME', 'URL', 'KEY', 'RESOLUTION', 'BITRATE', 'PRESET'];
const numbers = new Set<number>();
for (const name of Object.keys(Bun.env)) {
  const [, n, part] = name.match(/^OUTPUT_(\d+)_(.+)$/) ?? [];
  if (!n || !part) continue;
  // A misspelt part would otherwise be left out without a word
  if (!PARTS.includes(part)) {
    fail(`${name} isn't a setting: an output has ${PARTS.join(', ')}`);
  }
  numbers.add(Number(n));
}
for (const n of [...numbers].sort((a, b) => a - b)) {
  const part = (name: string) => setting(`OUTPUT_${n}_${name}`);
  const url = part('URL');
  if (!url) {
    if (PARTS.some(part)) {
      fail(`Set OUTPUT_${n}_URL in .env: it says where output ${n} goes`);
    }
    continue;
  }
  const name = part('NAME') ?? `Output ${n}`;
  const address = ingest(`OUTPUT_${n}_URL`, url);
  const size = resolution(`OUTPUT_${n}_RESOLUTION`, part('RESOLUTION'));
  const rate = bitrate(`OUTPUT_${n}_BITRATE`, part('BITRATE'));
  const speed = preset(`OUTPUT_${n}_PRESET`, part('PRESET'));
  // Left out until it has a key, as a platform in .env.example is that's
  // not been filled in
  const key = part('KEY');
  if (!key) {
    log.info(`⏭️ ${name} has no OUTPUT_${n}_KEY, so it's left out`);
    continue;
  }
  outputs.push({
    name,
    url: address,
    key,
    // Re-encoded if any of them is set, at 6000 kb/s and superfast unless said
    encode:
      size || rate || speed
        ? {
            resolution: size,
            bitrate: rate ?? '6000k',
            preset: speed ?? 'superfast',
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
const RTMP_SERVER = Bun.env.RTMP_SERVER ?? 'rtmp-server';
export const PASS = encodeURIComponent(INBOUND_KEY);
hideInLogs(INBOUND_KEY, PASS, ...OUTPUTS.map((o) => o.key));
export const INPUT_URL = `rtmp://${RTMP_SERVER}:1935/live?user=relay&pass=${PASS}`;
// Its API, which says when a stream has come in
export const STREAM_API = `http://${RTMP_SERVER}:9997/v3/paths/get/live`;

// What the dashboard reads to show whether the stream is live
export const STATUS_FILE = setting('STATUS_FILE') ?? '/tmp/relay/status.json';
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
