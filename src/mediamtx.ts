import { INBOUND_KEY, STREAM_API } from './config';
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
export async function streamIsIn() {
  let res: Response;
  try {
    res = await fetch(STREAM_API, {
      headers: { Authorization: `Basic ${btoa(`relay:${INBOUND_KEY}`)}` },
      signal: AbortSignal.timeout(ANSWER_MS),
    });
  } catch (error) {
    unreachableSince ??= Date.now();
    if (Date.now() - unreachableSince >= UNREACHABLE_MS) {
      trouble('warn', `MediaMTX isn't answering at ${STREAM_API}: ${error}`);
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
    trouble('warn', `MediaMTX answered HTTP ${res.status} at ${STREAM_API}`);
    return false;
  }
  try {
    const online = ((await res.json()) as { online?: boolean }).online === true;
    fine();
    return online;
  } catch (error) {
    trouble(
      'warn',
      `MediaMTX answered with something other than JSON: ${error}`,
    );
    return false;
  }
}
