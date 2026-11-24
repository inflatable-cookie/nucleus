import {
  assignedThreadWaitReason,
  coordinative,
} from "../recovery/task-reasons";
import { executionParticipants } from "../machine/execution-participants";
import { participantTemporaryDirectory } from "../machine/participant-roots";
import {
  participantRuntime,
  storeDataHome,
} from "../machine/participant-runtime";
import {
  incompleteRunProcessScan,
  readRunProcessCustody,
} from "../machine/run-process-custody";
import {
  runBindsCurrentWork,
  type Run,
  type Task,
} from "../../shared/contracts";
import { isStaleIntegrationBaseRefusal } from "../hooks/hooks";
import { agentSettled } from "../machine/agent-settled";
import { isAgentGoneRefusal } from "../host/errors";
import type { Adapter } from "../host/adapter";
import type { HostProcessTable } from "../host/types";
import type { Resolution } from "../resolution";
import { noTurnLive, workspaceToolProcessIssue } from "../recovery/stall";
import { participantToolRunIds } from "../recovery/task-reasons/participants";
import {
  QUANTUM_READ_DEADLINE_MS,
  boundedRead,
} from "../scheduling/pass-snapshot";

/** Proves a task's participants are settled before its work, merge or closeout goes on. */
export class ParticipantLease {
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }

  async idle(
    agentId: string,
    workspaceId?: string,
    onBusy?: (state: Awaited<ReturnType<Adapter["observe"]>>) => void,
  ) {
    const read = await boundedRead(
      "participant observation",
      () => this.resolution.host.observe(agentId),
      this.resolution.quantumReadTimeoutMs ?? QUANTUM_READ_DEADLINE_MS,
    );
    if (read.state === "unknown") return false;
    const state = read.value;
    if (workspaceId && state.workspaceId !== workspaceId)
      throw new Error("Agent workspace changed; lease is not safe");
    const idle = agentSettled(state);
    if (!idle) onBusy?.(state);
    return idle;
  }
  /**
   * Lease proof over the identities that still own work (Spec 013). A released
   * historical reviewer, revision, recovery, verification or closeout run is
   * audit history: an ordinary lease check does not poll it. Only the current
   * worker and reviewer, an assigned coordinator, unreleased runs and any
   * identity named by a persisted uncertainty require fresh proof.
   *
   * A run whose authenticated completion is already recorded is finished work
   * for the same reason (nucleus#1100): its turn is over, so its agent is not a
   * live participant a new dispatch waits on, whatever release bookkeeping still
   * pends on the run row. What remains uncertain about it — a durable delivery
   * or effect, an episode's pending action, a corrected result — is fenced by
   * the paths that record visible waits (the review-dispatch effect fence,
   * `runDurableFence` in owner verbs, the episode's own observation), never by
   * this liveness read.
   */
  async lease(
    t: Task,
    onBusy?: (
      agentId: string,
      state: Awaited<ReturnType<Adapter["observe"]>>,
    ) => void,
    supersededRunId?: string,
  ) {
    const runs = this.store.runs(t.id);
    // Expected workspace per identity; null means the identity has no recorded
    // workspace yet, so its idle proof is not workspace-constrained.
    const expected = new Map<string, string | null>();
    const record = (
      id: string | null | undefined,
      workspace: string | null | undefined,
    ) => {
      if (!id) return;
      const current = expected.get(id);
      if (current === undefined || current === null)
        expected.set(id, workspace ?? null);
    };
    const currentRun =
      t.resolution.currentRunId && t.resolution.currentRunId !== supersededRunId
        ? runs.find((r) => r.id === t.resolution.currentRunId)
        : null;
    // The retained worker lives in the task workspace. An assigned coordinator or
    // reviewer enters this set through its own run, so a coordinator that has not
    // been launched yet is bound by the launcher instead of polled here.
    record(t.agentId, t.workspaceId);
    record(currentRun?.agentId, currentRun?.workspaceId ?? t.workspaceId);
    for (const run of runs) {
      if (run.released || run.completion || run.id === supersededRunId)
        continue;
      record(run.agentId, run.workspaceId ?? t.workspaceId);
    }
    // A persisted incident or recovery episode names the exact run whose result
    // is still uncertain, so that identity keeps its live proof — while the run
    // still binds the current work. A record naming a released run is
    // superseded history and never adds a participant the current work must
    // wait for (papercuts 89643af2, 6ff5e903).
    for (const runId of [
      t.resolution.recovery?.runId,
      t.resolution.incident?.runId,
    ]) {
      if (runId && runId === supersededRunId) continue;
      if (!runBindsCurrentWork(runs, runId)) continue;
      const named = runId ? runs.find((r) => r.id === runId) : null;
      if (named?.completion) continue;
      record(named?.agentId, named?.workspaceId);
    }
    for (const [id, workspace] of expected) {
      const proofWorkspace = workspace ?? t.workspaceId!;
      try {
        if (
          !(await this.resolution.idle(id, workspace ?? undefined, (state) =>
            onBusy?.(id, state),
          ))
        )
          return false;
      } catch (error) {
        // A thread the host reports gone is not a participant any more, but only
        // an already-merged task whose workspace still exists may pass on that
        // fact; anything else keeps its own fault.
        if (!isAgentGoneRefusal(error) || !t.resolution.mergedCommit)
          throw error;
        if (
          !this.adapter.workspaceAvailable ||
          (await this.adapter.workspaceAvailable(proofWorkspace))
        )
          throw error;
      }
    }
    return true;
  }
  /**
   * The run on this task that binds a lease participant's identity, for the
   * decline text: the current run, else the recovery or incident episode's
   * run, else the latest unreleased unfinished run of that agent. Null when
   * only the task row binds the identity (the retained worker). Read-only.
   */
  participantBinding(t: Task, agentId: string): Run | null {
    const runs = this.store.runs(t.id);
    const current = t.resolution.currentRunId
      ? runs.find(
          (run) =>
            run.id === t.resolution.currentRunId && run.agentId === agentId,
        )
      : null;
    const episode =
      [t.resolution.recovery?.runId, t.resolution.incident?.runId]
        .map((id) => (id ? runs.find((run) => run.id === id) : null))
        .find((run) => run && run.agentId === agentId) ?? null;
    const latest =
      runs.findLast(
        (run) => !run.released && !run.completion && run.agentId === agentId,
      ) ?? null;
    return current ?? episode ?? latest;
  }

  /**
   * The one visible sentence for a lease decline, shared by the dispatch wait
   * and by the accepting verb's reply (nucleus#1100): the participant that
   * still owns work, what the observation shows, and the owner verbs that exit
   * the wait — so a launch that starts nothing never reads as silent success.
   */
  declineText(
    t: Task,
    agentId: string,
    state: Awaited<ReturnType<Adapter["observe"]>>,
  ): string {
    const run = this.participantBinding(t, agentId);
    const owner = run ? `${run.role} run ${run.id}` : "the retained worker";
    // The exits name verbs that actually clear the hold: `restart
    // role=coordinator` settles only finished runs and refuses while the run is
    // unreleased, so a live coordinator turn is stopped or routed now; a live
    // reader or revision turn is stopped or routed the same way.
    const exit = run
      ? coordinative(run)
        ? `stop role=coordinator settles it sooner (it stops that turn), or route role=coordinator with now`
        : `an owner stop of run ${run.id}, or a route with now, settles it sooner`
      : "an owner restart or route with now settles it sooner";
    return `${owner} (agent ${agentId}) still owns its turn: ${assignedThreadWaitReason(state)}; the dispatch proceeds once that thread settles, ${exit}`;
  }

  /**
   * The first recorded participant a launch's lease would decline, named with
   * `declineText`; null when the lease passes or a read fails (an unreadable
   * participant proves nothing here — the launch itself records its own fault).
   * The accepting review verbs probe this so their reply names a launch fence
   * the way `unreleasedLaunchFence` already does.
   */
  async declineReason(t: Task): Promise<string | null> {
    const captured: {
      agentId: string;
      state: Awaited<ReturnType<Adapter["observe"]>>;
    }[] = [];
    let passed: boolean;
    try {
      passed = await this.lease(t, (agentId, state) =>
        captured.push({ agentId, state }),
      );
    } catch {
      return null;
    }
    const declined = passed ? undefined : captured[0];
    if (!declined) return null;
    return this.declineText(t, declined.agentId, declined.state);
  }

  refreshingCloseoutHook(t: Task, syncing: boolean) {
    return syncing && t.reasonFact?.code === "closeout_base_refresh"
      ? this.store
          .hookEvents(t.id)
          .findLast(
            (record) =>
              record.event === "task.closeout" &&
              record.state === "blocked" &&
              isStaleIntegrationBaseRefusal(record.error),
          )
      : undefined;
  }
  /**
   * Check the exact participant roster and process custody on hosts that support it.
   * Review launch does not use this check.
   */
  async exactCustodyIssue(
    task: Task,
    agentId: string,
    workspaceId: string,
    options: { direct?: boolean; directFallback?: boolean } = {},
  ): Promise<string | null> {
    const deadline =
      this.resolution.quantumReadTimeoutMs ?? QUANTUM_READ_DEADLINE_MS;
    const observe = await boundedRead(
      "exact participant observation",
      () => this.resolution.host.observeParticipant(agentId),
      deadline,
    );
    if (observe.state === "unknown") return observe.reason;
    const state = observe.value;
    if (!state || state.id !== agentId || state.workspaceId !== workspaceId)
      return "the exact participant or its workspace could not be read";
    if (!noTurnLive(state))
      return "the participant has an active turn, pending permission or unsettled state";
    if (state.pendingBackgroundTasks.length)
      return `the provider reports outstanding background work: ${state.pendingBackgroundTasks.join(", ")}`;
    const { hostProcessListing, noLiveWorkspaceProcesses } = this.adapter;
    if (!hostProcessListing || !noLiveWorkspaceProcesses)
      return "the host cannot check workspace and run processes";

    const runs = this.store.runs(task.id);
    const runIds = participantToolRunIds(task, runs, agentId, workspaceId);
    if (!runIds.length) return "the participant has no recorded run";
    const roots = new Set(
      runIds.map((id) => participantTemporaryDirectory(task, runs, id)),
    );
    if (roots.has(undefined))
      return "a participant run temporary directory is unrecorded";

    const readScan = (direct: boolean | undefined) =>
      this.resolution.readPassProcesses(task.hostId, {
        participant: { agentId, observation: state },
        direct,
      });
    let scan = await readScan(options.direct);
    for (;;) {
      if (scan.state === "unknown") return scan.reason;
      const complete =
        scan.cwdComplete ?? (scan.processes as HostProcessTable).cwdComplete;
      if (complete !== true)
        return "the host process listing has incomplete working-directory coverage";
      if (incompleteRunProcessScan(scan))
        return "the host process listing has incomplete working-directory or open-file coverage";
      if (!scan.fromPassSnapshot) break;
      const beforeScan =
        scan.directBeforeScan === undefined
          ? this.resolution.passObservedBeforeProcesses(task.hostId, agentId)
          : scan.directBeforeScan;
      const observedAt = Date.parse(state.updatedAt ?? "");
      if (
        Number.isFinite(observedAt) &&
        observedAt <= scan.capturedAt &&
        noTurnLive(beforeScan) &&
        beforeScan?.updatedAt === state.updatedAt
      )
        break;
      // The pass snapshot predates this participant's latest inactivity, and a
      // later pass may never line up with it. A fresh listing taken after the
      // exact inactivity read above covers it by construction, as owner
      // completion does (#1564). Merge and closeout take that one listing.
      if (!options.directFallback) {
        this.resolution.requestPassProof(task.hostId, agentId);
        return "the process listing does not cover the participant's latest inactivity";
      }
      scan = await readScan(true);
      options = { ...options, directFallback: false };
    }

    const runtime = participantRuntime({
      dataHome: storeDataHome(this.store),
      tasks: [task],
      runs,
    });
    const workspace = await boundedRead(
      "workspace process probe",
      () =>
        noLiveWorkspaceProcesses.call(
          this.adapter,
          workspaceId,
          runIds,
          runtime,
          scan.processes,
        ),
      deadline,
    );
    if (workspace.state === "unknown") return workspace.reason;
    if (workspace.value !== null)
      return (
        workspace.value || "the workspace process probe returned no result"
      );
    for (const root of roots) {
      const issue = workspaceToolProcessIssue(
        scan.processes,
        root!,
        runIds,
        runtime,
      );
      if (issue) return issue;
    }
    for (const runId of runIds) {
      // The same listing also proves custody for provider descendants that
      // have moved out of the workspace and scratch trees.
      const custody = await readRunProcessCustody({
        store: this.store,
        readProcesses: async () => scan,
        task,
        runId,
        run: runs.find((run) => run.id === runId),
      });
      if (custody.state === "unknown") return custody.reason;
      if (custody.state === "live")
        return `process ${custody.process.pid} still holds custody for run ${runId}`;
    }
    return null;
  }

  /** Merge and closeout observe execution bindings, including retained runs. */
  async executionLease(
    t: Task,
    syncing = false,
    probe = false,
  ): Promise<boolean> {
    const runs = this.store.runs(t.id);
    for (const [id, workspace] of executionParticipants(t, runs)) {
      // The owner explicitly superseded these exact identities to close an already merged PR.
      if (
        syncing &&
        t.resolution.externalMerge &&
        t.resolution.mergedCommit &&
        t.resolution.ownerCloseoutParticipants.some(
          (item) => item.agentId === id && item.workspaceId === workspace,
        )
      )
        continue;
      let state: Awaited<ReturnType<Adapter["observe"]>> | undefined;
      try {
        if (this.adapter.observeParticipant) {
          const issue = await this.exactCustodyIssue(t, id, workspace, {
            directFallback: true,
          });
          if (!issue) continue;
          if (!probe)
            this.resolution.waiting(
              t,
              `Merge waits for participant ${id} in workspace ${workspace}: ${issue}`,
              "lifecycle",
            );
          return false;
        }
        const read = await boundedRead(
          "participant observation",
          () => this.resolution.host.observe(id),
          this.resolution.quantumReadTimeoutMs ?? QUANTUM_READ_DEADLINE_MS,
        );
        if (read.state === "unknown") {
          if (!probe)
            this.store.update(t.id, {
              reason: `Merge waits for participant ${id} in workspace ${workspace}: ${read.reason}`,
            });
          return false;
        }
        state = read.value;
      } catch (error) {
        if (!this.adapter.observeParticipant && isAgentGoneRefusal(error))
          continue;
        if (!probe)
          this.resolution.waiting(
            t,
            `Merge waits for participant ${id}: ${error instanceof Error ? error.message : String(error)}`,
            "lifecycle",
          );
        return false;
      }
      if (state.id !== id || state.workspaceId !== workspace) {
        if (!probe)
          this.resolution.waiting(
            t,
            `Merge waits for participant ${id} in workspace ${workspace}: current identity, activity or status does not prove it is settled`,
            "lifecycle",
          );
        return false;
      }
      if (
        (!agentSettled(state) && state.status !== "gone") ||
        state.active ||
        state.permissions ||
        state.activeTurnId
      ) {
        if (!probe)
          this.resolution.waiting(
            t,
            `Merge waits for participant ${id} in workspace ${workspace}: ${assignedThreadWaitReason(state)}`,
            "lifecycle",
          );
        return false;
      }
    }
    return true;
  }
}
