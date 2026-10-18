import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

type Execute = (args: string[], input: undefined, timeoutMs: number) => Promise<string>;

// Only connection-level failures of explicitly read-only commands are replayed.
// Authorization, inventory drift and mutation outcomes remain immediately visible.
export function transientReadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /connection (?:to the server .* was )?refused|connection reset by peer|unexpected EOF|TLS handshake timeout|i\/o timeout|net\/http: request canceled while waiting for connection|signal SIGTERM/i.test(message);
}

export async function runKubectlRead(
  args: string[], execute: Execute,
  clock = () => performance.now(), sleep = (ms: number) => delay(ms),
): Promise<string> {
  if (!(args[0] === 'get' || (args[0] === 'auth' && args[1] === 'can-i')) || args.some(arg => arg === '-w' || /^--(?:watch(?:-only)?|raw)(?:=|$)/.test(arg))) {
    throw new Error('Bounded API retry requires an ordinary read-only kubectl query');
  }
  const deadline = clock() + 8000;
  let failure: unknown;
  for (;;) {
    const remaining = deadline - clock();
    if (remaining <= 0) throw failure || new Error('Read-only Kubernetes API deadline exceeded');
    try {
      return await execute(args, undefined, Math.min(2000, remaining));
    } catch (error) {
      failure = error;
      if (!transientReadFailure(error) || deadline - clock() <= 250) throw error;
      await sleep(250);
    }
  }
}
