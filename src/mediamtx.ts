import { INBOUND_KEY } from './config';
import type { Input } from './inputs';
import { log } from './log';

// MediaMTX holds back its answer to a wrong password for a few seconds, so a
// shorter timeout would take that for MediaMTX not answering at all
const ANSWER_MS = 5000;
// Just after the stack starts, MediaMTX isn't up yet for a moment
const UNREACHABLE_MS = 10_000;

// Said once when it goes wrong and once when it's right again, not on
// every look
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

/** Whether OBS is streaming to MediaMTX: until it is, the path doesn't exist. */
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
      /** inboundBytes in older MediaMTX */
      bytesReceived?: number;
    };
    fine();
    const online = path.online === true;
    // Only while OBS is there: with the fallback, MediaMTX's own clip comes
    // in after it's gone
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
