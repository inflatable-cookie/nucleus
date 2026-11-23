import { holdsOf, type OwnerAcceptanceRecord, type Task } from "../../../shared/contracts";
import type { Engine } from "../../engine";
import { DurableFenceRefusal } from "../../intake/run-settlement";
import { taskPrNumber } from "../../forge/index";
import { releasePatch } from "../../merge/merge-hold";
import { now } from "../../store/store";
import { readyReviewAtHead } from "../../recovery/task-reasons";
import { qualifiedAcceptanceEligibility } from "../owner-verbs";
import { MOVE_MERGE_ACCEPTANCE_REFUSAL, moveStateRefusal, REMOVED_TASK_REFUSAL } from "../control-refusals";

/**
 * A forge observation failed before this move wrote anything or sent a stop
 * (nucleus#1428). The read was the only work done, so the refusal proves nothing
 * was bound or sent. The type lets the operation settle as a definite failure.
 */
export class PreWriteMergeObservationRefusal extends Error {
  constructor(cause: string) {
    super(`Merge refused before any write: the PR observation failed (${cause}). Nothing was written or sent; retry the move.`);
    this.name = "PreWriteMergeObservationRefusal";
  }
}

/**
 * Run one read-only PR observation. A failure is a pre-write refusal only while
 * the move has recorded no event since it began: every store write and every
 * stop intent this move makes is evented, so an unchanged journal proves that
 * nothing was written or sent. Any event since then keeps the original error.
 */
async function observeBeforeWrite<T>(
  store: Engine["store"],
  taskId: string,
  eventsBefore: number,
  observe: () => Promise<T>,
): Promise<T> {
  try {
    return await observe();
  } catch (error) {
    if (store.eventsAll(taskId).length !== eventsBefore) throw error;
    throw new PreWriteMergeObservationRefusal(error instanceof Error ? error.message : String(error));
  }
}

/** The owner `move to=merge` request, after the verb has parsed it. */
export type MergeMoveInput = {
  taskId: string;
  version: number;
  reason: string;
  caller?: string;
  qualification?: string;
  head?: string;
  relayed?: boolean;
  delegated?: boolean;
  relayNote?: string;
};

/**
 * Spec 050 `move to=merge`: enter the normal integration turn, pre-merge
 * hooks and merge path. Allowed only with an accepted review at the exact
 * current PR head, re-verified at the remote before anything changes — or,
 * since 2026-10-17, with an explicit qualified owner acceptance: the task
 * project's authorized owner (or an operator ruling relayed with its note)
 * records one durable acceptance over an authentic released reviewer verdict
 * at the exact current head, and the ordinary verification, merge and
 * closeout gates read it without any fabricated reviewer pass. Since
 * 2026-10-20 the same owner path also records an explicit operator source
 * acceptance of the exact published source head AS IS when no review evidence
 * binds that head. The record binds actor, authority, ruling, head,
 * qualification and the concrete missing evidence; it never invents a verdict
 * or rewrites one as PASS, and a later head invalidates it. Every merge hold and
 * every other gate (required checks, pre-merge hooks, forge identity) stays
 * real, and a clean advance of the integration base is not drift.
 */
export async function moveToMerge(engine: Engine, input: MergeMoveInput): Promise<Task> {
  const store = engine.store;
  const adapter = engine.adapter;
  const task = store.task(input.taskId);
  if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
  engine.requireOwnerControlCurrent(task, input.version, 'Task changed; refresh before retrying');
  const stateRefusal = moveStateRefusal(task, "merge");
  if (stateRefusal) throw Error(stateRefusal);
  const qualification = input.qualification?.trim();
  const accepting = Boolean(qualification);
  if (input.head && !accepting) throw Error('A head can be named only with an owner acceptance (qualification); a reviewed merge needs an exact-head ready review');
  // Papercut 209406f4: an owner acceptance may name the exact PR head it accepts.
  // Every gate below is judged at that head, never the stored one: an old-head
  // verdict, ready or not, is history and never carries over.
  const acceptedHead = input.head ?? task.prHead;
  const adopting = Boolean(input.head) && input.head !== task.prHead;
  const prospective = (t: Task): Task => adopting ? { ...t, prHead: acceptedHead } : t;
  if (!readyReviewAtHead(task, acceptedHead)) {
    // The ordinary gate is exact-head `ready_to_merge`. With an explicit
    // qualification the caller states acceptance intent, and Queue derives the
    // task, PR, head and — when a current-head verdict exists — the review
    // identities under the shared rule; otherwise the disposition is an explicit
    // operator source acceptance of the exact published head.
    if (!accepting) throw Error('Move to merge requires an accepted review at the current PR head');
    const eligible = qualifiedAcceptanceEligibility(prospective(task), store.runs(task.id));
    if (!eligible.available) throw Error(eligible.refusal);
  } else if (accepting) {
    throw Error(MOVE_MERGE_ACCEPTANCE_REFUSAL);
  }
  const authority = accepting
    ? (input.delegated ? engine.assertDelegatedAuthority(input.caller, input.relayNote, 'Qualified owner acceptance') : engine.assertOwnerAuthority(input.caller, input.relayed, input.relayNote))
    : null;
  // Re-verify the canonical source before anything is displaced or written: the
  // head the move enters verification with is GitHub's own open PR head, and it
  // must be the head named, or with none named, the stored one.
  const mergeRunsBefore = store.runs(task.id);
  const eventsBefore = store.eventsAll(task.id).length;
  const observed = await observeBeforeWrite(store, task.id, eventsBefore, () => adapter.verifyPr(task, taskPrNumber(task)));
  engine.assertUnchangedBeforeCancel(task.id, input.version, mergeRunsBefore);
  if (input.head && observed.head !== input.head)
    throw Error(`The current PR head ${observed.head} differs from the head you accept (${input.head}); refresh before retrying`);
  if (!input.head && observed.head !== task.prHead)
    throw Error(`The current PR head ${observed.head} differs from the task's recorded head ${task.prHead}; pass head=${observed.head} with an owner acceptance to accept that exact head, or move to review for a review of it`);
  // Spec 050 (#3569): finished runs of other roles settle by observation before
  // the run fence; one that cannot settle refuses here, with nothing written.
  // Round 4: a move applies while paused; only dispatch waits for unpause, and
  // every run in the way is displaced — only a durable side effect refuses.
  const finished = await engine.collectVerbFinishedRuns(task.id, () => false, { displace: true });
  if (finished.fenced.length) throw new DurableFenceRefusal(engine.displaceRefusal(finished.fenced[0]!));
  const displaced = [...finished.settleable, ...finished.live];
  engine.assertUnchangedBeforeCancel(task.id, input.version, mergeRunsBefore);
  await engine.cancelDisplacedTurns(task.id, finished.live, 'move merge');
  // Keep the admitted task and run facts across every remote read and stop.
  // The move's own fence settlement happens only in the guarded transaction;
  // unrelated writes during earlier waits must not become a fresh baseline.
  return engine.control(async () => {
    engine.assertUnchangedBeforeCancel(task.id, input.version, mergeRunsBefore);
    // A fresh observation after the waits and the cancellation: a displaced turn
    // may have pushed before it stopped, and no network call runs inside the
    // commit transaction below.
    const pr = await observeBeforeWrite(store, task.id, eventsBefore, () => adapter.verifyPr(task, taskPrNumber(task)));
    if (pr.head !== acceptedHead) throw Error(`The current PR head ${pr.head} differs from the accepted head ${acceptedHead}; refresh before retrying`);
    return store.transaction(() => {
      const current = store.task(task.id);
      engine.assertUnchangedBeforeCancel(task.id, input.version, mergeRunsBefore);
      // The settlement records a recovery episode's pending accepted action as
      // not applied on the resolved episode; the re-read carries that record
      // through the move's own update below.
      engine.settleVerbFences(task.id, { detail: `move merge: ${input.reason}`, runIds: [], displacedRunIds: displaced.map(run => run.id) });
      if (store.runs(current.id).some(run => !run.released && run.id !== engine.coordinatorActionRunId.getStore()))
        throw Error('A run started during the move; refresh before retrying');
      const stored = store.task(task.id);
      // A head is adopted only from the stored head the move read, and only with
      // the acceptance that names it: a refused acceptance adopts nothing.
      if (adopting && stored.prHead !== task.prHead) throw Error('The task head changed during the move; refresh before retrying');
      const settledTask = prospective(stored);
      const settledEligibility = accepting ? qualifiedAcceptanceEligibility(settledTask, store.runs(settledTask.id)) : null;
      const accepted = settledTask.resolution.review;
      // Accepting, the shared rule re-derived on the settled state is the guard:
      // it binds the exact settled head for either disposition kind. Otherwise
      // the ordinary gate stays the exact-head ready review.
      if (settledTask.prHead !== pr.head
        || (accepting ? settledEligibility!.available !== true : !readyReviewAtHead(settledTask)))
        throw Error('The accepted review or PR head changed during the move; refresh before retrying');
      const sequence = settledTask.resolution.integrationTurn?.sequence ?? store.nextIntegrationSequence(settledTask.repoPath);
      // The one durable owner decision beside the immutable verdict: task, PR,
      // head and — for a reviewed acceptance — review identities, the attributed
      // caller, the authority it proved and the disclosed qualification. Recording
      // never touches the verdict, its publication, any hold or any other gate.
      let acceptance: OwnerAcceptanceRecord | null = null;
      if (accepting && settledEligibility!.available) {
        const common = {
          at: now(), head: pr.head, prNumber: taskPrNumber(settledTask),
          actor: { agentId: input.caller!, role: authority!.role },
          authority: { kind: authority!.kind, note: authority!.note },
          reason: input.reason.trim().slice(0, 4000), qualification: qualification!.slice(0, 4000),
        };
        if (settledEligibility!.acceptance === 'reviewed') {
          // The acceptance binds only a reviewer verdict; the eligibility rule
          // above proved it, and this narrow guard keeps the record's type exact.
          if (!accepted || accepted.status !== 'changes_required') throw Error('The recorded review changed during the move; refresh before retrying');
          acceptance = { ...common, kind: 'reviewed', missingEvidence: null,
            review: { runId: accepted.runId, eventId: accepted.eventId, head: settledTask.prHead, status: accepted.status,
              reviewId: accepted.reviewId ?? null, reviewCommentId: accepted.reviewCommentId ?? null } };
        } else {
          acceptance = { ...common, kind: 'operator_source', review: null, missingEvidence: settledEligibility!.missingEvidence.slice(0, 4000) };
        }
      }
      if (acceptance) store.event(task.id, 'owner_acceptance', JSON.stringify({ taskId: task.id, kind: acceptance.kind, prNumber: acceptance.prNumber, head: acceptance.head,
        ...(acceptance.kind === 'operator_source' ? { missingEvidence: acceptance.missingEvidence } : {}),
        review: acceptance.review, actor: acceptance.actor, authority: acceptance.authority, reason: acceptance.reason, qualification: acceptance.qualification }).slice(0, 4000));
      if (adopting) store.event(task.id, 'owner_head_adopted', JSON.stringify({ from: task.prHead, to: pr.head, caller: input.caller ?? null, reason: input.reason.trim().slice(0, 400) }));
      // A planner or operator that settles the exact proof-wait head and moves
      // it to merge has resolved this specific Queue-created hold. Keep every
      // other merge hold under its existing owner's control.
      const proofHold = holdsOf(settledTask).merge;
      const proofHoldPrefix = `Proofs Queue cannot run, left for the planner or operator at ${pr.head}:`;
      const settlesProofHold = Boolean(proofHold && proofHold.reason.startsWith(proofHoldPrefix));
      store.update(settledTask.id, {
        ...(adopting ? { prHead: pr.head } : {}),
        ...(settlesProofHold ? releasePatch(settledTask, 'merge') : {}),
        phase: 'verifying',
        reason: (acceptance
          ? (acceptance.kind === 'operator_source'
            ? `${acceptance.actor.role === 'delegated' ? 'A delegated answer' : 'Operator'} accepted the source head ${pr.head} as is without current-head review evidence; entering ordinary verification`
            : `${acceptance.actor.role === 'delegated' ? 'A delegated answer' : 'Owner'} accepted the reviewed head ${pr.head} with disclosed qualification; entering ordinary verification`)
          : `Owner moved the task to merge at the accepted reviewed head ${pr.head}`).slice(0, 2000),
        resolution: { ...settledTask.resolution,
          ownerAcceptances: acceptance ? [...(settledTask.resolution.ownerAcceptances ?? []), acceptance] : settledTask.resolution.ownerAcceptances,
          currentRunId: null, mechanicalVerification: null,
          attention: false, recoveryActive: false, recoveryAttempts: 0,
          integrationTurn: settledTask.resolution.integrationTurn ?? { sequence, acceptedAt: now() } },
      }, input.caller ? 'move_merge_requested' : 'owner_control', JSON.stringify({ verb: 'move', to: 'merge', head: pr.head,
        ...(acceptance ? { qualifiedAcceptance: true, actor: acceptance.actor, authority: acceptance.authority } : {}),
        phaseBefore: settledTask.phase, reason: input.reason }));
      if (settlesProofHold) store.event(task.id, 'merge_release', `Proof hold released by accepted move to merge at exact head ${pr.head}; ${input.reason}`.slice(0, 4000));
      return store.task(task.id);
    });
  }, `task:${task.id}`);
}
