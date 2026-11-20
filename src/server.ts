/**
 * The status over HTTP, for a dashboard on another machine than the relay,
 * which can't read the status file. Only once STATUS_TOKEN is set:
 *
 * - GET / answers 200 while the relay is healthy and 503 when it isn't, by
 *   the same rules as Docker's health check (src/health.ts), and says no
 *   more, for an uptime check that has no token.
 * - GET /status answers the status itself, as the file has it, to a request
 *   with `Authorization: Bearer <STATUS_TOKEN>`.
 */

import { timingSafeEqual } from 'node:crypto';

import { STATUS_PORT, STATUS_TOKEN } from './config';
import { log } from './log';
import { currentStatus } from './status';

// More than a few missed writes is a relay that's hung, as in src/health.ts
const STALE_MS = 15_000;

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Whether a request carries the token, compared in constant time. */
function authorized(request: Request, expected: Buffer) {
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function healthy() {
  const status = currentStatus();
  return (
    !!status &&
    Date.now() - status.updatedAt < STALE_MS &&
    !status.problems.length
  );
}

export function serveStatus() {
  if (!STATUS_TOKEN) return;
  const expected = Buffer.from(`Bearer ${STATUS_TOKEN}`);
  Bun.serve({
    port: STATUS_PORT,
    fetch(request) {
      if (request.method !== 'GET') {
        return new Response(null, { status: 405, headers: { Allow: 'GET' } });
      }
      const { pathname } = new URL(request.url);
      if (pathname === '/') {
        return healthy()
          ? new Response('Healthy', { headers: NO_STORE })
          : new Response('Unhealthy', { status: 503, headers: NO_STORE });
      }
      if (pathname === '/status') {
        if (!authorized(request, expected)) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer' },
          });
        }
        return Response.json(currentStatus() ?? null, { headers: NO_STORE });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  log.info(`📊 Serving the status on port ${STATUS_PORT}`);
}
