import { spawn } from 'child_process';

const INBOUND_KEY = Bun.env.INBOUND_STREAM_KEY;
const TWITCH_KEY = Bun.env.TWITCH_STREAM_KEY;
const YT_KEY = Bun.env.YOUTUBE_STREAM_KEY;

if (!INBOUND_KEY || !TWITCH_KEY || !YT_KEY) {
  console.error('❌ Missing stream keys in .env file!');
  process.exit(1);
}

const INPUT_URL = `rtmp://0.0.0.0:1936/live/${INBOUND_KEY}`;
const TWITCH_URL = `rtmp://live.twitch.tv/app/${TWITCH_KEY}`;
const YT_URL = `rtmp://a.rtmp.youtube.com/live2/${YT_KEY}`;

console.log('📡 Bun Relay Listening securely on Port 1936...');

const ffmpeg = spawn('ffmpeg', [
  '-listen',
  '1',
  '-i',
  INPUT_URL,

  // -------------------------------------------------------------------------
  // OUTPUT 1: YOUTUBE STREAM (Pure 1440p Passthrough Copy - FIRST)
  // -------------------------------------------------------------------------
  '-map',
  '0:v:0',
  '-map',
  '0:a:0',
  '-c:v',
  'copy', // Take the raw 16000 Kbps 1440p stream...
  '-c:a',
  'copy', // ...and pristine audio packets directly.
  '-flvflags',
  'no_duration_filesize',
  '-f',
  'flv',
  YT_URL, // Push straight out to YouTube first.

  // -------------------------------------------------------------------------
  // OUTPUT 2: TWITCH STREAM (Downscaled 1080p @ 6000k - SECOND)
  // -------------------------------------------------------------------------
  '-map',
  '0:v:0',
  '-map',
  '0:a:0',
  '-c:v',
  'libx264', // Branch off a separate encoder instance.
  '-preset',
  'superfast',
  '-g',
  '120',
  '-b:v',
  '6000k',
  '-maxrate',
  '6000k',
  '-bufsize',
  '12000k',
  '-s',
  '1920x1080', // Compress and downscale this track alone.
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-flvflags',
  'no_duration_filesize',
  '-f',
  'flv',
  TWITCH_URL,
]);

ffmpeg.stderr.on('data', (data) => {
  process.stdout.write(data.toString());
});

ffmpeg.on('close', (code) => console.log(`\n❌ FFmpeg exited with code ${code}`));

process.on('SIGINT', () => {
  console.log('🛑 Stopping relay, killing FFmpeg...');
  ffmpeg.kill('SIGINT');
  process.exit(0);
});
