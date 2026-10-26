import type { ChildProcess } from 'node:child_process';

import {
  TWITCH_BITRATE,
  TWITCH_INGEST,
  TWITCH_KEY,
  TWITCH_RESOLUTION,
  YT_INGEST,
  YT_KEY,
} from './config';
import type { Output } from './status';

/** Twitch's bitrate as people say it: "6000k" → "6000 kb/s" */
const twitchSends = `${TWITCH_RESOLUTION.split('x')[1]}p at ${TWITCH_BITRATE.replace(/k$/, ' kb/s')}`;

/**
 * Where the stream goes, and FFmpeg's arguments for each: YouTube gets it as
 * it comes in, copied untouched, first; Twitch a copy scaled down and
 * re-encoded, as it takes less.
 */
export const DESTINATIONS = [
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
export type Destination = (typeof DESTINATIONS)[number];

export function idle(name: string, sends: string): Output {
  return { name, sends, state: 'waiting', retries: 0 };
}
