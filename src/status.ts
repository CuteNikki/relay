import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { STATUS_EVERY_MS, STATUS_FILE, type InputName } from './config';
import { DESTINATIONS } from './destinations';
import { INPUTS, type Input } from './inputs';
import { log } from './log';
import { mediamtxProblem } from './mediamtx';

/** How one platform is doing */
export type Output = {
  name: string;
  /** e.g. "as it comes in" or "1080p at 6000 kb/s" */
  sends: string;
  input: InputName;
  /** retrying: FFmpeg failed while the stream was still coming in */
  state: 'waiting' | 'connecting' | 'live' | 'retrying';
  since?: number;
  fps?: number;
  /** e.g. "16000.5kbits/s" */
  bitrate?: string;
  /** e.g. "1x": under 1 is falling behind */
  speed?: string;
  droppedFrames?: number;
  /** Restarts during this stream */
  retries: number;
  /** What FFmpeg last complained of when it failed, keys hidden */
  lastError?: string;
};

export type InputStatus = Pick<
  Input,
  'name' | 'live' | 'since' | 'media' | 'fallbackSince'
>;

/**
 * The top-level live, since, input and fallbackSince are the main stream's,
 * the landscape one or else whichever is live, and fps, bitrate, speed and
 * droppedFrames are the live outputs' together. They're from before there was
 * more than one stream, and the dashboard still reads them.
 */
export type Status = {
  live: boolean;
  since?: number;
  input: Input['media'];
  fallbackSince?: number;
  /** Each of OBS's streams that some output wants, landscape first */
  inputs: InputStatus[];
  /** The slowest output's */
  fps?: number;
  /** All outputs' added up */
  bitrate?: string;
  /** The slowest output's */
  speed?: string;
  /** All outputs' added up */
  droppedFrames?: number;
  outputs: Output[];
  /** What's wrong with the relay as a whole; a platform failing is in its output */
  problems: string[];
  /** So a reader can tell a live status is current */
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
// So a status that can't be written is said once, and once more when it can
let failing = false;

/** Writes the status through a temporary file, so it's never read half written. */
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

/** The live outputs together: the slowest one's fps and speed, and the rest added up */
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
