import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { INPUT_URL, STALL_MS, STATUS_EVERY_MS } from './config';
import type { Destination } from './destinations';
import { hide, log, logRepeating, type Level } from './log';
import { stream, writeStatus } from './status';

// How much what FFmpeg says matters to the relay. Its errors are warnings
// here, since the relay deals with them by starting it again, and says so;
// what it says as a matter of course, its settings and the like, is debug.
const FFMPEG_LEVELS: Record<string, Level> = {
  panic: 'warn',
  fatal: 'warn',
  error: 'warn',
  warning: 'info',
};

/** "Stream #0:0: Video: h264 (High), yuv420p(…), 2560x1440 [SAR 1:1 DAR 16:9], 16000 kb/s, 60 fps, …" → "h264, 2560x1440, 60 fps" */
function describeVideo(line: string) {
  const codec = line.match(/Video: (\w+)/)?.[1];
  const size = line.match(/\b(\d{2,5}x\d{2,5})\b/)?.[1];
  const fps = line.match(/([\d.]+) fps/)?.[1];
  return [codec, size, fps && `${fps} fps`].filter(Boolean).join(', ');
}

/** "Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp, 160 kb/s" → "aac, 48000 Hz, stereo" */
function describeAudio(line: string) {
  const codec = line.match(/Audio: (\w+)/)?.[1];
  const rate = line.match(/(\d+ Hz)/)?.[1];
  const layout = line.match(/Hz, ([\w.()]+)/)?.[1];
  return [codec, rate, layout].filter(Boolean).join(', ');
}

/** Runs one platform's FFmpeg until it exits, and says how and why. */
export function relay(d: Destination) {
  const { out } = d;
  const plog = log.for(out.name);
  Object.assign(out, {
    state: 'connecting',
    since: undefined,
    fps: undefined,
    bitrate: undefined,
    speed: undefined,
    droppedFrames: undefined,
  });
  writeStatus(true);

  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    // Each line with how much it matters, "[info]", "[error]" and so on,
    // for the relay to log it as that
    '-loglevel',
    'level+info',
    // Its progress as key=value lines on stdout, for the status, in place
    // of the line it would otherwise keep rewriting in the logs
    '-nostats',
    '-progress',
    'pipe:1',
    '-i',
    INPUT_URL,
    ...d.args,
  ]);
  d.ffmpeg = ffmpeg;

  // What it says about the stream: the input's streams come under
  // "Input #0", the outputs' under "Output #…"
  let section: 'input' | 'output' | undefined;
  // What it complained of, for the status and the logs should it fail
  let errors: { at: number; text: string }[] = [];
  let complaint: string | undefined;
  createInterface({ input: ffmpeg.stderr! }).on('line', (line) => {
    // "[out#0/flv @ 0x…] [fatal] Error opening output …": who said it, if
    // anyone in particular, how much it matters, and what
    const [, who = '', level = 'info', text = line] =
      line.match(/^(\[[^\]]+ @ [^\]]+\] )?\[(\w+)\] (.*)$/) ?? [];
    logRepeating(plog, FFMPEG_LEVELS[level] ?? 'debug', `${who}${text}`);
    if (/^Input #0/.test(text)) {
      section = 'input';
    } else if (/^Output #/.test(text)) {
      section = 'output';
    } else if (section === 'input' && /Stream #.*: Video:/.test(text)) {
      stream.input.video = describeVideo(text);
    } else if (section === 'input' && /Stream #.*: Audio:/.test(text)) {
      stream.input.audio = describeAudio(text);
    }
    if (level === 'error' || level === 'fatal' || level === 'panic') {
      errors = [...errors.slice(-19), { at: Date.now(), text: text.trim() }];
    }
  });

  // FFmpeg not there to start, or no room to start it: 'close' comes after
  ffmpeg.on('error', (error) => {
    complaint = `FFmpeg couldn't be started: ${error.message}`;
    plog.error(`❌ ${complaint}`);
  });

  // FFmpeg's own fps, bitrate and speed are averages since it started, which
  // hide a drop an hour in, so they're worked out here instead, from what
  // was sent since the last sample, taken every couple of seconds: frames,
  // bytes, and how far into the stream it got
  let frames = 0;
  let bytes = 0;
  let outTimeUs = 0;
  let sample:
    | { frames: number; bytes: number; outTimeUs: number; at: number }
    | undefined;

  // Its progress, a block of key=value lines ending in "progress=…". The
  // first comes once it's connected to the platform and sending. Before
  // then, sizes and times can be N/A, which are kept as they were.
  const number = (value = '', was: number) =>
    Number.isFinite(Number(value)) ? Number(value) : was;
  createInterface({ input: ffmpeg.stdout! }).on('line', (line) => {
    const [key, value] = line.split('=', 2).map((s) => s.trim());
    if (key === 'frame') frames = number(value, frames);
    else if (key === 'total_size') bytes = number(value, bytes);
    else if (key === 'out_time_us') outTimeUs = number(value, outTimeUs);
    else if (key === 'drop_frames') out.droppedFrames = Number(value);
    else if (key === 'progress') {
      const now = { frames, bytes, outTimeUs, at: Date.now() };
      if (!sample) sample = now;
      else if (now.at - sample.at >= STATUS_EVERY_MS) {
        const seconds = (now.at - sample.at) / 1000;
        const round = (n: number) => Math.round(n * 100) / 100;
        out.fps = round((now.frames - sample.frames) / seconds);
        // As FFmpeg puts them, e.g. "6000.5kbits/s" and "1x"
        const kbits = ((now.bytes - sample.bytes) * 8) / 1000 / seconds;
        out.bitrate = `${kbits.toFixed(1)}kbits/s`;
        const streamed = (now.outTimeUs - sample.outTimeUs) / 1e6;
        out.speed = `${round(streamed / seconds)}x`;
        sample = now;
      }
      if (out.state === 'connecting') {
        out.state = 'live';
        out.since = Date.now();
        delete out.lastError;
        plog.info('✅ Sending');
        writeStatus(true);
      } else writeStatus();
    }
  });

  // FFmpeg can hang rather than exit when a platform goes away (8.1 sent
  // nothing for minutes on end when Twitch's server did), so one that sends
  // no new frame for STALL_MS, connecting or not, is stopped, and send()
  // starts it again
  let lastFrame = { frames: 0, at: Date.now() };
  const watchdog = setInterval(() => {
    if (frames > lastFrame.frames) lastFrame = { frames, at: Date.now() };
    else if (Date.now() - lastFrame.at > STALL_MS) {
      complaint = `Sent no frames for ${STALL_MS / 1000} s`;
      plog.warn(`⏱️ ${complaint}, stopping its FFmpeg`);
      ffmpeg.kill('SIGKILL');
      clearInterval(watchdog);
    }
  }, 1000);

  /** How it exited, e.g. "code 1" or "signal SIGKILL", and why, if it said */
  return new Promise<{ how: string; why?: string }>((resolve) => {
    ffmpeg.on('close', (code, signal) => {
      clearInterval(watchdog);
      const how = signal ? `signal ${signal}` : `code ${code}`;
      // The first error of the last few seconds before it exited, which says
      // why, where the last says only that it gave up: "Connection refused"
      // rather than "Error opening output files"
      const last = errors.at(-1)?.at ?? 0;
      const said = errors.find((e) => e.at >= last - 5000)?.text;
      const why = complaint ?? said;
      plog.debug(`FFmpeg exited with ${how}`);
      if (code !== 0 && why) out.lastError = hide(why);
      d.ffmpeg = undefined;
      resolve({ how, why: why && hide(why) });
    });
  });
}
