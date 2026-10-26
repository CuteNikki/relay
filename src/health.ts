/**
 * Docker's health check: healthy while the relay keeps its status written,
 * which it does every 2 seconds whatever else, and nothing is wrong with it
 * as a whole. It runs on its own, apart from the relay, so it reads its one
 * setting itself rather than through config.ts, which would check all of
 * .env each time.
 */

import { readFileSync } from 'node:fs';

const STATUS_FILE = Bun.env.STATUS_FILE || '/tmp/relay/status.json';
// More than a few missed writes is a relay that's hung
const STALE_MS = 15_000;

function unhealthy(text: string): never {
  console.log(text);
  process.exit(1);
}

let status: { updatedAt: number; problems?: string[] };
try {
  status = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
} catch (error) {
  unhealthy(`Couldn't read the status: ${error}`);
}
const age = Date.now() - status.updatedAt;
if (age > STALE_MS) {
  unhealthy(
    `The status hasn't been written for ${Math.round(age / 1000)} s: the relay has hung`,
  );
}
if (status.problems?.length) unhealthy(status.problems.join('; '));
console.log('Healthy');
