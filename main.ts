// main.ts — boot the forge and stay up until the trial harness says stop.
//
// The harness reaches this process through the environment: it publishes
// its own control address as MAKEFUN_ENV_URL, and the bearer token the
// suite presents arrives as MAKEFUN_SHOP_TOKEN (app.ts reads that one).
// The exchange is short: bind a port the kernel picks, tell the harness
// which one it is, then keep asking "are we finished yet?" until the
// answer turns to yes, and only then shut the forge down and leave with
// a zero status.
//
// Nothing here talks to any service but the harness, and nothing here
// keeps state of its own: every request the suite makes is answered by
// the server app.ts builds.

import { createApp as buildForge } from './app.ts';
import type { AddressInfo } from 'node:net';

// How long a single control request may run before it counts as failed.
const REQUEST_BUDGET_MS = 30_000;
// How long to rest after the first failed "done" check; the rest doubles
// after each failure, up to the ceiling below.
const FIRST_REST_MS = 250;
const LONGEST_REST_MS = 30_000;
// If the server has still not closed a few seconds after we asked it to,
// leave anyway: the trial is over and a lingering socket must not hold us.
const SHUTDOWN_GRACE_MS = 5_000;

/** Rest for `ms` milliseconds. */
function rest(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The harness origin, or nothing when the variable was never set. */
function harnessOrigin(): string | undefined {
  const origin = process.env.MAKEFUN_ENV_URL;
  return origin === '' ? undefined : origin;
}

/** Ask the harness whether the trial has finished; false on any hiccup. */
async function trialFinished(origin: string): Promise<boolean> {
  let reply: Response;
  try {
    reply = await fetch(`${origin}/done`, {
      signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
    });
  } catch {
    return false;
  }
  if (!reply.ok) return false;
  let payload: unknown;
  try {
    payload = await reply.json();
  } catch {
    return false;
  }
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { done?: unknown }).done === true
  );
}

/** Tell the harness which port the forge is listening on. */
async function announcePort(origin: string, port: number): Promise<void> {
  const reply = await fetch(`${origin}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
  });
  if (!reply.ok) {
    // A refused registration means the suite can never reach the forge,
    // so waiting for "done" afterwards would only burn the wall budget.
    throw new Error(`harness refused the port announcement: HTTP ${reply.status}`);
  }
}

/** Keep asking until the harness reports done, resting longer each time. */
async function waitUntilDone(origin: string): Promise<void> {
  let restMs = FIRST_REST_MS;
  for (;;) {
    if (await trialFinished(origin)) return;
    await rest(restMs);
    restMs = Math.min(restMs * 2, LONGEST_REST_MS);
  }
}

async function main(): Promise<void> {
  const origin = harnessOrigin();
  if (origin === undefined) {
    process.stderr.write('MAKEFUN_ENV_URL is not set; cannot find the harness.\n');
    process.exit(1);
  }

  const forge = buildForge();
  forge.on('error', (err: Error) => {
    process.stderr.write(`forge failed to start: ${err.message}\n`);
    process.exit(1);
  });

  // Port 0 asks the kernel for a free ephemeral port; 8080 belongs to the
  // harness and must never be taken, so it is never named here.
  await new Promise<void>((resolve) => {
    forge.listen(0, () => resolve());
  });
  const bound = forge.address() as AddressInfo | string | null;
  const port = typeof bound === 'object' && bound !== null ? bound.port : 0;

  await announcePort(origin, port);
  await waitUntilDone(origin);

  forge.close(() => process.exit(0));
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}

await main();
