import { fail, setting } from './config';
import { log } from './log';

// The clips are checked at startup because MediaMTX won't start without
// them, taking RTMP and SRT down too, and turns OBS away without a word
// unless the clip matches what OBS sends: H.264, and AAC at 48 kHz in stereo
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

/** Stops the relay with what's wrong if either clip won't do. */
export function checkFallbackClips() {
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
