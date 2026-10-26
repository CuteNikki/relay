import { INBOUND_KEY, STREAM_API, WAIT_MS } from './config';

/** Whether OBS is streaming to MediaMTX, by its API: until it is, there's no such path. */
export async function streamIsIn() {
  try {
    const res = await fetch(STREAM_API, {
      headers: { Authorization: `Basic ${btoa(`relay:${INBOUND_KEY}`)}` },
      signal: AbortSignal.timeout(WAIT_MS),
    });
    if (!res.ok) return false;
    return ((await res.json()) as { online?: boolean }).online === true;
  } catch {
    // MediaMTX not up yet, as just after the stack starts
    return false;
  }
}
