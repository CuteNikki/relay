import {
  INPUT_NAMES,
  OUTPUTS,
  PASS,
  RTMP_SERVER,
  type InputName,
} from './config';
import { log, type Logger } from './log';

/**
 * One of the streams OBS sends, as MediaMTX has it: whether it's coming in,
 * since when, and what it is. Each comes and goes on its own, so a vertical
 * stream can start after the landscape one, or not at all.
 */
export type Input = {
  name: InputName;
  /** How it's called in the logs and the status: "Landscape", "Vertical" */
  label: string;
  /** Its path in MediaMTX, which OBS streams to: "live", "vertical" */
  path: string;
  /** Where FFmpeg reads it back from */
  url: string;
  /** MediaMTX's API for it, which says when it's come in */
  api: string;
  log: Logger;
  live: boolean;
  /** When it came in, in milliseconds since 1970 */
  since?: number;
  /** What comes in, e.g. "h264, 2560x1440, 60 fps" and "aac, 48000 Hz, stereo" */
  media: { video?: string; audio?: string };
  /** Since when OBS has been gone and the fallback clip has played in its place */
  fallbackSince?: number;
  /**
   * When OBS last sent anything, by the bytes MediaMTX says it's had, to
   * tell OBS stopping from its dropping out
   */
  inbound: { bytes: number; at: number };
};

// The landscape stream keeps the path OBS has always streamed to, so its
// stream key stays as it was
const PATHS: Record<InputName, string> = {
  landscape: 'live',
  vertical: 'vertical',
};
const LABELS: Record<InputName, string> = {
  landscape: 'Landscape',
  vertical: 'Vertical',
};

/** Only the streams some output wants: with no vertical output, there's no need to watch for one */
const names = INPUT_NAMES.filter((name) =>
  OUTPUTS.some((o) => o.input === name),
);

export const INPUTS: Input[] = names.map((name) => {
  const path = PATHS[name];
  return {
    name,
    label: LABELS[name],
    path,
    url: `rtmp://${RTMP_SERVER}:1935/${path}?user=relay&pass=${PASS}`,
    api: `http://${RTMP_SERVER}:9997/v3/paths/get/${path}`,
    // Which stream a line is about, but only once there's more than one
    log: names.length > 1 ? log.for(LABELS[name]) : log,
    live: false,
    media: {},
    inbound: { bytes: -1, at: 0 },
  };
});

export function inputFor(name: InputName) {
  return INPUTS.find((i) => i.name === name)!;
}

/** Back to waiting for OBS, as when it's not streaming */
export function reset(input: Input) {
  input.live = false;
  input.since = undefined;
  input.fallbackSince = undefined;
  input.media = {};
}
