import type { HookRecord } from '../../shared/hooks';
import { gitRaw } from '../hooks/hooks';
import { git } from '../git/index';

/**
 * A consumer's own closeout refusal: the hook ran, answered `blocked`, and wrote,
 * committed and pushed nothing. Queue never overrides that finding. It may only
 * ask again once the consumer has changed the inputs the hook owns.
 */
export function isConsumerDeclaredBlock(record: HookRecord): boolean {
  return record.event === 'task.closeout' && record.state === 'blocked' && record.mode === 'integration_write' &&
    record.result?.outcome === 'blocked' && record.result.changedPaths.length === 0 && !record.commit && !record.remote;
}

/**
 * The integration head at which the consumer changed what its blocked closeout hook
 * owns, or null. Evidence is a fast-forward of the remote base branch from the blocked
 * occurrence's base that touches the hook's declared paths or its control manifest.
 * An unrelated advance, a rewrite or an unreadable remote is not evidence.
 */
export async function consumerBlockAdvance(repoPath: string, record: HookRecord, fetch: boolean): Promise<string | null> {
  try {
    if (fetch) await git(repoPath, 'fetch', '--quiet', 'origin', record.baseBranch);
    const head = await git(repoPath, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${record.baseBranch}`);
    if (!head || head === record.baseCommit) return null;
    if ((await gitRaw(repoPath, ['merge-base', '--is-ancestor', record.baseCommit, head])).code !== 0) return null;
    const owned = [...record.allowedPaths, ...(record.manifest ? [record.manifest.path] : [])];
    if (!owned.length) return null;
    const changed = await git(repoPath, 'diff', '--name-only', record.baseCommit, head, '--', ...owned.map(path => `:(literal)${path}`));
    return changed ? head : null;
  } catch { return null; }
}
