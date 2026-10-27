import type { ChildProcess } from 'node:child_process';

import { OUTPUTS, type OutputSettings } from './config';
import { inputFor } from './inputs';
import type { Output } from './status';

/**
 * What it gets, as people say it: "as it comes in", "1080p at 6000 kb/s" or
 * "at 6000 kb/s", and the preset if it's not the usual superfast, as
 * "1080p at 6000 kb/s, veryfast"
 */
function describe({ encode }: OutputSettings) {
  if (!encode) return 'as it comes in';
  const rate = encode.bitrate.replace(/k$/, ' kb/s');
  const what = encode.resolution
    ? `${encode.resolution.split('x')[1]}p at ${rate}`
    : `at ${rate}`;
  return encode.preset === 'superfast' ? what : `${what}, ${encode.preset}`;
}

/**
 * FFmpeg's arguments to send the stream to one output: copied untouched,
 * which costs almost no CPU, or re-encoded at its resolution and bitrate,
 * with its preset.
 */
function args({ url, key, encode }: OutputSettings) {
  const as = encode
    ? [
        '-c:v',
        'libx264',
        '-preset',
        encode.preset,
        // A keyframe every 2 seconds, as Twitch and most others ask,
        // whatever the frame rate: a fixed -g 120 was 2 s at 60 fps but 4 s
        // at 30. Scene cuts add none of their own, so they stay evenly
        // spaced.
        '-force_key_frames',
        'expr:gte(t,n_forced*2)',
        '-sc_threshold',
        '0',
        '-b:v',
        encode.bitrate,
        '-maxrate',
        encode.bitrate,
        // Twice the bitrate, in the same unit
        '-bufsize',
        `${Number(encode.bitrate.slice(0, -1)) * 2}k`,
        ...(encode.resolution ? ['-s', encode.resolution] : []),
        '-c:a',
        'aac',
        '-b:a',
        '128k',
      ]
    : ['-c:v', 'copy', '-c:a', 'copy'];
  return [
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    ...as,
    '-flvflags',
    'no_duration_filesize',
    '-f',
    'flv',
    `${url}/${key}`,
  ];
}

/** Where the stream goes, each with which of OBS's streams it reads and its FFmpeg's arguments, in order. */
export const DESTINATIONS = OUTPUTS.map((output) => ({
  input: inputFor(output.input),
  args: args(output),
  out: idle({
    name: output.name,
    sends: describe(output),
    input: output.input,
  }),
  ffmpeg: undefined as ChildProcess | undefined,
  /** Whether send() is looking after it, so it's never started twice */
  running: false,
}));
export type Destination = (typeof DESTINATIONS)[number];

/** An output waiting for a stream, as it was before it was sent one */
export function idle({
  name,
  sends,
  input,
}: Pick<Output, 'name' | 'sends' | 'input'>): Output {
  return { name, sends, input, state: 'waiting', retries: 0 };
}
