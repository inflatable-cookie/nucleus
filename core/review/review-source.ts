import { lstatSync, realpathSync } from 'node:fs';
import type { Run, Task } from '../../shared/contracts';
import { git, queueCheckoutStatus, queueUntrackedFiles } from '../git/index';
import { GitIdentityError, readGitCheckout } from '../git/git-identity';
import { currentBrief } from '../planning/brief';
type WorkspaceIdAccepted = (id: unknown) => boolean;
const workspaceIdPresent: WorkspaceIdAccepted = id => typeof id === "string" && id.length > 0;

/**
 * A stored pinned view is history: no run gets a new one, and the only thing left
 * to do with one is the terminal archive of its checkout. Its own receipt and
 * head are the identity it is proved against, and only a closeout may retire it.
 */
export function assertReviewSourceBinding(task: Task, run: Run, workspaceIdAccepted: WorkspaceIdAccepted = workspaceIdPresent) {
  const view = run.reviewSourceView;
  if (!view) return;
  if (view.provenance === 'review_entry_intake') return assertIntakeReviewSourceBinding(task, run, view, workspaceIdAccepted);
  const receipt = task.resolution.externalOwnerRevisions?.find(receipt=>receipt.at===view.receiptAt&&receipt.operationId===view.receiptOperationId);
  if (run.role !== 'reviewer' || run.taskId !== task.id || view.runId !== run.id || view.workspaceId !== run.workspaceId ||
      !workspaceIdAccepted(view.workspaceId) || view.sourceWorkspaceId !== task.workspaceId || view.sourceDirectory !== task.directory ||
      view.head !== run.head || view.branch !== `ns-review-${run.id}` ||
      !receipt || !receipt.observations || !receipt.canonicalObservations || !receipt.ownerScope || receipt.guarantee !== 'dated_git_head' || receipt.at !== view.receiptAt || receipt.operationId !== view.receiptOperationId ||
      receipt.head !== view.head || receipt.task.id !== task.id || receipt.task.branch !== task.branch || receipt.task.repository !== task.repository ||
      receipt.task.workspaceId !== view.sourceWorkspaceId || receipt.task.directory !== view.sourceDirectory ||
      receipt.brief.digest !== view.briefDigest || receipt.brief.version !== view.briefVersion ||
      !run.released || task.phase !== 'done')
    throw Error('Pinned review source/task/run/receipt/brief binding changed');
}
/**
 * The brief a pinned view was read under. A Queue-held brief is the task's current
 * pinned text; handoff mode records null on both sides. An amended brief therefore
 * refuses the view it was not read under.
 */
function pinnedViewBrief(task:Task){
  const brief=currentBrief(task);
  return brief?{digest:brief.digest??null,version:brief.version??null}
    :{digest:task.reviewEntry?.briefDigest??null,version:task.reviewEntry?.briefVersion??null};
}
/**
 * Spec 017 plain-handover pinned view: the immutable accepted intake record is the
 * authority. It binds this exact run, the original task source identities, the
 * accepted exact head/tree and the brief the handover was checked against. It never
 * backs a new view, and a legacy receipt-kind view never passes
 * here: the two provenances stay separate in both directions.
 */
function assertIntakeReviewSourceBinding(task:Task,run:Run,view:NonNullable<Run['reviewSourceView']>,workspaceIdAccepted: WorkspaceIdAccepted){
  const intake=task.reviewEntry;
  if(!intake)throw Error('Pinned review intake provenance is missing');
  const brief=pinnedViewBrief(task);
  if(run.role!=='reviewer'||run.taskId!==task.id||view.runId!==run.id||view.workspaceId!==run.workspaceId||
    !workspaceIdAccepted(view.workspaceId)||view.intakeOperationId!==intake.operationId||view.receiptOperationId!==null||
    view.sourceWorkspaceId!==task.workspaceId||view.sourceDirectory!==task.directory||
    intake.workspaceId!==view.sourceWorkspaceId||intake.directory!==view.sourceDirectory||
    intake.branch!==task.branch||intake.repository!==task.repository||
    view.head!==run.head||view.branch!==`ns-review-${run.id}`||
    view.briefDigest!==brief.digest||view.briefVersion!==brief.version||
    !run.released||task.phase!=='done')
    throw Error('Pinned review intake/task/run/brief binding changed');
}
/**
 * Exact-head identity of a pinned view from the filesystem. Safe inside a
 * transaction or a stillAllowed send guard. Clean-tree is `verifyReviewSourceView`.
 *
 * `HEAD^{tree}` is not re-read: a matching HEAD SHA is the same immutable
 * commit, so its tree is still `view.tree`.
 */
export function assertReviewSourceIdentity(task: Task, run: Run, primaryArchived?: () => boolean, workspaceIdAccepted: WorkspaceIdAccepted = workspaceIdPresent) {
  const view = run.reviewSourceView;
  if (!view) return;
  assertReviewSourceBinding(task, run, workspaceIdAccepted);
  if (view.state !== 'ready' || !view.directory)
    throw Error('Pinned review view is missing, uncertain or aliases original source');
  let sourcePresent = true;
  try { lstatSync(view.sourceDirectory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !primaryArchived?.()) throw error;
    sourcePresent = false;
  }
  if (sourcePresent) {
    if (realpathSync(view.directory) === realpathSync(view.sourceDirectory))
      throw Error('Pinned review view is missing, uncertain or aliases original source');
    // A preserved source may legitimately advance after the reader released.
    // Only a path that reappears after Queue archived the primary needs to
    // prove that it is still the same checkout before this view can go away.
    if (task.resolution.archivedWorkspaceIds.includes(view.sourceWorkspaceId))
      assertPinnedSourceIdentity(task, view);
  }
  try {
    const viewGit = readGitCheckout(view.directory);
    const repoGit = readGitCheckout(task.repoPath);
    if (viewGit.head !== view.head || viewGit.branch !== view.branch ||
        viewGit.commonDir !== view.commonDir || repoGit.commonDir !== view.commonDir ||
        viewGit.origin !== view.origin || repoGit.origin !== view.origin)
      throw Error('Pinned review view Git identity changed');
  } catch (error) {
    if (error instanceof GitIdentityError) throw Error('Pinned review view Git identity changed');
    throw error;
  }
}

function assertPinnedSourceIdentity(task: Task, view: NonNullable<Run['reviewSourceView']>) {
  try {
    const source = readGitCheckout(view.sourceDirectory);
    if (source.toplevel !== realpathSync(view.sourceDirectory) || source.branch !== task.branch ||
        source.head !== task.prHead || source.commonDir !== view.commonDir || source.origin !== view.origin)
      throw Error('Pinned review original source Git identity changed');
  } catch (error) {
    if (error instanceof GitIdentityError) throw Error('Pinned review original source Git identity changed');
    throw error;
  }
}

/**
 * Build outputs are allowed; tracked files and index must still equal the pinned
 * tree.
 *
 * Identity is filesystem-cheap. The working-tree walk is async git, so it delays
 * this task instead of the executor's other work. Call this before a transaction
 * or as the last await before send; re-check identity cheaply inside the guard.
 */
export async function verifyReviewSourceView(task: Task, run: Run, primaryArchived?: () => boolean, workspaceIdAccepted: WorkspaceIdAccepted = workspaceIdPresent) {
  const view = run.reviewSourceView;
  if (!view) return;
  assertReviewSourceIdentity(task, run, primaryArchived, workspaceIdAccepted);
  if (task.resolution.archivedWorkspaceIds.includes(view.sourceWorkspaceId)) {
    let sourcePresent = true;
    try { lstatSync(view.sourceDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && primaryArchived?.()) sourcePresent = false;
      else throw error;
    }
    if (sourcePresent && await queueCheckoutStatus(view.sourceDirectory, 'status', '--porcelain'))
      throw Error('Pinned review original source Git identity changed');
  }
  if (await queueUntrackedFiles(view.directory!, 'ls-files', '--others', '--exclude-standard'))
    throw Error('Pinned review view has unowned untracked source');
  try { await git(view.directory!, 'diff', '--quiet', view.head, '--'); await git(view.directory!, 'diff', '--cached', '--quiet', view.head, '--'); }
  catch { throw Error('Pinned review view tracked source changed'); }
}

export { externalAuthorModels } from "../../shared/authors";
