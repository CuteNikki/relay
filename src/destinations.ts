import type { ChildProcess } from 'node:child_process';

import { OUTPUTS, type OutputSettings } from './config';
import { inputFor } from './inputs';
import type { Output } from './status';

/** "as it comes in", "1080p at 6000 kb/s", or "at 6000 kb/s, veryfast" when it isn't superfast */
function describe({ encode }: OutputSettings) {
  if (!encode) return 'as it comes in';
  const rate = encode.bitrate.replace(/k$/, ' kb/s');
  const what = encode.resolution
    ? `${encode.resolution.split('x')[1]}p at ${rate}`
    : `at ${rate}`;
  return encode.preset === 'superfast' ? what : `${what}, ${encode.preset}`;
}

/** FFmpeg's output arguments: copied as it comes in, at almost no CPU, or re-encoded. */
function args({ url, key, encode }: OutputSettings) {
  const codecs = encode
    ? [
        '-c:v',
        'libx264',
        '-preset',
        encode.preset,
        // A keyframe every 2 s, as Twitch and most others ask, whatever the
        // frame rate, and none extra on scene cuts
        '-force_key_frames',
        'expr:gte(t,n_forced*2)',
        '-sc_threshold',
        '0',
        '-b:v',
        encode.bitrate,
        '-maxrate',
        encode.bitrate,
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
    ...codecs,
    '-flvflags',
    'no_duration_filesize',
    '-f',
    'flv',
    `${url}/${key}`,
  ];
}

/** Where the stream goes, in order */
export const DESTINATIONS = OUTPUTS.map((output) => ({
  input: inputFor(output.input),
  args: args(output),
  out: idle({
    name: output.name,
    sends: describe(output),
    input: output.input,
  }),
  ffmpeg: undefined as ChildProcess | undefined,
  /** Whether send() has it, so it's never started twice */
  running: false,
}));
export type Destination = (typeof DESTINATIONS)[number];

/** An output waiting for a stream */
export function idle({
  name,
  sends,
  input,
}: Pick<Output, 'name' | 'sends' | 'input'>): Output {
  return { name, sends, input, state: 'waiting', retries: 0 };
}
