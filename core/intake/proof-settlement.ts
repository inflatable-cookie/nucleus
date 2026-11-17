import type { Completion, Run, Task } from '../../shared/contracts';
import { proofExecutionRecord, recordProofExecution } from '../qa/proof-records';
import { awaitingProofMatchesSelector, declaredProofSelectors } from '../qa/proof-wait';
import type { Resolution } from '../resolution';
import type { Store } from '../store/store';
import { recordResultApplied, resultApplied } from './applied-result';
import type { QualificationSettlementReferenceRead } from '../host-runs/qualification-settlement';

/** One proof execution's settled outcome, as its report and the source proof read it. */
export type ProofOutcome = 'passed' | 'failed' | 'stale' | 'unknown';

export type ProofSettlementFacts = { readonly store: Store; update: Resolution['update'] };

/**
 * The `proofResult` shape an executor report must carry. It is read once here and
 * applied by the completion refusal, the pre-source gate and the historical
 * settlement, so an executor can never pass one gate and fail another.
 */
export function proofResultRefusal(
  input: Completion,
  run: Pick<Run, 'role' | 'proofExecution'> & { id?: string },
  qualificationSettlement: QualificationSettlementReferenceRead | null = null,
): string | null {
  if (run.role !== 'executor') return input.proofResult ? 'proofResult is only accepted on a proof execution run' : null;
  if (!run.proofExecution) return 'Executor run is missing its bound proof subject';
  if (input.status !== 'proof_executed') return null;
  if (!input.proofResult) return 'A proof execution result must carry proofResult for its declared selector';
  if (input.proofResult.selector !== run.proofExecution.selector) return "Proof execution result must name the run's declared selector";
  // Spec 064 P6/P7: a qualification-mode result is consumed against the exact
  // settlement the endpoint wrote, through the executor's existing authentication.
  // A status, an exit code or a bounded evidence line is never a qualification
  // verdict, and a spent attempt can never report a pass.
  if (!run.proofExecution.qualification) return null;
  if (qualificationSettlement === null)
    return 'A qualification proof execution must be settled from the endpoint\'s own settlement record; none was read for this run';
  if (qualificationSettlement.state === 'absent')
    return `No qualification settlement is recorded for executor run ${run.id ?? '(unnamed)'}; a proof status alone establishes nothing for this mode`;
  if (qualificationSettlement.state === 'unreadable')
    return `The recorded qualification settlement for executor run ${run.id ?? '(unnamed)'} cannot be read (${qualificationSettlement.reason})`;
  const reference = qualificationSettlement.reference;
  const reported = input.proofResult.qualification;
  if (!reported)
    return `A qualification proof result must carry the exact settlement digest it read; this run settled ${reference.digest}`;
  if (reported.settlementDigest !== reference.digest)
    return `The proof result names settlement ${reported.settlementDigest}, not this run's recorded ${reference.digest}; a different settlement is never accepted`;
  if (reported.artifactSha256 !== reference.artifactSha256)
    return `The proof result names artifact ${reported.artifactSha256}, not this run's single retained artifact ${reference.artifactSha256}`;
  if (reference.spent || reference.verdict !== 'proved')
    return input.proofResult.status === 'passed'
      ? `The qualification attempt is ${reference.verdict}${reference.spent ? ' and spent' : ''}, so a late or unresolved settlement cannot report a pass${reference.firstFault ? ` (first fault: ${reference.firstFault})` : ''}`
      : null;
  return null;
}

/** Spec 064 P7: the disposition a qualification receipt keeps beside its verdict. */
export interface ProofQualificationDisposition {
  settlementDigest: string;
  verdict: 'proved' | 'failed' | 'unknown';
  spent: boolean;
  firstFault?: string;
  unresolvedObligations: string[];
}

export interface ProofSettlement {
  task: Task;
  run: Run;
  completion: Completion;
  /** Present only for a qualification-mode execution, from its recorded settlement. */
  qualification?: ProofQualificationDisposition;
  outcome: ProofOutcome;
  /** The bounded evidence text this record carries; the caller decides what it observed. */
  evidence: string;
  selectorStart: 'started' | 'unknown';
  selectorStartEvidence?: string;
}

/**
 * The single owner of settling one proof execution: its evidence and terminal exit
 * are recorded in the caller's transaction, and the task returns to the phase the
 * owner activated the execution from. It is never a review, never a pass for
 * another role and never a merge; a source-approved review at the same head that
 * awaited this proof gets its evidence-only round.
 */
export function settleProofExecution(facts: ProofSettlementFacts, settlement: ProofSettlement): void {
  const { task, run, completion, outcome } = settlement;
  const binding = run.proofExecution;
  if (!binding) throw new Error('A proof executor completed without its bound subject');
  const latest = facts.store.task(task.id);
  if (latest.resolution.currentRunId !== run.id || resultApplied(facts.store, task.id, run.id)) return;
  recordResultApplied(facts.store, task.id, run.id);
  const record = proofExecutionRecord({ ...run, completion }, latest, binding.authorizedBy, binding.operationId);
  recordProofExecution(facts.store, task.id, { ...record, status: outcome, exitCode: completion.proofResult?.exitCode ?? null,
    refusedBeforeSelector: false, selectorStart: settlement.selectorStart,
    ...(settlement.selectorStartEvidence ? { selectorStartEvidence: settlement.selectorStartEvidence } : {}),
    // Spec 064 P7: the receipt keeps the settlement it settled from and that
    // settlement's disposition, so a spent attempt stays spent and a late result
    // never becomes a pass.
    ...(settlement.qualification && record.qualification ? {
      qualification: {
        ...record.qualification,
        settlementDigest: settlement.qualification.settlementDigest,
        verdict: settlement.qualification.verdict,
        spent: settlement.qualification.spent,
        ...(settlement.qualification.firstFault ? { firstFault: settlement.qualification.firstFault } : {}),
        unresolvedObligations: settlement.qualification.unresolvedObligations,
      },
    } : {}),
    evidence: settlement.evidence },
    `${run.id}: ${outcome} for ${binding.selector} at ${run.head}`);
  const reason = outcome === 'passed'
    ? `Author-side proof execution ${run.id} passed ${binding.selector} at ${run.head}; a distinct independent review is still required`
    : outcome === 'failed'
      ? `Author-side proof execution ${run.id} did not pass ${binding.selector} at ${run.head}; the execution is recorded and that head's allowance is spent`
      : `Author-side proof execution ${run.id} cannot claim passing evidence for ${binding.selector} at ${run.head} (${outcome}); the execution is recorded and that head's allowance is spent`;
  if (latest.entrypoint === 'proof') {
    facts.update(latest, { currentRunId: null, integrationTurn: null },
      { phase: 'awaiting_review', reason: `Qualification ${run.id} settled ${outcome} for ${binding.selector} at merged commit ${run.head}; the retained reviewer will judge its receipt` },
      'proof_only_execution_settled', `${run.id}: ${outcome} for ${binding.selector} at ${run.head}`);
    return;
  }
  if (outcome === 'failed') {
    const cases = [completion.summary, completion.proofResult?.evidence].filter(Boolean).join('\n').slice(0, 3000);
    const instruction = `The settled proof failed at ${run.head}. Revise the task to address these failing cases, then return the PR for the retained reviewer to judge. Proof receipt: task.detail → proofExecutions for run ${run.id} (selector ${binding.selector}, exact head ${run.head}); use its recorded evidence and case failures as the instruction.\n${cases}`.slice(0, 4000);
    facts.update(latest, { currentRunId: null, integrationTurn: null, review: latest.resolution.review,
      pendingWorkerInstruction: instruction, pendingRevisionCause: 'review' },
      { phase: 'changes_requested', reason: `Settled proof ${run.id} failed ${binding.selector} at ${run.head}; the retained worker must address the recorded failures` },
      'proof_failure_returned_to_worker', run.id);
    return;
  }
  const evidenceOnlyRound = outcome === 'passed' && latest.resolution.review?.sourceApproved
    && latest.resolution.review.head === run.head
    && latest.resolution.review.awaitingProofs?.some(item => awaitingProofMatchesSelector(item, binding.selector, declaredProofSelectors(latest)));
  facts.update(latest, { currentRunId: null, integrationTurn: null },
    { phase: evidenceOnlyRound ? 'awaiting_review' : binding.returnPhase,
      reason: evidenceOnlyRound ? `Settled proof ${run.id} passed ${binding.selector} at ${run.head}; evidence-only review is next` : reason },
    'proof_execution_settled');
}
