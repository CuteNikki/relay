import { INBOUND_KEY } from './config';
import type { Input } from './inputs';
import { log } from './log';

// How long to wait for MediaMTX's answer. After a wrong password it holds
// its answer back for up to a few seconds, against guessing, so less than
// that would take a wrong password for MediaMTX not answering at all.
const ANSWER_MS = 5000;
// How long MediaMTX can go unanswering before it's worth saying: just after
// the stack starts, it isn't up yet for a moment, which is nothing
const UNREACHABLE_MS = 10_000;

// What's wrong with asking MediaMTX, if anything, so it's said once when it
// goes wrong and once when it's right again, not every 2 seconds
let problem: string | undefined;
let unreachableSince: number | undefined;

function trouble(level: 'warn' | 'error', text: string) {
  if (problem !== text)
    log[level](`${level === 'error' ? '❌' : '⚠️'} ${text}`);
  problem = text;
}

/**
 * How long nothing had come from OBS before it went, to tell stopping on
 * purpose from dropping out: OBS stopping sends right up to the end, while a
 * connection that's dropped goes quiet, and MediaMTX only gives up on it
 * seconds later: 5, its readTimeout, less over SRT, whose buffer keeps
 * coming in for a couple of seconds after OBS has gone.
 */
export function quietBeforeLeaving(input: Input) {
  return Date.now() - input.inbound.at;
}

/** What's wrong with MediaMTX, if anything, for the status and the health check. */
export function mediamtxProblem() {
  return problem;
}

function fine() {
  if (problem) log.info('✅ MediaMTX answers again');
  problem = undefined;
  unreachableSince = undefined;
}

/** Whether OBS is streaming to MediaMTX, by its API: until it is, there's no such path. */
export async function streamIsIn(input: Input) {
  let res: Response;
  try {
    res = await fetch(input.api, {
      headers: { Authorization: `Basic ${btoa(`relay:${INBOUND_KEY}`)}` },
      signal: AbortSignal.timeout(ANSWER_MS),
    });
  } catch (error) {
    unreachableSince ??= Date.now();
    if (Date.now() - unreachableSince >= UNREACHABLE_MS) {
      trouble('warn', `MediaMTX isn't answering at ${input.api}: ${error}`);
    }
    return false;
  }
  unreachableSince = undefined;

  // No stream, no path
  if (res.status === 404) {
    fine();
    return false;
  }
  if (res.status === 401 || res.status === 403) {
    trouble(
      'error',
      `MediaMTX turned the relay's password away (HTTP ${res.status}): it and the relay should both be started with the same INBOUND_STREAM_KEY, so after changing it in .env, restart both`,
    );
    return false;
  }
  if (!res.ok) {
    trouble('warn', `MediaMTX answered HTTP ${res.status} at ${input.api}`);
    return false;
  }
  try {
    const path = (await res.json()) as {
      online?: boolean;
      inboundBytes?: number;
      /** What inboundBytes was called before */
      bytesReceived?: number;
    };
    fine();
    const online = path.online === true;
    // Counted only while OBS is there: with the fallback, MediaMTX's own clip
    // comes in after it's gone
    const bytes = path.inboundBytes ?? path.bytesReceived ?? 0;
    if (online && bytes !== input.inbound.bytes) {
      input.inbound = { bytes, at: Date.now() };
    }
    return online;
  } catch (error) {
    trouble(
      'warn',
      `MediaMTX answered with something other than JSON: ${error}`,
    );
    return false;
  }
}
