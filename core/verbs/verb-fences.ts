import type { Run, Task } from "../../shared/contracts";
import { isDispositionActive } from "../../shared/contracts";
import type { Engine } from "../engine";
import { releaseRunFromRecordedCompletion, settleSupersededFencesInTx, supersedeDisplacedRunInTx, supersedeIdleRunInTx, supersededIdleBinding } from "../recovery/fence-settlement";
import { observationAdvanceSince, runsUnchangedSince } from "../recovery/observation-advance";
import type { Adapter } from "../host/adapter";
import { coordinatorReportMatches } from "../recovery/recovery";
import type { Resolution } from "../resolution";
import { DurableFenceRefusal, matchingInactiveParticipant, runFenceRefusal, runSettlement, runSettlementFence } from "../intake/run-settlement";
import { digest, now } from "../store/store";

/** Classify a run using only facts already read; observation remains lazy. */
export function classifyVerbRun(input: {
  settlement: ReturnType<typeof runSettlement>; episode: boolean; displace: boolean;
  completed: boolean; currentBinding: boolean;
  observation?: Pick<Awaited<ReturnType<Adapter['observe']>>, 'id' | 'workspaceId' | 'active' | 'activeTurnId' | 'permissions' | 'status'> | null;
  agentId: string | null; workspaceId: string | null;
}): { kind: 'settle' | 'episode' | 'displace' | 'superseded' | 'observe' } | { kind: 'fence'; why: string } {
  const { settlement, episode, displace, completed, currentBinding, observation, agentId, workspaceId } = input;
  if (settlement.kind === 'fences') return { kind: 'fence', why: settlement.why };
  if (settlement.kind === 'settles') return { kind: 'settle' };
  if (episode) return { kind: 'episode' };
  if (displace) return { kind: 'displace' };
  if (!completed) return { kind: 'superseded' };
  if (currentBinding) return { kind: 'fence', why: 'its callback binding is still current' };
  if (observation === undefined) return { kind: 'observe' };
  if (!observation || !agentId || observation.id !== agentId || observation.workspaceId !== workspaceId)
    return { kind: 'fence', why: 'its agent is unobservable' };
  if (observation.active || observation.activeTurnId) return { kind: 'fence', why: 'its agent is active' };
  if (observation.permissions) return { kind: 'fence', why: 'its agent is awaiting a permission request' };
  if (!['idle', 'error', 'closed'].includes(observation.status)) return { kind: 'fence', why: `its agent is ${observation.status}` };
  return { kind: 'settle' };
}

/**
 * Displace or refuse the runs an owner verb would disturb. Same-name `Engine`
 * methods delegate here. `ownedToolHold`, `supersededIdleFence` and
 * `requireOwnerControlCurrent` go back through the engine so tests that replace
 * them on the instance still see these calls.
 */
export class VerbFences {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  get coordinatorActionRunId() { return this.engine.coordinatorActionRunId; }

  /**
   * Spec 050 (#3569): the finished runs of the roles an owner verb does not act
   * on, split by observation into what the verb may settle and what still
   * fences. A run settles when its completion is durably recorded and its agent
   * is observed idle with no active turn and no pending permission; otherwise
   * it fences, with the reason named. No writes happen here.
   */
  /** The run of the open coordinator episode, which the verb resolving it settles. */
  openEpisodeRunId(taskId: string): string | null {
    const recovery = this.store.task(taskId).resolution.recovery;
    return recovery && recovery.status !== 'resolved' ? recovery.runId ?? null : null;
  }

  /**
   * The run of the coordinator episode a verb resolves. The verb settles that
   * episode, so its own transition owns the run too: a run whose report is
   * recorded releases with it, and a run still working has its own turn
   * cancelled before the action's transaction settles it. An owner or a
   * coordinator is therefore never refused by the episode's own bookkeeping
   * (Tom, 2026-10-27). Other runs keep their existing fences; no writes happen
   * here beyond the durable turn-cancel intent and outcome.
   */
  async planEpisodeDisplacement(taskId: string, version: number, verb: string): Promise<{ runIds: string[]; cancel: () => Promise<void> }> {
    const noCancel = async () => {};
    const episodeRunId = this.openEpisodeRunId(taskId);
    if (!episodeRunId) return { runIds: [], cancel: noCancel };
    // Everything this observation is about is captured before it yields: a run
    // binding, its durable delivery state or the episode itself can change while
    // Queue watches, and a cancellation intent must never be written against a
    // stale view of them.
    const runsBeforeCancel = this.store.runs(taskId);
    const episodeId = this.store.task(taskId).resolution.recovery?.id ?? null;
    const collected = await this.collectVerbFinishedRuns(taskId, run => run.id !== episodeRunId, { settlesEpisode: true });
    if (collected.fenced.length) {
      // A durable side effect keeps its own refusal; anything else is the run's
      // identity or liveness, which no cancellation may stand in for.
      const fence = collected.fenced[0]!;
      const durable = this.runDurableFence(this.store.task(taskId), this.store.run(fence.run.id) ?? fence.run);
      throw new DurableFenceRefusal(durable ? this.displaceRefusal({ run: fence.run, why: durable }) : this.verbRunFenceRefusal(fence));
    }
    const runIds = [...collected.settleable, ...collected.live].map(run => run.id);
    // Planning only observes and classifies. The verb runs every refusal check it
    // still owes before calling `cancel`, so a later refusal leaves the working
    // coordinator untouched (review 5668722168).
    return {
      runIds,
      cancel: async () => {
        this.assertUnchangedBeforeCancel(taskId, version, runsBeforeCancel);
        const current = this.store.task(taskId);
        const recovery = current.resolution.recovery;
        if (!recovery || recovery.id !== episodeId || recovery.runId !== episodeRunId || recovery.status === 'resolved')
          throw Error("The coordinator episode changed while Nucleus observed its run; read next again before retrying");
        for (const run of collected.live) {
          const latest = this.store.run(run.id);
          if (!latest) throw Error("The coordinator run changed while Nucleus observed it; read next again before retrying");
          const why = this.runDurableFence(current, latest);
          if (why) throw new DurableFenceRefusal(this.displaceRefusal({ run: latest, why }));
        }
        await this.cancelDisplacedTurns(taskId, collected.live, verb);
        // Re-plan after the remote cancel: the transition settles this run only
        // while its episode is still the one the plan described.
        const after = this.store.task(taskId).resolution.recovery;
        if (!after || after.id !== episodeId || after.runId !== episodeRunId || after.status === 'resolved')
          throw Error("The coordinator episode changed during the cancellation; read next again before retrying");
      },
    };
  }

  async collectVerbFinishedRuns(taskId: string, isSubject: (run: Run) => boolean, options: { displace?: boolean; settlesEpisode?: boolean } = {}):
    Promise<{ settleable: Run[]; fenced: { run: Run; why: string }[]; live: Run[] }> {
    const settleable: Run[] = [];
    const fenced: { run: Run; why: string }[] = [];
    const live: Run[] = [];
    const task = this.store.task(taskId);
    for (const run of this.store.runs(taskId)) {
      if (run.released || isSubject(run)) continue;
      const episode = options.settlesEpisode && run.role === 'recovery' && run.id === task.resolution.recovery?.runId
        && task.resolution.recovery?.status !== 'resolved';
      const direct = episode && Boolean(run.completion) || (episode || options.displace) && run.id === this.coordinatorActionRunId.getStore();
      const settlement = runSettlement({ store: this.store, task }, run, { direct });
      const facts = { settlement, episode: Boolean(episode), displace: Boolean(options.displace), completed: Boolean(run.completion),
        currentBinding: run.role !== 'recovery' && (run.id === task.resolution.currentRunId || run.id === task.runId),
        agentId: run.agentId, workspaceId: run.workspaceId };
      const classification = classifyVerbRun(facts);
      if (classification.kind === 'fence') { fenced.push({ run, why: classification.why }); continue; }
      if (classification.kind === 'settle') { settleable.push(run); continue; }
      // The reporting run of the episode this verb resolves: the verb's own
      // transition settles it. Its accepted report is the run's result, so it is
      // released with the report and the turn delivering that report is never
      // cancelled. A run still working on the same episode is displaced after it
      // is observed, so a coordinator's or an owner's requested transition is
      // never refused by the episode's own bookkeeping (Tom, 2026-10-27).
      if (classification.kind === 'episode') {
        // The durable fence comes first for every case: a recorded report is the
        // run's result, but it never settles a separate unknown or pending
        // external effect (review 5668722168). A recorded report then settles
        // without another observation; a run still working is only displaced from
        // an observation that matches its own agent and workspace.
        const disposition = await this.runDisposition(run);
        if (typeof disposition === 'object') { fenced.push({ run, why: disposition.refusal }); continue; }
        (disposition === 'cancel' ? live : settleable).push(run);
        continue;
      }
      if (classification.kind === 'displace') {
        // Round 4 (Tom, 2026-10-19): an owner verb displaces the runs in its way.
        // Only a durable side effect still fences (runDurableFence). A busy
        // agent has its turn cancelled by the verb before it settles; an idle
        // one settles as is.
        // The reporting coordinator's own run settles with its action; Queue
        // never cancels the turn that is delivering the report.
        (await this.displacedRunBusy(run) ? live : settleable).push(run);
        continue;
      }
      if (classification.kind === 'superseded') {
        // A never-reporting run settles only by the superseded-idle rule:
        // the callback binding must prove it superseded, and its agent must
        // be freshly observed idle with the owned-tool and effect safeguards
        // passing. Anything else fences with its own reason.
        const binding = supersededIdleBinding(this.store, taskId, run);
        if (!binding.superseded) { fenced.push({ run, why: binding.why }); continue; }
        const fence = await this.engine.supersededIdleFence(run);
        if (fence) { fenced.push({ run, why: fence }); continue; }
        settleable.push(run);
        continue;
      }
      let state: Awaited<ReturnType<Adapter["observe"]>> | undefined;
      try { state = run.agentId ? await this.engine.host.observe(run.agentId) : undefined; } catch { state = undefined; }
      const observed = classifyVerbRun({ ...facts, observation: state ?? null });
      if (observed.kind === 'fence') fenced.push({ run, why: observed.why });
      else settleable.push(run);
    }
    return { settleable, fenced, live };
  }

  /**
   * Round 4: the durable side effect, if any, a verb must not act over when it
   * displaces this run — unknown delivery, a pending authenticated delivery or
   * a blocking recovery effect. Same rule as `durableRunFence` in `next`.
   */
  runDurableFence(task: Task, run: Run): string | null {
    return runSettlementFence({ store: this.store, task }, run);
  }

  /** Round 4: whether an owner verb cancelled this run's live turn (durable `owner_stop_sent`). */
  ownerCancelledRun(taskId: string, runId: string): boolean {
    return this.store.eventsAll(taskId).some(event => event.kind === "owner_stop_sent"
      && (() => { try { return JSON.parse(event.detail).runId === runId; } catch { return false; } })());
  }

  /**
   * Spec 050 admission for every owner control: the caller's version is current
   * when the store's only later writes were its own observations (see
   * `observation-advance`). A substantive write still refuses with the control's
   * own message, so a truly stale request names the read to repeat and nothing is
   * retried, resent or written.
   */
  requireOwnerControlCurrent(task: Task, version: number, refusal: string): void {
    if (!observationAdvanceSince(task, version)) throw Error(refusal);
  }

  /**
   * Round 4: refuse before any turn is cancelled when the task or its runs
   * changed while the verb was checking: a refused verb must stop nothing. A
   * lifecycle observation of the same task or run is not a change — the version
   * marker and the run's own observation timestamp say so — while any
   * substantive write, appearance, release, result, delivery or effect does.
   */
  assertUnchangedBeforeCancel(taskId: string, version: number, runs: readonly Run[]): void {
    this.engine.requireOwnerControlCurrent(this.store.task(taskId), version, "Task changed; refresh before retrying");
    if (!runsUnchangedSince(runs, this.store.runs(taskId))) throw Error("Task or run changed; refresh before retrying");
  }

  /**
   * The identity and liveness rule for settling or displacing a run.
   * Only a matching observation proves the participant: a run with no bound
   * agent, an unreadable observation, or an agent
   * observed under another identity or workspace is never settleable, because
   * Queue cannot show that this participant stopped. A matching idle, errored or
   * closed agent settles; a matching live turn is cancelled first and then
   * settles. No writes happen here.
   */
  async runDisposition(run: Run): Promise<'settle' | 'cancel' | { refusal: string }> {
    if (!run.agentId) return { refusal: 'it has no bound agent to observe' };
    let state: Awaited<ReturnType<Adapter["observe"]>>;
    try { state = await this.engine.host.observe(run.agentId); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { refusal: `its agent cannot be observed (${message})` };
    }
    if (!state || state.id !== run.agentId) return { refusal: 'the observed agent identity does not match the run' };
    if (state.workspaceId !== run.workspaceId) return { refusal: 'its agent was observed outside the run workspace' };
    if (!matchingInactiveParticipant(run, state)) return 'cancel';
    if (state.status !== 'closed' && Boolean(await this.engine.ownedToolHold(run.agentId, run.id, run.taskId))) return 'cancel';
    return 'settle';
  }

  /** Displacement uses the same positive participant observation as episode settlement. */
  async displacedRunBusy(run: Run): Promise<boolean> {
    const disposition = await this.runDisposition(run);
    if (typeof disposition === 'object') throw new DurableFenceRefusal(this.verbRunFenceRefusal({ run, why: disposition.refusal }));
    return disposition === 'cancel';
  }

  /**
   * Round 4: cancel the live turn of each displaced run, durably: the intent and
   * its outcome are recorded before and after Paseo's active-turn cancellation.
   * A cancellation that cannot be confirmed refuses the verb, which the owner
   * can simply retry; nothing else is written.
   */
  async cancelDisplacedTurns(taskId: string, runs: Array<Pick<Run, "id" | "taskId" | "agentId" | "workspaceId"> & { role: Run["role"] | "worker" }>, verb: string): Promise<void> {
    if (!runs.length) return;
    const cancel = this.adapter.stopAgentTurn;
    if (!cancel) throw Error("Paseo active-turn cancellation is unavailable, so Nucleus cannot stop the live run; retry once Paseo offers it");
    for (const run of runs) {
      const intent = { verb, runId: run.id, role: run.role, agentId: run.agentId, workspaceId: run.workspaceId,
        effectId: `ns-owner-stop-${digest(`${taskId}:${run.id}:${run.agentId ?? ""}`).slice(0, 32)}` };
      this.store.event(taskId, "owner_stop_intent", JSON.stringify({ ...intent, status: "intent" }));
      try { await cancel.call(this.adapter, run.agentId!); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.event(taskId, "owner_stop_uncertain", JSON.stringify({ ...intent, status: "uncertain", message: message.slice(0, 2000) }));
        throw Error(`Nucleus could not stop the live ${run.role} run (${run.id}): ${message}; retry the same verb`);
      }
      this.store.event(taskId, "owner_stop_sent", JSON.stringify({ ...intent, status: "sent" }));
    }
  }

  /** The owner-verb refusal for a finished run that still fences, with its own reason. Raised typed like `displaceRefusal`. */
  verbRunFenceRefusal(entry: { run: Run; why: string }): string {
    return `A ${entry.run.role} run (${entry.run.id}) still owns this task: ${entry.why}`;
  }

  /**
   * Round 4: the one refusal left when a verb displaces runs — a durable side
   * effect Queue will not act over blindly — and what clears it. Raised typed:
   * the fence is a read-only store projection, so the refusal proves nothing
   * was bound or sent and settles the control as refused, never uncertain.
   */
  displaceRefusal(entry: { run: Run; why: string }): string {
    return runFenceRefusal(entry.run, entry.why);
  }

  /**
   * Settle the armed verb fences inside the caller's transaction: the stale
   * incident, recovery episode and its pending accepted action (recorded as not
   * applied), reminders, carry, checkpoint intent and external-merge
   * pre-attention record supersede first (clearing the attention they raised),
   * then the named finished runs release through the reconciliation release path
   * — a recovery episode's pending accepted action is recorded as not applied on
   * the resolved episode. Caller owns the transaction; a refusal inside it rolls
   * both back.
   */
  settleVerbFences(taskId: string, settle: { detail: string; runIds: string[]; preserveEpisode?: boolean; displacedRunIds?: string[] }): void {
    // The authenticated report that requested this action is rechecked at the
    // commit boundary, after every asynchronous observation: work that moved or a
    // superseded owner/subject change since the coordinator was asked refuses the
    // report here instead of acting on newer work. Two callers in one transaction
    // see the same digest, since settlement leaves the work itself alone.
    if (this.coordinatorActionRunId.getStore() && !coordinatorReportMatches(this.store.task(taskId)))
      throw Error("The task moved on since the coordinator was asked (its results, head, phase, run or routes changed)");
    // The durable effect fences are rechecked at the settlement boundary: the
    // action's observations and cancellations are asynchronous, and an unknown
    // delivery or blocking effect recorded since then is never settled over.
    const boundary = this.store.task(taskId);
    for (const runId of [...settle.runIds, ...(settle.displacedRunIds ?? [])]) {
      const run = this.store.run(runId);
      if (!run || run.released) continue;
      const why = this.runDurableFence(boundary, run);
      if (why)
        throw new DurableFenceRefusal(this.displaceRefusal({ run, why }));
    }
    // Coordinator retry owns its episode and incident; only other run leases
    // settle before it applies the owner's retry in this same transaction.
    if (!settle.preserveEpisode) settleSupersededFencesInTx(this.store, taskId, settle.detail, now(), this.coordinatorActionRunId.getStore());
    this.releaseVerbFinishedRunIds(taskId, settle.runIds, settle.detail);
    // Round 4: runs the verb displaced (idle, or with their turn cancelled).
    // Where the ordinary release applies it is used, with its bookkeeping (a
    // recovery episode's pending action recorded as not applied, the recorded
    // completion released as finished); otherwise the run is superseded whatever
    // its binding said. Either way its late callbacks are stale.
    this.releaseDisplacedRunsInTx(taskId, settle.displacedRunIds ?? [], settle.detail);
  }

  /** Round 4: release the runs an owner verb displaced; see settleVerbFences. Caller owns the transaction. */
  releaseDisplacedRunsInTx(taskId: string, runIds: string[], detail: string): void {
    for (const id of runIds) {
      const run = this.store.run(id);
      if (!run || run.released) continue;
      if (run.completion) { this.releaseVerbFinishedRuns(taskId, [run], detail); continue; }
      if (supersededIdleBinding(this.store, taskId, run).superseded && supersedeIdleRunInTx(this.store, taskId, run, detail)) continue;
      supersedeDisplacedRunInTx(this.store, taskId, id, detail);
    }
  }

  releaseVerbFinishedRunIds(taskId: string, runIds: string[], notAppliedReason: string): void {
    this.releaseVerbFinishedRuns(taskId, runIds.map(id => this.store.run(id)).filter((run): run is Run => Boolean(run)), notAppliedReason);
  }

  /**
   * Release the pre-observed settleable runs inside the action's transaction,
   * through the reconciliation release path: recovery runs carry their episode
   * bookkeeping (a pending accepted action is recorded as not applied, an
   * escalated report records its escalation), every release records one event
   * naming the run, and the normal thread-archive path picks the binding up.
   * A settleable run with no recorded completion releases through the
   * superseded-idle settlement instead, with its history kept.
   */
  releaseVerbFinishedRuns(taskId: string, runs: Run[], notAppliedReason: string): void {
    for (const run of runs) {
      if (!run.completion) { supersedeIdleRunInTx(this.store, taskId, run, notAppliedReason); continue; }
      if (run.role === "recovery") { this.resolution.recovery.settleFinishedRun(this.store.task(taskId), run, notAppliedReason); continue; }
      releaseRunFromRecordedCompletion(this.store, taskId, run);
    }
  }

  rejectFenced(task: Task, action: string): void {
    if (isDispositionActive(task)) throw Error(`Disposition fence is active; ${action} is unavailable. Retry the recorded disposition instead.`);
  }
}

/**
 * The other settlement behind the name `settleVerbFences`: `Resolution`'s reviewer
 * continuation. It settles fences before the durable recheck, reads no async
 * context and refuses a run that stopped being superseded, so it stays separate
 * from `VerbFences.settleVerbFences`. `Resolution` keeps the old name as a delegate.
 */
export class ContinuationFences {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get recovery() { return this.resolution.recovery; }

  /**
   * Spec 050 (#3569): retire the fences an owner verb obsoletes, inside the
   * caller's transaction. Finished runs of other roles release through their
   * own bookkeeping (a recovery episode's accepted action is marked not applied
   * and its stale retry is never executed), and the stale incident, recovery
   * episode, reminders, carry and checkpoint intent are superseded with history
   * kept. A refused action rolls both back.
   */
  settleContinuationFences(taskId: string, settle: { detail: string; runIds: string[]; displacedRunIds?: string[] }): void {
    // Fences first: the settlement resolves the episode and clears the attention
    // it raised, so the strict re-gate after this sees the settled world.
    settleSupersededFencesInTx(this.store, taskId, `reviewer continuation: ${settle.detail}`);
    // The durable effect fences are rechecked at the settlement boundary: the
    // gates, verification and cancellation above are asynchronous, and an unknown
    // delivery or blocking effect recorded since then is never settled over
    // (review 5668722168).
    const boundary = this.store.task(taskId);
    for (const runId of [...settle.runIds, ...(settle.displacedRunIds ?? [])]) {
      const run = this.store.run(runId);
      if (!run || run.released) continue;
      const why = runSettlementFence({ store: this.store, task: boundary }, run);
      // Raised typed: the fence is a read-only store projection rechecked before
      // the action's own send, so the refusal settles the control as refused.
      if (why) throw new DurableFenceRefusal(runFenceRefusal(run, why));
    }
    // The episode's own run is settled by the transition that resolves it: a
    // reported run releases with its report, and a run the verb displaced (its
    // turn already cancelled or observed idle) releases whatever its binding
    // said, as every other owner verb's displacement does.
    for (const runId of settle.runIds) {
      const run = this.store.runs(taskId).find(item => item.id === runId);
      if (!run || run.released) continue;
      if (!run.completion) {
        if (!supersedeIdleRunInTx(this.store, taskId, run, settle.detail))
          throw new Error('The observed run is no longer superseded; refresh before continuing');
        continue;
      }
      if (run.role === 'recovery') { this.recovery.settleFinishedRun(this.store.task(taskId), run, settle.detail); continue; }
      releaseRunFromRecordedCompletion(this.store, taskId, run);
    }
    for (const runId of settle.displacedRunIds ?? []) {
      const run = this.store.run(runId);
      if (!run || run.released) continue;
      if (run.role === 'recovery' && run.completion) { this.recovery.settleFinishedRun(this.store.task(taskId), run, settle.detail); continue; }
      supersedeDisplacedRunInTx(this.store, taskId, runId, settle.detail);
    }
  }
}
