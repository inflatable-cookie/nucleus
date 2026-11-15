/**
 * Task 405: the source the proof run must observe: the task's own checkout,
 * clean on the task branch, at the exact published head, with the remote branch
 * at the same head. Nothing here creates, checks out or resets source.
 */
import { git } from '../git/index';
import { withFetchLock } from '../git/git-fetch';
import type { Task } from '../../shared/contracts';
import { ProofExecutionRefusal, refuseProof } from './proof-refusal';

export interface ProofSourceProof {
  directory: string; branch: string; head: string; tree: string; remoteHead: string;
}

async function required<T>(label: string, read: Promise<T>): Promise<T> {
  try { return await read; } catch (error) {
    throw new ProofExecutionRefusal('source_unavailable', `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function verifyProofSource(task: Task, expectedHead: string, options: { remote?: boolean } = {}): Promise<ProofSourceProof> {
  const directory = task.directory ?? refuseProof('source_unavailable', 'The proof executor needs the task checkout, and the task records no directory');
  const toplevel = await required('The task checkout', git(directory, 'rev-parse', '--show-toplevel'));
  if (toplevel !== directory) refuseProof('source_unavailable', `The task directory ${directory} is not its own Git root; no proof execution was started`);
  const branch = await required('The task branch', git(directory, 'branch', '--show-current'));
  if (task.proofOnly ? branch !== '' : branch !== task.branch)
    refuseProof('source_branch', task.proofOnly ? `The proof-only executor requires a detached checkout; the source is on ${branch || 'a detached HEAD'}`
      : `The proof executor must run on the task branch ${task.branch}; the checkout is on ${branch || 'a detached HEAD'}`);
  const head = await required('The task head', git(directory, 'rev-parse', 'HEAD'));
  if (head !== expectedHead) refuseProof('source_moved', `The proof executor must observe the exact published head ${expectedHead}; the checkout is at ${head}`);
  const tree = await required('The checked-out tree', git(directory, 'rev-parse', 'HEAD^{tree}'));
  // Build outputs are allowed; tracked source and the index must still equal the pinned tree.
  const tracked = await required('The tracked-source proof', git(directory, 'status', '--porcelain', '--untracked-files=no'));
  if (tracked) refuseProof('source_dirty', `The proof executor requires source identical to the published head; tracked changes are present: ${tracked.split('\n').slice(0, 5).join('; ')}`);
  try { await git(directory, 'diff', '--cached', '--quiet', expectedHead, '--'); }
  catch (error) {
    if ((error as { code?: unknown }).code === 1)
      refuseProof('source_dirty', 'The proof executor requires an index identical to the published head; staged changes are present');
    throw new ProofExecutionRefusal('source_unavailable', `The staged-source proof could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let remoteHead = head;
  if (options.remote !== false && task.proofOnly) {
    // Task 560: the fetch rewrites this checkout's `FETCH_HEAD`, so the read
    // and the ancestry check run in the same critical section as the fetch.
    // Two concurrent verifications otherwise interleave the write with the
    // read and one fails with a spurious source-moved refusal. The section
    // key is the checkout, not the fetch queue's common directory, so the
    // queued fetch inside never waits on this section itself.
    await withFetchLock(`proof-source:${directory}`, async () => {
      await required(`origin/${task.baseBranch}`, git(directory, 'fetch', '--no-tags', 'origin', `refs/heads/${task.baseBranch}`));
      remoteHead = await required(`origin/${task.baseBranch} head`, git(directory, 'rev-parse', 'FETCH_HEAD'));
      try { await git(directory, 'merge-base', '--is-ancestor', expectedHead, 'FETCH_HEAD'); }
      catch { refuseProof('source_moved', `The proof-only commit ${expectedHead} is no longer an ancestor of origin/${task.baseBranch}`); }
    });
  } else if (options.remote !== false) {
    remoteHead = (await required('The remote branch head', git(directory, 'ls-remote', 'origin', `refs/heads/${branch}`))).split(/\s+/)[0] ?? '';
    if (remoteHead !== expectedHead) refuseProof('source_moved', `The published branch ${branch} is at ${remoteHead || 'unknown'}, not the expected head ${expectedHead}; source drifted before the proof executor observed it`);
  }
  return { directory, branch, head, tree, remoteHead };
}
