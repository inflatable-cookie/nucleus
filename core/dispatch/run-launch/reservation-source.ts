import type { LaunchReserveContext } from '../launch';
import type { LaunchMachinePorts } from './machine';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Profile, Run, StashEntry, Task } from '../../../shared/contracts';
import { recordIntegrationFastForward } from '../../git/index';
import { currentBrief } from '../../planning/brief';
import { checkHistoryFromStore } from '../../forge/index';
import { ordinaryReviewDelta } from '../../review/ordinary-review';
import { proofExecutor } from '../../recovery/task-reasons';
import type { ContinuedPrBinding, ProofActivation } from '../../resolution';
import type { chooseProfile } from '../routing';
import { revisionContinuationAction } from '../prompts';

/** What the launch asks for: its profile, instruction and any proof activation. */
export interface ReservationOptions { profile?: Profile; instruction?: string; proof?: ProofActivation }
/** The participant and thread facts thread selection proved before the reservation. */
export interface ReservationSelection {
  agentId: string | null; profile: Profile | null; group: string | null; workspaceId: string;
  coordinatorRouteSwitch: string | null; replacingReviewer: boolean;
  orphanRuns: (id: string) => Run[]; threadBusy: (id: string) => boolean;
}
/** What the launch already proved about the source before it asked for a run. */
export interface ReservationSourceInput {
  firstReviewEntryWorker: boolean; firstWorkerSelection: ReturnType<typeof chooseProfile> | null;
  prePrWorkerResume: boolean; retainedPrePrHead: string | null; resumingUnpublished: boolean;
  continuedPr?: ContinuedPrBinding | null;
}

/**
 * Everything one reservation reads from the task and store before it may write
 * anything: the instruction the run consumes, its revision cause and review
 * round, the stash baseline it records, the proof it executes, the stamps the
 * admission re-checks, and the review round it continues.
 */
export class RunReservationSource {
  constructor(readonly resolution: LaunchReserveContext) {}
  get store() { return this.resolution.store; }
  /** The machine work this reservation needs, read from the live adapter at call time. */
  get machine(): LaunchMachinePorts { return this.resolution.adapter; }

  async read(input: { task: Task; role: Run['role']; options: ReservationOptions; source: ReservationSourceInput; selection: ReservationSelection }) {
    const { task: t, role, options, source } = input;
    const { firstReviewEntryWorker, prePrWorkerResume, retainedPrePrHead } = source;
    // A scoped revision instruction is delivered exactly once: it is attached to the run intent
    // that consumes it and never replayed to a later revision run.
    const pendingInstruction = role === 'revision' && t.resolution.revisionInstruction?.runId === null ? t.resolution.revisionInstruction : null;
    const nonDeliveryReplacement = role === 'revision' && Boolean(t.resolution.nonDeliveryRoutePending);
    const pendingPrePrInstruction = prePrWorkerResume ? t.resolution.prePrResumeInstruction : null;
    const pendingWorkerInstruction = role === 'revision'
      ? t.resolution.pendingWorkerInstruction ?? pendingPrePrInstruction ?? pendingInstruction?.text ??
        (t.phase === 'changes_requested' && t.resolution.review?.status === 'changes_required' ? t.resolution.review.summary : null) : null;
    const instruction = role === 'revision'
      ? options.instruction ?? pendingWorkerInstruction ?? (prePrWorkerResume
        ? 'Continue the original task in the retained workspace under its immutable instructions.'
        : revisionContinuationAction(t))
      : null;
    // Semantic review revisions (ordinary findings on the accepted head) stay distinct from
    // administrative recovery revisions in telemetry and in the revision budget. A durable
    // reviewed-head refusal is semantic too: it consumes one revision round without
    // overwriting the accepted review the hook occurrence already recorded.
    const pendingRevisionCause = role === 'revision' ? t.resolution.pendingRevisionCause : null;
    const revisionCause: Run['revisionCause'] = role === 'revision' ? (pendingRevisionCause ?? (t.resolution.review?.status === 'changes_required' ? 'review' : 'administrative')) : undefined;
    // Task 576: the cap counts review rounds, not author returns. Only the first
    // revision dispatched for one changes_required review consumes a round; later
    // dispatches for the same review (unfinished or non-delivery continuations,
    // owner-approved re-dispatches) and pre-merge refusals continue that round
    // without counting again (resolution review on #823, finding 1).
    const reviewEventId = role === 'revision' && revisionCause === 'review' ? t.resolution.review?.eventId ?? null : null;
    const countsReviewRound = revisionCause === 'review' && (reviewEventId === null || t.resolution.countedReviewEventId !== reviewEventId);
    const stash = role === 'revision' && t.directory ? await this.readStash(t) : null;
    const token = randomBytes(32).toString('hex');
    if (proofExecutor(role) && !options.proof?.tree) throw new Error('Proof execution requires its source tree proof before reservation');
    const proofTree = proofExecutor(role) ? options.proof!.tree! : null;
    const retryContext = role === 'revision' ? this.resolution.retryContext(t) : undefined;
    const sourceVersion = this.store.task(t.id).version;
    const sourceRuns = JSON.stringify(this.store.runs(t.id));
    const ordinaryRuns = this.resolution.ordinaryReviewRuns(t.id);
    const runId = randomUUID();
    const previousReview = role === 'reviewer' && t.entrypoint !== 'proof'
      ? this.store.runs(t.id).findLast(prior => prior.role === 'reviewer' && prior.released && prior.status === 'finished' && prior.completion) : undefined;
    // A subsequent round reads covering checks and the integration base only: asking whether a
    // review approves merging would refuse the very reviewer that has yet to review this head.
    const coveringEvidence = previousReview && previousReview.head !== t.prHead
      ? await this.machine.coveringEvidence!(t, checkHistoryFromStore(this.store, t.repoPath, Date.now(), t.prHead ?? ""), this.store.checksPolicyFor(t), move => recordIntegrationFastForward(this.store, t, move))
      : null;
    if (coveringEvidence && coveringEvidence.head !== t.prHead) throw Error('Covering evidence belongs to a different review head');
    const roundBase = coveringEvidence?.base ?? t.resolution.mergeBase ?? t.planningBase;
    // Queue 524 (papercut 2061d84f): a reviewer reads author evidence posted as
    // PR issue comments with gh. The run carries a bounded pointer (never
    // bodies); a fetch failure degrades to an explicit self-check notice, never
    // silence, so the reviewer still lists the comments itself.
    let authorEvidence = '';
    if (role === 'reviewer' && t.prHead) {
      try {
        const priorCommentId = previousReview?.completion && typeof (previousReview.completion as { reviewCommentId?: unknown }).reviewCommentId === 'number'
          ? (previousReview.completion as { reviewCommentId: number }).reviewCommentId : null;
        authorEvidence = await this.machine.authorCommentEvidence!(t, priorCommentId);
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 200);
        authorEvidence = `Author comment inventory could not be read (${reason}); list the PR issue comments yourself with gh and treat every comment that is not a Nucleus review publication as author evidence for the current head ${t.prHead}.`;
      }
    }
    const round = previousReview && (previousReview.head !== t.prHead || previousReview.completion?.sourceApproved)
      ? { ordinaryDetached: true as const, priorRunId: previousReview.id, priorHead: previousReview.head,
          retainedRounds: input.selection.agentId === previousReview.agentId ? (previousReview.retainedRounds ?? 0) + 1 : 0,
          ...(previousReview.head === t.prHead && previousReview.completion?.sourceApproved
            ? { proofOnly: true as const, reviewDelta: `Judge only arriving proof evidence for source approved at ${t.prHead}. Earlier findings: ${previousReview.completion.reviewText}` }
            : { reviewDelta: await ordinaryReviewDelta(t, previousReview, t.prHead!, roundBase) + `Covering evidence at ${t.prHead}:\n${JSON.stringify(coveringEvidence)}\n` }) } : {};
    const proofOnlyReview = role === 'reviewer' && t.entrypoint === 'proof';
    const proofOnlyInstruction = proofOnlyReview ? (t.proofExecutions.length
      ? `Judge only the immutable Nucleus proof receipt for merged commit ${t.proofOnly!.commit}. Receipt: ${JSON.stringify(t.proofExecutions.at(-1))}`
      : `The qualification touches ${t.requiresOperatorGo}. Do not run the selector or judge source. Report blocked at ${t.proofOnly!.commit} while Queue obtains the operator's release GO.`) : undefined;
    return {
      task: t, role, options, source, selection: input.selection,
      firstReviewEntryWorker, prePrWorkerResume, retainedPrePrHead,
      instruction, revisionCause, reviewEventId, countsReviewRound, stash, token, proofTree, retryContext,
      sourceVersion, sourceRuns, ordinaryRuns, runId, previousReview, roundBase, authorEvidence, round,
      proofOnlyReview, proofOnlyInstruction, nonDeliveryReplacement, pendingInstruction, pendingPrePrInstruction,
      handoverReview: role === 'reviewer' && Boolean(t.reviewEntry),
    };
  }

  /**
   * The stash list the revision's baseline records. A read that fails is
   * recorded as unknown on the task and the baseline stays absent: the dirty
   * worktree check then refuses against its own proof instead of reading a
   * failed read as "the worktree has no stash".
   */
  private async readStash(t: Task): Promise<StashEntry[] | null> {
    try {
      return await this.machine.readStash?.(t.directory!) ?? null;
    } catch (error) {
      this.store.event(t.id, 'stash_read_unknown',
        `The stash baseline could not be read before this revision: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000));
      return null;
    }
  }
}
export type ReservationSource = Awaited<ReturnType<RunReservationSource['read']>>;
