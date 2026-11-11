import { GitTransientError } from '../forge/forge-health';
import { setTimeout as delay } from 'node:timers/promises';
import { isSshAuthenticationFailure, SSH_AUTH_EXHAUSTED } from '../../shared/ssh-auth';

export const SSH_AUTH_ATTEMPTS = 3;
export class SshAuthExhaustedError extends GitTransientError {
  constructor(readonly original: unknown) {
    super('ssh', original);
    this.message = `${SSH_AUTH_EXHAUSTED} after ${SSH_AUTH_ATTEMPTS} attempts: ${original instanceof Error ? original.message : String(original)}`;
  }
}

/** Retry only definite authentication rejection. Never retry unknown push delivery or local Git mutations. */
export async function retryGitSshAuthentication<T>(args: string[], run: () => Promise<T>, wait: (ms: number) => Promise<unknown> = delay): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); }
    catch (error) {
      const failure = error as { code?: unknown; stderr?: unknown; stdout?: unknown; signal?: unknown; killed?: boolean };
      const retryable = ['fetch', 'push', 'ls-remote'].includes(args[0]) && failure?.code === 128 &&
        !failure.signal && !failure.killed && isSshAuthenticationFailure(String(failure.stderr ?? '')) &&
        // Any stdout from a failed push may be a ref result; preserve delivery uncertainty.
        (args[0] !== 'push' || !String(failure.stdout ?? '').trim() &&
          !/(?:^|\n)(?:To |Everything up-to-date|Enumerating objects:|Counting objects:|Writing objects:|Total \d)| -> |\[(?:new branch|deleted)\]/m.test(String(failure.stderr ?? '')));
      if (!retryable) throw error;
      if (attempt === SSH_AUTH_ATTEMPTS) throw new SshAuthExhaustedError(error);
      await wait(attempt === 1 ? 2000 : 5000);
    }
  }
}
