// main.ts — the entrypoint the harness runs.
//
// The harness starts this process, hands it an env to talk to through
// MAKEFUN_ENV_URL, and scores the forge the server in app.ts serves. This
// file owns only the handshake between the two: bind a port, tell the env
// where to find this process, then stay up until the env says the trial is
// over. It never touches the forge itself — every request the suite makes
// goes to the server createApp() builds.
//
// The order is the harness's, not ours:
//   1. Read MAKEFUN_ENV_URL. Without it there is no env, so exit at once.
//   2. Bind an ephemeral port with listen(0). Never 8080 — the env owns it.
//   3. POST { port } to $MAKEFUN_ENV_URL/register. The env dials this
//      process at the address the request came from plus that port. The
//      first register wins; a 409 means another entry already registered,
//      and this process simply waits like any other.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//      A failed or slow poll is retried; the process never exits early.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.

import { createApp } from './app.ts';

// The env's origin, without a trailing slash; empty when unset.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may run before it is dropped. */
const HTTP_DEADLINE_MS = 30_000;
/** First pause between retries, and the longest pause. */
const BACKOFF_START_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `failures` failed attempts: exponential, capped at the limit. */
function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

/**
 * POST this process's port to the env until it is accepted. A 400 or 405 is
 * a contract error and stops the program; 200 is the normal answer and 409
 * means an earlier register already won, which is not this process's to
 * fix — either way the port is announced. Anything else (a network error,
 * another status) is retried, since the env may still be starting.
 */
async function announcePort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(HTTP_DEADLINE_MS),
      });
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
      if (res.status === 200 || res.status === 409) return;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoffDelay(failures));
  }
}

/**
 * GET /done until it answers {"done": true}; never return before that. A
 * non-OK answer is not done either — it just means the suite is still
 * running — so only a body that says done ends the wait.
 */
async function awaitTrialEnd(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(HTTP_DEADLINE_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not
      // done, so poll again.
    }
    await sleep(backoffDelay(failures));
  }
}

/** Bind, announce, then wait for the env: the whole life of the process. */
async function runEntry(): Promise<void> {
  const server = createApp();
  const bound = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  await bound;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] bound to port ${address.port}\n`);

  await announcePort(address.port);
  process.stdout.write('[entry] announced; waiting for the env to say done\n');

  await awaitTrialEnd();
  server.close();
  process.stdout.write('[entry] trial done\n');
}

runEntry().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
