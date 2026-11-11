/** Durable episode data. This controls timing only; callers must prove a retry is safe. */
export interface GitTransientEpisode {
  startedAt: number;
  attempts: number;
  retryAt: number;
  detail: string;
  source?: string;
}

export const GIT_TRANSIENT_LIMIT_MS = 15 * 60_000;
const INITIAL_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;

/** Keep the original deadline through repeated failures and across restarts. */
export function nextGitTransientAttempt(previous: GitTransientEpisode | null, detail: string, now: number): GitTransientEpisode | null {
  const startedAt = previous?.startedAt ?? now;
  const deadline = startedAt + GIT_TRANSIENT_LIMIT_MS;
  if (now >= deadline) return null;
  const attempts = (previous?.attempts ?? 0) + 1;
  const delay = Math.min(MAX_DELAY_MS, INITIAL_DELAY_MS * 2 ** Math.min(attempts - 1, 10));
  return { startedAt, attempts, retryAt: Math.min(deadline, now + delay), detail };
}
