/**
 * Spec 058 (task 539/540): when a source approval waits on a named proof, and
 * whether the brief's own declared selector may run for it without a question.
 * This is the policy; `ProofAutorun` is the one actor that applies it.
 */
import { gitHash, gitNulEach } from '../git/git-command';
import type { Store } from '../store/store';
import {
  awaitingProofRoute, awaitingProofText, awaitingProofTexts,
  type AwaitingProof, type Run, type Task,
} from '../../shared/contracts';
import { proofHeadAdmission } from './proof-admission';
import { proofExecutions } from './proof-records';

/** Awaiting-proof text can be prose; a task's one declared selector remains its proof identity. */
export function declaredProofSelectors(task: Task): string[] {
  const selector = task.proofExecution?.selector.trim();
  return selector ? [selector] : [];
}

export function awaitingProofMatchesSelector(awaitingProof: string | AwaitingProof, selector: string, declaredSelectors: string[]): boolean {
  const text = awaitingProofText(awaitingProof).trim();
  if (selector === text) return true;
  return selector === declaredSelectors[0] && (text.includes(selector) || declaredSelectors.length === 1);
}

/**
 * A source approval waits on its named proofs until the operator accepts that exact head: the
 * recorded acceptance stands in for the proofs (a post-merge proof cannot exist before the merge
 * it would gate; Queue #520). The reviewer's record is untouched.
 */
export function proofWaitApplies(t: Task): boolean {
  // A verified merge ends the proof wait: post-merge proofs cannot exist before
  // the merge they would gate, and closeout uses the merge commit (Queue #673).
  if (t.resolution.mergedCommit) return false;
  const review = t.resolution.review;
  if (!review?.sourceApproved || !review.awaitingProofs?.length) return false;
  // Once Queue has a terminal receipt for one of the named proofs, the old
  // awaiting-proof stop no longer describes the task. Settlement below routes
  // that receipt to its next owner (worker on failure, reviewer on pass).
  const settled = new Set((t.proofExecutions ?? [])
    .filter(proof => proof.settledAt && proof.head === review.head)
    .map(proof => proof.selector));
  if (awaitingProofTexts(review.awaitingProofs).every(selector => settled.has(selector))) return false;
  return !(t.resolution.ownerAcceptances ?? []).some(entry => entry.kind === 'operator_source' && entry.head === review.head);
}

/**
 * Spec 058 (task 539): the proof texts Queue already sent to the worker at this
 * head, one `proof_worker_requested` event each. A proof the worker had at a head
 * is not sent again at that head: a repeat is the operator's question, never
 * another worker round.
 */
export function proofWorkerRequests(store: Store, taskId: string, head: string): Set<string> {
  const prefix = `${head}: `;
  return new Set(store.eventsAll(taskId)
    .filter(event => event.kind === 'proof_worker_requested' && event.detail.startsWith(prefix))
    .map(event => event.detail.slice(prefix.length)));
}

/**
 * Spec 058 (task 540): the head and selector of a parked source approval that the brief's own
 * `proofExecution` declaration names as an external proof, while the one allowance is unspent. Anything
 * else is not runnable by Queue and keeps its ordinary route.
 */
export function runnableDeclaredProof(task: Task, runs: Run[]): { head: string; selector: string } | null {
  if (!task.proofExecution) return null;
  if (task.resolution.stop?.reason !== 'awaiting_proof' || !proofWaitApplies(task)) return null;
  const review = task.resolution.review;
  // Automatic execution follows only the reviewer's current source-approved proof wait.
  if (review?.status !== 'blocked' || review.sourceApproved !== true) return null;
  const head = review?.head;
  if (!head || head !== task.prHead) return null;
  if (proofHeadAdmission(task, runs, head)) return null;
  const selector = task.proofExecution.selector.trim();
  const named = (review?.awaitingProofs ?? []).some(proof => awaitingProofRoute(proof) === 'external'
    && awaitingProofMatchesSelector(proof, selector, declaredProofSelectors(task)));
  return named ? { head, selector } : null;
}

/** Preserve a prior receipt when a new approved head only edits documentation. */
export async function docsOnlyProofAutorunSkip(task: Task, head: string): Promise<string | null> {
  const prior = proofExecutions(task).at(-1);
  const declaration = task.proofExecution;
  if (!prior || !declaration || prior.head === head || prior.selector !== declaration.selector
    || prior.inputs.length !== declaration.inputs.length
    || prior.inputs.some((input, index) => input !== declaration.inputs[index]) || !task.directory) return null;
  let changedCount = 0;
  let docsOnly = true;
  try { await gitNulEach(task.directory, ['diff', '--name-only', '-z', prior.head, head, '--'], path => {
    changedCount++;
    if (!path.startsWith('docs/') && !path.endsWith('.md')) docsOnly = false;
  }); }
  catch { return null; }
  // An empty diff changes no byte a proof could read; it skips like a docs-only head.
  if (changedCount === 0) return `empty diff since proof execution at ${prior.head}; no changed path can affect the proof`;
  if (!docsOnly) return null;
  return `docs-only changes since proof execution at ${prior.head}; selector and declared input hashes are unchanged`;
}

/** A changed pinned input must be re-declared by the planner before autorun. */
export async function proofAutorunWaitingInputs(task: Task, head: string): Promise<string | null> {
  const prior = proofExecutions(task).at(-1);
  const declaration = task.proofExecution;
  if (!prior || !declaration || prior.head === head
    || prior.selector !== declaration.selector || prior.inputs.length !== declaration.inputs.length
    || prior.inputs.some((input, index) => input !== declaration.inputs[index])) return null;
  if (!task.directory) return `cannot verify declared inputs against proof execution at ${prior.head}; waiting for input re-declaration`;
  const changed: string[] = [];
  try { await gitNulEach(task.directory, ['diff', '--name-only', '-z', prior.head, head, '--'], path => { changed.push(path); }); }
  catch { return `cannot verify changed paths since proof execution at ${prior.head}; waiting for input re-declaration`; }
  const declared = new Set(declaration.inputs.map(input => input.replace(/^sha256:/, '').toLowerCase()));
  if (declared.size === 0 || changed.length === 0) return null;
  for (const path of changed) {
    // A declared hash matching either side of a changed path identifies that
    // path as a pinned input; the new declaration must follow its new bytes.
    let oldHash: string | null = null;
    let newHash: string | null = null;
    for (const revision of [prior.head, head]) {
      try {
        const hash = await gitHash(task.directory, ['show', `${revision}:${path}`]);
        if (revision === prior.head) oldHash = hash;
        else newHash = hash;
      } catch { /* added or removed path: inspect the other side */ }
    }
    if (newHash && declared.has(newHash)) continue;
    if (oldHash && declared.has(oldHash))
      return `declared input at ${path} changed since proof execution at ${prior.head}; waiting for input re-declaration`;
    if (!oldHash && !newHash)
      return `cannot read changed path ${path} since proof execution at ${prior.head}; waiting for input re-declaration`;
  }
  return null;
}
