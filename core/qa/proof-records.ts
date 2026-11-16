/**
 * Task 405: the append-only record of author-side proof executions. One owner of
 * the receipt facts Queue reads (which allowance is spent, which receipt still
 * needs a verdict) and of the declaration identity an amendment must preserve.
 * The run itself is an ordinary `executor` run in the task workspace; it
 * publishes no review, spends no reviewer credit and cannot reach merge.
 */
import { now, type Store } from '../store/store';
import type { ProofExecutionRecord, Run, Task } from '../../shared/contracts';
import { qualificationExecutionDigest, qualificationSubjectDigest } from '../../shared/schema/review/proof';

/** A brief's or run's proof declaration, without the bindings only a run carries. */
export interface ProofDeclaration { selector: string; inputs: string[] }

/** The ordered execution history, including attempts with unknown start. */
export const proofExecutions = (task: Pick<Task, 'proofExecutions'>): ProofExecutionRecord[] => task.proofExecutions ?? [];

/** A reservation stays spent when start evidence is absent or legacy-inferred. */
export const spentProofExecution = (task: Pick<Task, 'proofExecutions'>, _runs: Pick<Run, 'id' | 'completion'>[] = []): ProofExecutionRecord | null =>
  proofExecutions(task)[0] ?? null;

/**
 * The settled proof-only receipt that still needs a verdict. Historical
 * receipts stay here: they spend no allowance but still need judgment.
 */
export function settledProofOnlyReceipt(
  task: Pick<Task, 'entrypoint' | 'proofOnly' | 'proofOnlyResult' | 'proofExecutions'>,
): ProofExecutionRecord | null {
  if (task.entrypoint !== 'proof' || !task.proofOnly || task.proofOnlyResult) return null;
  const receipt = spentProofExecution(task);
  if (!receipt || receipt.status === 'running' || receipt.head !== task.proofOnly.commit) return null;
  return receipt;
}

/** A proof-only qualification has a settled receipt and no recorded verdict. */
export const proofOnlyReceiptAwaitingReview = (
  task: Pick<Task, 'entrypoint' | 'proofOnly' | 'proofOnlyResult' | 'proofExecutions'>,
): boolean => settledProofOnlyReceipt(task) !== null;

/**
 * Task 407: two declarations are the same subject only when both name the same
 * selector and the same input hashes, in order. Nothing here compares anything
 * else, and an absent declaration is never equal to a present one.
 */
export const sameProofDeclaration = (a: ProofDeclaration | null, b: ProofDeclaration | null): boolean =>
  a === null || b === null ? a === b : a.selector === b.selector && a.inputs.length === b.inputs.length
    && a.inputs.every((input, index) => input === b.inputs[index]);

/** One line for an event or a refusal: the selector and how many input hashes it pinned. */
export const proofDeclarationSummary = (declaration: ProofDeclaration | null): string => declaration
  ? `${declaration.selector}${declaration.inputs.length ? ` with ${declaration.inputs.length} input hash${declaration.inputs.length === 1 ? '' : 'es'}` : ''}`
  : 'no declaration';

/**
 * Task 407: the declaration an amendment must keep, or `null` while the one
 * allowance is unspent. A reservation is the append-only record or the executor
 * run itself: a lost creation reply records the run and no settled record, and
 * a cancelled, failed or uncertain run is just as final. `declaration` is null
 * when a reservation's bound subject cannot be read, which no amendment can
 * prove compatible with.
 */
export function proofReservation(task: Pick<Task, 'proofExecutions'>, runs: Pick<Run, 'id' | 'role' | 'status' | 'proofExecution'>[]):
  { runId: string; status: string; declaration: ProofDeclaration | null } | null {
  const spent = spentProofExecution(task);
  if (spent) return { runId: spent.runId, status: spent.status, declaration: { selector: spent.selector, inputs: spent.inputs } };
  const run = runs.find(item => item.role === 'executor');
  if (!run) return null;
  return {
    runId: run.id, status: run.status,
    declaration: run.proofExecution ? { selector: run.proofExecution.selector, inputs: run.proofExecution.inputs } : null,
  };
}

/** The queue-created executor's own run identity, distinct from every source-author record. */
export function proofExecutionRecord(run: Run, task: Task, authorizedBy: ProofExecutionRecord['authorizedBy'], operationId: string | null): ProofExecutionRecord {
  if (!run.proofExecution || !run.agentId) throw new Error('An executor run without its bound subject or agent cannot record proof execution');
  return {
    runId: run.id, agentId: run.agentId, workspaceId: run.workspaceId, profile: run.profile,
    operationId, selector: run.proofExecution.selector, inputs: run.proofExecution.inputs,
    repository: task.repository, prNumber: task.proofOnly ? null : run.proofExecution.prNumber, branch: task.branch, head: run.head,
    briefVersion: run.proofExecution.briefVersion, briefDigest: run.proofExecution.briefDigest,
    authorizedBy, activatedAt: run.createdAt, settledAt: null, status: 'running', historical: false, evidence: '',
    refusedBeforeSelector: false, selectorStart: 'unknown',
    // Spec 064 P1: the private qualification reference this execution ran, when it
    // carries one; a run with no qualification binding records none.
    ...(run.proofExecution.qualification ? {
      qualification: {
        reference: `${run.taskId}/${run.id}`,
        subjectDigest: qualificationSubjectDigest(run.proofExecution.qualification.subject),
        executionDigest: qualificationExecutionDigest(run.proofExecution.qualification.execution),
      },
    } : {}),
  };
}

/** Append one settled executor record to the task; the first one spends the allowance for good. */
export function recordProofExecution(store: Store, taskId: string, record: ProofExecutionRecord, eventDetail: string): ProofExecutionRecord {
  const task = store.task(taskId);
  const settled: ProofExecutionRecord = { ...record, settledAt: record.settledAt ?? now() };
  const next = task.proofExecutions.some(item => item.runId === settled.runId)
    ? task.proofExecutions.map(item => item.runId === settled.runId ? settled : item)
    : [...task.proofExecutions, settled];
  store.update(taskId, { proofExecutions: next }, 'proof_execution_recorded', eventDetail);
  return settled;
}

/**
 * Task 405: a later independent reviewer must also be independent of the proxy
 * that produced the author-side evidence. These are the executor models and
 * agents recorded on the task, never the unchanged source author.
 */
export const proofExecutorModels = (task: Pick<Task, 'proofExecutions'>): string[] =>
  (task.proofExecutions ?? []).flatMap(record => record.profile?.model ? [record.profile.model] : []);
