import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { STATUS_EVERY_MS, STATUS_FILE, type InputName } from './config';
import { DESTINATIONS } from './destinations';
import { INPUTS, type Input } from './inputs';
import { log } from './log';
import { mediamtxProblem } from './mediamtx';

/** How one platform is doing, each sent to by its own FFmpeg */
export type Output = {
  name: string;
  /** What it gets, e.g. "as it comes in" or "1080p at 6000 kb/s" */
  sends: string;
  /** Which of OBS's streams it gets */
  input: InputName;
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

/** How one of OBS's streams is doing */
export type InputStatus = {
  name: InputName;
  live: boolean;
  /** When it came in, in milliseconds since 1970 */
  since?: number;
  /** What comes in, e.g. "h264, 2560x1440, 60 fps" and "aac, 48000 Hz, stereo" */
  media: { video?: string; audio?: string };
  /**
   * Since when OBS has been gone and the fallback clip has been playing in
   * its place, while it is, in milliseconds since 1970
   */
  fallbackSince?: number;
};

export type Status = {
  // OBS's streams taken together, as when there was only one: the
  // landscape stream's, or the vertical one's when it's the only one live
  /** Whether any is live */
  live: boolean;
  /** When the stream came in, in milliseconds since 1970 */
  since?: number;
  /** What comes in, e.g. "h264, 2560x1440, 60 fps" and "aac, 48000 Hz, stereo" */
  input: { video?: string; audio?: string };
  /**
   * Since when OBS has been gone and the fallback clip has been playing in
   * its place, while it is, in milliseconds since 1970
   */
  fallbackSince?: number;
  /** Each of OBS's streams that some output wants, landscape first */
  inputs: InputStatus[];
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
  /**
   * What's wrong with the relay as a whole, as MediaMTX turning its password
   * away; a platform failing is in its output instead
   */
  problems: string[];
  /** When this was written, so a reader can tell a live one is current */
  updatedAt: number;
};

const inputStatus = (input: Input): InputStatus => ({
  name: input.name,
  live: input.live,
  since: input.since,
  media: input.media,
  fallbackSince: input.fallbackSince,
});

let lastWrite = 0;
// Whether the last write failed, so a status that can't be written is said
// once, and once more when it can again, rather than every 2 seconds
let failing = false;

/** Writes the status whole, through a temporary file, so it's never read half written. */
export function writeStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < STATUS_EVERY_MS) return;
  lastWrite = now;
  const outputs = DESTINATIONS.map((d) => d.out);
  const main = INPUTS.find((i) => i.live) ?? INPUTS[0]!;
  const status: Status = {
    live: main.live,
    since: main.since,
    input: main.media,
    fallbackSince: main.fallbackSince,
    inputs: INPUTS.map(inputStatus),
    ...together(outputs.filter((o) => o.state === 'live')),
    outputs,
    problems: [mediamtxProblem()].filter((p): p is string => !!p),
    updatedAt: now,
  };
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true });
    writeFileSync(`${STATUS_FILE}.tmp`, JSON.stringify(status));
    renameSync(`${STATUS_FILE}.tmp`, STATUS_FILE);
    if (failing)
      log.info(`✅ The status can be written to ${STATUS_FILE} again`);
    failing = false;
  } catch (error) {
    if (!failing) log.warn(`⚠️ Couldn't write the status: ${error}`);
    failing = true;
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
  const kbits = numbers(outputs.map((o) => o.bitrate)).reduce(
    (a, b) => a + b,
    0,
  );
  return {
    fps: fps.length ? Math.min(...fps) : undefined,
    bitrate: `${kbits.toFixed(1)}kbits/s`,
    speed: speeds.length ? `${Math.min(...speeds)}x` : undefined,
    droppedFrames: outputs.reduce((sum, o) => sum + (o.droppedFrames ?? 0), 0),
  };
}
