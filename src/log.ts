/**
 * The logs: each line with when it was said, how much it matters and which
 * platform it's about, if one, and the stream keys hidden. It reads LOG_LEVEL
 * itself, rather than through config.ts, so config.ts can use it to say
 * what's wrong with the settings.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type Level = keyof typeof LEVELS;

// What's quieter than LOG_LEVEL isn't printed: "debug" adds everything
// FFmpeg says, "warn" and "error" leave only what's gone wrong
const asked = (Bun.env.LOG_LEVEL || 'info').toLowerCase();
const least = asked in LEVELS ? LEVELS[asked as Level] : LEVELS.info;

// FFmpeg names its input and outputs by their full URL, keys and all, so
// they're hidden in everything printed, since the logs are shown elsewhere
const secrets: string[] = [];
export function hideInLogs(...keys: (string | undefined)[]) {
  secrets.push(...keys.filter((key): key is string => !!key));
}
export function hide(text: string) {
  return secrets.reduce((out, key) => out.replaceAll(key, '***'), text);
}

/** "2026-10-26T14:30:00.123Z WARN  [Twitch] 🔁 Failed (…)" */
function write(level: Level, platform: string | undefined, text: string) {
  if (LEVELS[level] < least) return;
  const about = platform ? `[${platform}] ` : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${about}${hide(text.trimEnd())}\n`;
  (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(line);
}

export type Logger = Record<Level, (text: string) => void> & {
  platform?: string;
};

function logger(platform?: string): Logger {
  return {
    platform,
    debug: (text) => write('debug', platform, text),
    info: (text) => write('info', platform, text),
    warn: (text) => write('warn', platform, text),
    error: (text) => write('error', platform, text),
  };
}

export const log = {
  ...logger(),
  /** For what's about one platform: log.for('Twitch').warn(…) */
  for: logger,
};

if (!(asked in LEVELS)) {
  log.warn(
    `⚠️ LOG_LEVEL should be debug, info, warn or error, not ${asked}: going by info`,
  );
}

// FFmpeg can say the same thing with every frame, for hours, so a line it
// has said in the last REPEAT_MS is counted rather than printed, and the
// count printed once it's been quiet that long
const REPEAT_MS = 60_000;
const repeats = new Map<
  string,
  { logger: Logger; level: Level; text: string; at: number; more: number }
>();

function sayRepeats(key: string) {
  const r = repeats.get(key);
  if (r?.more) r.logger[r.level](`${r.text} (${r.more} more times since)`);
  repeats.delete(key);
}

/** For what FFmpeg says, which it can say over and over. */
export function logRepeating(logger: Logger, level: Level, text: string) {
  const key = `${logger.platform ?? ''} ${text}`;
  const r = repeats.get(key);
  if (r && Date.now() - r.at < REPEAT_MS) {
    r.more++;
    return;
  }
  if (r) sayRepeats(key);
  logger[level](text);
  repeats.set(key, { logger, level, text, at: Date.now(), more: 0 });
}

setInterval(() => {
  for (const [key, r] of repeats) {
    if (Date.now() - r.at >= REPEAT_MS) sayRepeats(key);
  }
}, 10_000).unref();
