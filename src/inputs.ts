import {
  INPUT_NAMES,
  OUTPUTS,
  PASS,
  RTMP_SERVER,
  type InputName,
} from './config';
import { log, type Logger } from './log';

/** One of OBS's streams, as MediaMTX has it. Each comes and goes on its own. */
export type Input = {
  name: InputName;
  /** "Landscape" or "Vertical", in the logs */
  label: string;
  /** Its path in MediaMTX, which OBS streams to */
  path: string;
  /** Where FFmpeg reads it from */
  url: string;
  /** MediaMTX's API for the path */
  api: string;
  log: Logger;
  live: boolean;
  since?: number;
  /** e.g. "h264, 2560x1440, 60 fps" and "aac, 48000 Hz, stereo" */
  media: { video?: string; audio?: string };
  /** Since when the fallback clip has played in OBS's place */
  fallbackSince?: number;
  /** When MediaMTX last had a byte from OBS, to tell stopping from dropping out */
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

// Only the streams some output wants
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
    // Says which stream a line is about once there's more than one
    log: names.length > 1 ? log.for(LABELS[name]) : log,
    live: false,
    media: {},
    inbound: { bytes: -1, at: 0 },
  };
});

export function inputFor(name: InputName) {
  return INPUTS.find((i) => i.name === name)!;
}

/** Back to waiting for OBS */
export function reset(input: Input) {
  input.live = false;
  input.since = undefined;
  input.fallbackSince = undefined;
  input.media = {};
}
