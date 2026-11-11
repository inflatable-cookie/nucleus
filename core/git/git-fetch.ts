/**
 * Git fetch updates refs in the common Git directory, which linked worktrees
 * share. Serialize Queue fetches for that repository and retry only Git's
 * explicit ref compare-and-swap failure; other errors retain their caller's
 * existing handling.
 */
const FETCH_ATTEMPTS = 3;
const locks = new Map<string, Promise<void>>();

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const value = error as { message?: unknown; stderr?: unknown };
  const stderr = Buffer.isBuffer(value.stderr) ? value.stderr.toString("utf8") : value.stderr;
  return [value.message, stderr].filter(part => typeof part === "string").join("\n");
}

export function isFetchRefContention(error: unknown): boolean {
  return /cannot lock ref ['"]refs\/[^'"]+['"]:\s*is at (?:[a-f0-9]{40}|[a-f0-9]{64}) but expected (?:[a-f0-9]{40}|[a-f0-9]{64})\b/i.test(errorText(error));
}

/**
 * Serialize one critical section by an arbitrary key. The fetch queue below
 * is one user; callers with a read that must not interleave with a rival
 * fetch (for example a fetch followed by its `FETCH_HEAD` read) hold the
 * same shape of section on their own key. Keys must differ from the queued
 * fetch's own common-directory key when the section itself runs a queued
 * fetch, so the section never waits on itself.
 */
export async function withFetchLock<T>(commonGitDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(commonGitDir);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  locks.set(commonGitDir, current);
  await previous?.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(commonGitDir) === current) locks.delete(commonGitDir);
  }
}

/** Serialize by canonical common Git directory; unrelated repositories remain independent. */
export function queueGitFetch<T>(commonGitDir: string, operation: () => Promise<T>): Promise<T> {
  return withFetchLock(commonGitDir, async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!isFetchRefContention(error) || attempt >= FETCH_ATTEMPTS) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 25));
      }
    }
  });
}
