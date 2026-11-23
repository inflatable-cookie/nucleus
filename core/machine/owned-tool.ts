import {
  observeRunningTool,
  recordActivityTool,
} from "../telemetry/task-activity-observation";
import type { Run, Task } from "../../shared/contracts";
import { isTransportFailure } from "../../shared/transport";
import { agentSettled } from "./agent-settled";
import { boundedToolHold } from "./bounded-tool";
import { custodyProofDeferral, requireCustodyEvidence } from "./custody-proof";
import {
  bbThreadForAgent,
  bbWorkspaceThreads,
  ownedToolAgentProcessTreeVerdict,
} from "./owned-tool-process-proof";
import { readHostUidProcesses } from "./host-process-listing";
import { participantRuntime, storeDataHome } from "./participant-runtime";
import { participantTemporaryDirectory } from "./participant-roots";
import { HostTransportFault } from "../host/adapter-routing";
import {
  HostReadRefusalError,
  isAgentGoneRefusal,
  isHostOperationTimeout,
} from "../host/errors";
import type { Resolution } from "../resolution";
import {
  formatLiveToolIssue,
  INTERRUPTED_TOOL_STATUSES,
  liveToolIssueFact,
  noTurnLive,
  observedTurnState,
  readToolTimeline,
  runningOwnedTool,
  turnBoundTool,
  workspaceToolProcessIssue,
  type ObservedTurnState,
  type OwnedToolHoldResult,
  type TimelineEntry,
} from "../recovery/stall";
import type { HostProcessFact } from "../host/types";
import {
  DeferredPassReadError,
  PASS_PROCESS_READ_DEADLINE_MS,
  QUANTUM_READ_DEADLINE_MS,
  boundedRead,
  isTerminalParticipant,
  type PassProcessRead,
  type PassTimelinePageRead,
} from "../scheduling/pass-snapshot";

export type { OwnedToolHoldResult } from "../recovery/stall";

/** The owned-tool events this proof reads and writes. */
const OWNED_TOOL_HOLD = "owned_tool_hold";
const OWNED_TOOL_SETTLED = "owned_tool_settled";

/**
 * The owned-tool proof: no live tool holds a run.
 *
 * The decision is made on typed facts. The tool timeline reader answers with
 * entries or an issue; `liveToolIssueFact` names the exact fact that refuses
 * (a live non-turn-bound call, a conflicting identity, an unreadable state);
 * the process-tree proof answers empty, live or unknown with its own reason
 * code. The event history is decoded once per run id, not re-parsed per call.
 */
export class OwnedTools {
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  private get readDeadlineMs(): number {
    return this.resolution.quantumReadTimeoutMs ?? QUANTUM_READ_DEADLINE_MS;
  }
  private get processDeadlineMs(): number {
    return (
      this.resolution.passProcessReadTimeoutMs ?? PASS_PROCESS_READ_DEADLINE_MS
    );
  }
  private timelineHost(
    hostId?: string | null,
    onRead?: (read: PassTimelinePageRead) => void,
    deadlineMs?: number,
  ) {
    return {
      agentTimelinePage: async (id: string, limit?: number) => {
        if (!this.resolution.readPassTimelinePage)
          return requireCustodyEvidence(
            await this.resolution.host.agentTimelinePage(id, limit),
            "the agent timeline page",
          );
        const read = await this.resolution.readPassTimelinePage(
          id,
          limit,
          hostId,
          deadlineMs ?? this.readDeadlineMs,
          { requireCoveredObservation: true },
        );
        onRead?.(read);
        // This proof reads the pass's page: the next host pass warms it first,
        // so a page the rotation skips is never missed two passes running.
        this.resolution.requestPassProof?.(hostId, id, "owned-tools");
        if (read.state === "unknown")
          throw new DeferredPassReadError(read.reason);
        return requireCustodyEvidence(read.value, "the agent timeline page");
      },
    };
  }
  private async readProcesses(
    hostId?: string | null,
  ): Promise<PassProcessRead> {
    if (this.resolution.readPassProcesses) {
      return this.resolution.readPassProcesses(hostId);
    }
    const capturedAt = Date.now();
    if (this.adapter.hostProcessListing) {
      const read = await boundedRead(
        "host process listing",
        async () => requireCustodyEvidence(
          await this.adapter.hostProcessListing!(),
          "the host process listing",
        ),
        this.processDeadlineMs,
      ).catch((error) => {
        const deferred = custodyProofDeferral({ kind: "error", error });
        return deferred
          ? { state: "unknown" as const, reason: deferred.reason, deferred: true }
          : {
              state: "unknown" as const,
              reason: "failed",
              deferred: false,
            };
      });
      if (read.state === "ok") {
        return {
          state: "listed",
          processes: read.value,
          capturedAt,
          fromPassSnapshot: false,
        };
      }
      return {
        state: "unknown",
        reason: read.reason,
        capturedAt,
        fromPassSnapshot: false,
        deferred: "deferred" in read ? read.deferred : true,
      };
    }
    const listing = await readHostUidProcesses({
      deadlineMs: this.processDeadlineMs,
    });
    return { ...listing, capturedAt, fromPassSnapshot: false };
  }

  /**
   * Whether a pass-scoped process snapshot predates the participant inactivity
   * or tool evidence it is being asked to clear (Spec 068 §6).
   *
   * An inline read (`!fromPassSnapshot`) is taken after the tool and turn
   * observations and always covers them. A pass snapshot taken during HostPass
   * may clear a live tool hold ONLY if:
   * - no observed tool entry timestamp is newer than `capturedAt`, AND
   * - the host pass's pre-process observation already proved the participant
   *   inactive (`noTurnLive`, `closed`, `gone`, or `archived`) BEFORE the
   *   process table was captured, AND
   * - the participant's `updatedAt` has not advanced past `capturedAt` or
   *   changed since that pre-process observation.
   */
  private processProofDeferral(
    read: PassProcessRead,
    hostId: string | null | undefined,
    agentId: string,
    turn?: ObservedTurnState | null,
    entries?: TimelineEntry[],
  ) {
    // This proof reads the pass's process snapshot: ask the next host pass to
    // observe the participant before its snapshot, so the freshness rule can
    // hold there. The demand renews on every use and expires once unused.
    if (read.fromPassSnapshot) this.resolution.requestPassProof?.(hostId, agentId);
    return custodyProofDeferral({
      kind: "processes",
      scan: read,
      participant: turn,
      beforeScan: read.fromPassSnapshot
        ? this.resolution.passObservedBeforeProcesses?.(hostId, agentId)
        : null,
      entries,
    });
  }

  private proofReadError(
    error: unknown,
    hostId: string | null | undefined,
    agentId: string,
  ) {
    const deferred = custodyProofDeferral({ kind: "error", error });
    if (deferred) this.resolution.requestPassProof?.(hostId, agentId);
    return deferred;
  }

  /**
   * The agent's own long-running job, as one readable reason, or null.
   *
   * A stopped thread whose provider timeline still shows its own non-turn-bound
   * tool running is waiting on that job, not a missing callback. This is the
   * reading half of the owned-tool proof: it never settles anything and never
   * reads absent, unreadable or inconclusive evidence as a live job.
   */
  async ownedJobWait(
    agentId: string,
    binding?: { taskId: string; runId: string },
  ): Promise<string | null> {
    if (!this.adapter.agentTimelinePage) return null;
    let read: Awaited<ReturnType<typeof readToolTimeline>>;
    try {
      read = await readToolTimeline(
        this.timelineHost(),
        agentId,
        this.readDeadlineMs,
      );
    } catch {
      return null;
    }
    if (read.kind !== "ok") return null;
    if (binding)
      recordActivityTool(
        this.store,
        binding.taskId,
        binding.runId,
        agentId,
        null,
        observeRunningTool(
          read.entries,
          null,
          (entry) => !turnBoundTool(entry),
        ),
      );
    const running = runningOwnedTool(read.entries);
    return running
      ? `${running.name} (${running.kind}) has been running since ${running.since}`
      : null;
  }

  /**
   * Prove that no tool holds the participant's custody. A deferred timeline
   * page can be replaced by an exact, idle participant observation with an
   * empty background roster and a covering process scan.
   *
   * Liveness, not history: a running entry is settled once the same agent's own
   * fresh observation proves no turn is live and the call's kind cannot outlive
   * its turn. Any other running kind needs the same run-rooted host process
   * proof; if the provider process is absent, a complete no-ticket/no-workspace
   * scan can prove it stale. Worktree setups, unknown kinds and unreadable
   * observations hold without that proof. Once that observation proves no turn
   * is live, the provider's own standing tool runtimes are not descendants for
   * the proof either — they outlive every turn by design — while a command one
   * of them spawned still counts as work.
   */
  async ownedToolHold(
    agentId: string,
    options: {
      requireCompleteEvidence?: boolean;
      allowRetired?: boolean;
      runId?: string;
      runIds?: string[];
      taskId?: string;
      workspaceId?: string;
      deadlineAt?: number;
    } = {},
  ): Promise<OwnedToolHoldResult> {
    const remainingMs = (): number =>
      options.deadlineAt !== undefined
        ? Math.min(
            this.readDeadlineMs,
            Math.max(0, options.deadlineAt - Date.now()),
          )
        : this.readDeadlineMs;
    const task = options.taskId ? this.store.task(options.taskId) : null;
    const taskRuns = task ? this.store.runs(task.id) : [];
    const boundRun = options.runId ? this.store.run(options.runId) : null;
    const hostId = boundRun?.hostId ?? task?.hostId;
    const runIds = options.runIds?.length
      ? options.runIds
      : options.runId
        ? [options.runId]
        : [];
    const workspaceId =
      options.workspaceId ??
      boundRun?.workspaceId ??
      (task?.agentId === agentId ? task.workspaceId : undefined) ??
      undefined;
    const verifyProcesses = (
      turn?: ObservedTurnState | null,
      entries?: TimelineEntry[],
    ) =>
      this.verifyOwnedWorkspaceAndScratchProcesses(
        agentId,
        task,
        taskRuns,
        runIds,
        workspaceId,
        options.runId,
        turn,
        entries,
        remainingMs(),
      );
    const prior = this.resolution.passObservedBeforeProcesses?.(hostId, agentId);
    const terminalBinding =
      workspaceId &&
      prior?.id === agentId &&
      prior.workspaceId === workspaceId &&
      isTerminalParticipant(prior);
    if (options.allowRetired || terminalBinding) {
      const custody = await this.classifyRetiredCustody(
        agentId,
        workspaceId,
        remainingMs(),
      );
      if (custody.kind === "deferred") {
        this.resolution.requestPassProof?.(hostId, agentId);
        return { kind: "deferred", reason: custody.reason };
      }
      if (custody.kind === "refuse")
        return { kind: "hold", reason: custody.reason };
      if (custody.kind === "retired" || custody.kind === "gone") {
        if (
          this.adapter.noLiveWorkspaceProcesses &&
          this.adapter.hostProcessListing
        ) {
          const processResult = await verifyProcesses(custody.observation);
          if (processResult.kind === "deferred") return processResult;
          if (
            processResult.kind === "hold" &&
            task &&
            options.runId &&
            this.acceptOwnedToolHold(
              task.id,
              options.runId,
              processResult.reason,
            )
          )
            return { kind: "clear" };
          if (processResult.kind === "clear" && task)
            for (const runId of runIds)
              this.recordOwnedToolSettlement(
                task.id,
                runId,
                `retired participant (${custody.kind}), workspace inactivity and owned-process observations are clear`,
              );
          return processResult;
        }
        if (custody.kind === "gone")
          return {
            kind: "hold",
            reason: "owned workspace or run process identity is unavailable",
          };
      }
    }
    if (!this.adapter.agentTimelinePage)
      return options.requireCompleteEvidence
        ? {
            kind: "hold",
            reason:
              "owned tool evidence is unavailable: this adapter offers no tool timeline",
          }
        : { kind: "clear" };
    let read: Awaited<ReturnType<typeof readToolTimeline>>;
    const timeline: { page?: PassTimelinePageRead } = {};
    try {
      const timelineDeadlineMs = remainingMs();
      read = await readToolTimeline(
        this.timelineHost(
          hostId,
          (pageRead) => {
            timeline.page = pageRead;
          },
          timelineDeadlineMs,
        ),
        agentId,
        timelineDeadlineMs,
      );
    } catch (error) {
      const deferred = this.proofReadError(error, hostId, agentId);
      if (deferred) read = deferred;
      else if (
        error instanceof HostReadRefusalError ||
        isTransportFailure(error) ||
        isHostOperationTimeout(error) ||
        error instanceof HostTransportFault
      )
        throw error;
      else return { kind: "hold", reason: "owned tool evidence is unreadable" };
    }
    if (read.kind === "hold" && read.transientError) {
      const deferred = this.proofReadError(read.transientError, hostId, agentId);
      if (!deferred) throw read.transientError;
      read = deferred;
    }
    if (read.kind === "deferred") {
      if (!workspaceId || !this.adapter.observeParticipant) return read;
      const exact = await boundedRead(
        "exact participant observation",
        () => this.resolution.host.observeParticipant(agentId),
        remainingMs(),
      ).catch(() => null);
      const state = exact?.state === "ok" ? exact.value : null;
      if (!state || state.id !== agentId || state.workspaceId !== workspaceId)
        return read;
      if (state.active || state.activeTurnId || state.permissions)
        return {
          kind: "hold",
          reason: "an owned tool is still live: participant has an active run or pending runtime request",
        };
      if (state.pendingBackgroundTasks.length)
        return {
          kind: "hold",
          reason: `an owned tool is still live: provider reports outstanding background work: ${state.pendingBackgroundTasks.join(", ")}`,
        };
      if (!noTurnLive(state)) return read;
      const proof = await verifyProcesses(state);
      if (proof.kind === "clear" && task)
        for (const runId of runIds)
          this.recordOwnedToolSettlement(
            task.id,
            runId,
            "exact participant inactivity, empty background roster and owned-process observations are clear",
          );
      return proof;
    }
    const emptyPage =
      read.kind === "ok" && read.coverage !== "bounded" &&
      !liveToolIssueFact(read.entries);
    const page = timeline.page;
    const cachedPage =
      page?.state === "ok" && page.value !== null && page.fromPassSnapshot
        ? page
        : null;
    const turnRead =
      cachedPage || (read.kind === "ok" && !emptyPage)
      ? await observedTurnState(this.resolution.host, agentId, remainingMs())
      : null;
    if (turnRead?.kind === "deferred") return turnRead;
    if (turnRead?.kind === "unavailable") {
      const deferred = this.proofReadError(turnRead.error, hostId, agentId);
      if (deferred) return deferred;
      if (
        read.kind === "ok" && read.coverage === "bounded" &&
        (isTransportFailure(turnRead.error) || isHostOperationTimeout(turnRead.error) ||
          turnRead.error instanceof HostTransportFault)
      )
        throw turnRead.error;
    }
    const turn = turnRead?.kind === "observed" ? turnRead.state : null;
    if (cachedPage) {
      const deferred = custodyProofDeferral({
        kind: "timeline",
        page: cachedPage,
        participant: turn,
        requiresInactivity: emptyPage,
      });
      if (deferred) return deferred;
    }
    if (read.kind === "hold") {
      return {
        kind: "hold",
        reason: `owned tool evidence is inconclusive: ${read.reason}`,
      };
    }
    if (read.coverage === "bounded") {
      const hold = await boundedToolHold(
        read,
        { observe: async () => turn },
        agentId,
        workspaceId,
        (observed) => verifyProcesses(observed, read.entries),
        remainingMs(),
      );
      if (hold.kind === "deferred") return hold;
      if (
        hold.kind === "hold" &&
        task &&
        options.runId &&
        this.acceptOwnedToolHold(task.id, options.runId, hold.reason)
      )
        return { kind: "clear" };
      if (hold.kind === "clear" && task)
        for (const runId of runIds)
          this.recordOwnedToolSettlement(
            task.id,
            runId,
            "bounded tool window, participant inactivity and owned-process observations are clear",
          );
      return hold;
    }
    if (emptyPage) {
      if (options.taskId)
        for (const runId of runIds)
          this.recordOwnedToolSettlement(
            options.taskId,
            runId,
            "complete tool timeline has no live or unknown calls",
          );
      return { kind: "clear" };
    }
    const issue = liveToolIssueFact(read.entries, turn);
    let hold = issue ? formatLiveToolIssue(issue) : null;
    const processEntries = read.entries.filter(
      (entry) => entry.item.type === "tool_call" && !turnBoundTool(entry),
    );
    const processIssue = liveToolIssueFact(processEntries, turn);
    // A call that is still running or was interrupted with its turn, and is not
    // turn-bound, is the only shape the process tree can settle; a turn-bound
    // call never outlives its turn.
    const processOwnsWork =
      (processIssue?.kind === "live" &&
        (processIssue.status === "running" ||
          INTERRUPTED_TOOL_STATUSES.has(processIssue.status))) ||
      (processIssue?.kind === "conflicting-identity" && processIssue.running);
    const turnBoundOnly = read.entries.filter(
      (entry) => !processEntries.includes(entry),
    );
    if (
      hold &&
      runIds.length &&
      options.taskId &&
      noTurnLive(turn) &&
      processIssue &&
      processOwnsWork &&
      liveToolIssueFact(turnBoundOnly, turn) === null
    ) {
      const toolLabel = formatLiveToolIssue(processIssue);
      const boundRun = options.runId ? this.store.run(options.runId) : null;
      const task = this.store.task(options.taskId);
      const processHostId = boundRun?.hostId ?? task.hostId;
      const processRead = await this.readProcesses(processHostId);
      const deferred = this.processProofDeferral(
        processRead, processHostId, agentId, turn, read.entries,
      );
      if (deferred) return { ...deferred, reason: `${toolLabel}; ${deferred.reason}` };
      const processes =
        processRead.state === "listed" ? processRead.processes : null;
      const bbThread = bbThreadForAgent(agentId, processHostId);
      const runtime = participantRuntime({
        dataHome: storeDataHome(this.store),
        tasks: [task],
        runs: this.store.runs(task.id),
        bbThreads: bbThread ? [bbThread] : [],
      });
      const verdict = ownedToolAgentProcessTreeVerdict(runIds, processes, {
        noTurnLive: true,
        runtime,
      });
      if (verdict.state === "empty") {
        const heldRunId = options.runId ?? verdict.runId;
        this.recordOwnedToolSettlement(
          options.taskId,
          heldRunId,
          `run ${heldRunId}: stale non-turn-bound tool settled; agent helper run ${verdict.runId} proves provider pid ${verdict.providerPid} has no live descendants except Nucleus MCP report helper pid ${verdict.helperPid}`,
          true,
        );
        hold = null;
      } else if (verdict.state === "live") {
        hold = `${toolLabel}; descendant pid ${verdict.pid} remains under provider pid ${verdict.providerPid}`;
      } else if (
        verdict.code === "helper-missing" &&
        options.workspaceId &&
        this.adapter.noLiveWorkspaceProcesses
      ) {
        const workspaceRead = await this.workspaceProcessProof(
          options.workspaceId, runIds, runtime, processes, processHostId,
          agentId, remainingMs(),
        );
        if (workspaceRead.kind === "deferred")
          return { ...workspaceRead, reason: `${toolLabel}; ${workspaceRead.reason}` };
        if (workspaceRead.kind === "clear") {
          this.recordOwnedToolSettlement(
            options.taskId,
            runIds[0]!,
            `run ids ${runIds.join(", ")}: stale non-turn-bound tool settled; no process carried an MCP ticket and the task workspace process tree was empty`,
            true,
          );
          hold = null;
        } else hold = `${toolLabel}; ${workspaceRead.reason}`;
      } else
        hold = `${toolLabel}; process tree is unreadable: ${verdict.reason}`;
    }
    if (
      hold &&
      options.runId &&
      options.taskId &&
      this.acceptOwnedToolHold(options.taskId, options.runId, hold)
    )
      return { kind: "clear" };
    if (!hold && options.taskId)
      for (const runId of runIds)
        this.recordOwnedToolSettlement(
          options.taskId,
          runId,
          "fresh tool and owner observations prove the recorded hold settled",
        );
    return hold
      ? { kind: "hold", reason: `an owned tool is still live: ${hold}` }
      : { kind: "clear" };
  }

  private async classifyRetiredCustody(
    agentId: string,
    workspaceId: string | undefined,
    deadlineMs: number = this.readDeadlineMs,
  ): Promise<
    | { kind: "live" }
    | { kind: "retired" | "gone"; observation?: ObservedTurnState | null }
    | { kind: "deferred"; reason: string }
    | { kind: "refuse"; reason: string }
  > {
    const deadlineAt = Date.now() + Math.max(0, deadlineMs);
    let observeError: unknown;
    try {
      const read = await boundedRead(
        "participant observation",
        () => this.resolution.host.observe(agentId),
        Math.max(0, deadlineAt - Date.now()),
      );
      if (read.state === "unknown")
        return {
          kind: "deferred",
          reason: `owned tool custody observation is unknown: ${read.reason}`,
        };
      const state = read.value;
      const workspaceMatch =
        workspaceId === undefined || state.workspaceId === workspaceId;
      if (
        state.id !== agentId ||
        !workspaceMatch ||
        state.active ||
        state.activeTurnId ||
        state.permissions
      )
        return {
          kind: "refuse",
          reason:
            "participant is not idle and permission-free in the recorded workspace",
        };
      if (state.status === "gone") return { kind: "gone", observation: state };
      if (state.status === "closed" || state.archived === true)
        return { kind: "retired", observation: state };
      if (agentSettled(state, ["idle", "closed"])) return { kind: "live" };
      return {
        kind: "refuse",
        reason:
          "participant is not idle and permission-free in the recorded workspace",
      };
    } catch (error) {
      const deferred = custodyProofDeferral({ kind: "error", error });
      if (deferred) return deferred;
      observeError = error;
    }
    if (
      observeError instanceof HostReadRefusalError ||
      isTransportFailure(observeError) ||
      isHostOperationTimeout(observeError) ||
      observeError instanceof HostTransportFault
    )
      throw observeError;
    if (this.adapter.originAgent) {
      let origin: Awaited<ReturnType<Resolution["host"]["originAgent"]>>;
      try {
        const read = await boundedRead(
          "origin agent observation",
          () => this.resolution.host.originAgent(agentId),
          Math.max(0, deadlineAt - Date.now()),
        );
        if (read.state === "unknown")
          return {
            kind: "deferred",
            reason: `owned tool custody observation is unknown: ${read.reason}`,
          };
        origin = read.value;
      } catch (originError) {
        const deferred = custodyProofDeferral({ kind: "error", error: originError });
        if (deferred) return deferred;
        if (
          originError instanceof HostReadRefusalError ||
          isTransportFailure(originError) ||
          isHostOperationTimeout(originError) ||
          originError instanceof HostTransportFault
        )
          throw originError;
        const message =
          originError instanceof Error
            ? originError.message
            : String(originError);
        return {
          kind: "refuse",
          reason: `owned tool custody observation failed: ${message}`,
        };
      }
      if (origin === null) return { kind: "gone" };
      if (
        origin.id !== agentId ||
        (workspaceId !== undefined && origin.workspaceId !== workspaceId)
      )
        return {
          kind: "refuse",
          reason:
            "participant is not idle and permission-free in the recorded workspace",
        };
      if (origin.deleted === true) return { kind: "gone" };
      if (origin.archived === true) return { kind: "retired" };
    } else if (isAgentGoneRefusal(observeError)) {
      return { kind: "gone" };
    }
    const message =
      observeError instanceof Error
        ? observeError.message
        : String(observeError);
    return {
      kind: "refuse",
      reason: `owned tool custody observation failed: ${message}`,
    };
  }

  private async verifyOwnedWorkspaceAndScratchProcesses(
    agentId: string,
    task: Task | null,
    taskRuns: Run[],
    runIds: string[],
    workspaceId: string | undefined,
    boundRunId: string | undefined,
    turn?: ObservedTurnState | null,
    entries?: TimelineEntry[],
    deadlineMs: number = this.readDeadlineMs,
  ): Promise<OwnedToolHoldResult> {
    if (
      !task ||
      !runIds.length ||
      !workspaceId ||
      !this.adapter.noLiveWorkspaceProcesses ||
      !this.adapter.hostProcessListing
    )
      return {
        kind: "hold",
        reason: "owned workspace or run process identity is unavailable",
      };
    const temporaryDirectories = runIds.map((id) =>
      participantTemporaryDirectory(task, taskRuns, id),
    );
    if (temporaryDirectories.some((directory) => !directory))
      return {
        kind: "hold",
        reason: "a participant run temporary directory is unrecorded",
      };
    const boundRun = boundRunId ? this.store.run(boundRunId) : null;
    const bbThreads = bbThreadForAgent(agentId, boundRun?.hostId ?? task.hostId)
      ? bbWorkspaceThreads(task, taskRuns, workspaceId)
      : [];
    const runtime = participantRuntime({
      dataHome: storeDataHome(this.store),
      tasks: [task],
      runs: taskRuns,
      bbThreads,
    });
    const processHostId = boundRun?.hostId ?? task.hostId;
    const processRead = await this.readProcesses(processHostId);
    const deferred = this.processProofDeferral(
      processRead, processHostId, agentId, turn, entries,
    );
    if (deferred) return deferred;
    if (processRead.state !== "listed") {
      return {
        kind: "hold",
        reason: processRead.reason || "the host process listing is unreadable",
      };
    }
    const processes = processRead.processes;
    const workspaceProof = await this.workspaceProcessProof(
      workspaceId, runIds, runtime, processes, processHostId, agentId, deadlineMs,
    );
    if (workspaceProof.kind !== "clear") return workspaceProof;
    for (const directory of new Set(temporaryDirectories)) {
      const issue = workspaceToolProcessIssue(
        processes,
        directory!,
        runIds,
        runtime,
      );
      if (issue) return { kind: "hold", reason: issue };
    }
    return { kind: "clear" };
  }

  private async workspaceProcessProof(
    workspaceId: string,
    runIds: string[],
    runtime: ReturnType<typeof participantRuntime>,
    processes: HostProcessFact[] | null,
    hostId: string | null | undefined,
    agentId: string,
    deadlineMs: number,
  ): Promise<OwnedToolHoldResult> {
    let workspaceRead: Awaited<ReturnType<typeof boundedRead<string | null>>>;
    try {
      workspaceRead = await boundedRead(
        "workspace process probe",
        () =>
          this.adapter.noLiveWorkspaceProcesses!(
            workspaceId,
            runIds,
            runtime,
            processes,
          ),
        deadlineMs,
      );
    } catch (error) {
      const deferred = this.proofReadError(error, hostId, agentId);
      if (deferred) return deferred;
      return {
        kind: "hold",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (workspaceRead.state === "unknown")
      return { kind: "deferred", reason: workspaceRead.reason };
    const workspaceIssue = workspaceRead.value;
    if (workspaceIssue !== null)
      return {
        kind: "hold",
        reason:
          workspaceIssue || "the workspace process probe returned no verdict",
      };
    return { kind: "clear" };
  }

  private acceptOwnedToolHold(
    taskId: string,
    runId: string,
    hold: string,
  ): boolean {
    this.recordOwnedToolHold(taskId, runId, hold);
    const latestHold = this.latestOwnedToolEvent(
      taskId,
      runId,
      OWNED_TOOL_HOLD,
    );
    return this.store
      .task(taskId)
      .resolution.ownerSettlements.some(
        (record) =>
          record.effect === `owned_tool.${runId}` &&
          record.occurrence === String(latestHold?.id ?? ""),
      );
  }

  private recordOwnedToolHold(
    taskId: string,
    runId: string,
    reason: string,
  ): void {
    const detail = JSON.stringify({ runId, reason });
    const latest = this.latestOwnedToolEvent(
      taskId,
      runId,
      OWNED_TOOL_HOLD,
      OWNED_TOOL_SETTLED,
    );
    if (latest?.kind === OWNED_TOOL_HOLD && latest.detail === detail) return;
    this.store.event(taskId, OWNED_TOOL_HOLD, detail);
  }

  private recordOwnedToolSettlement(
    taskId: string,
    runId: string,
    evidence: string,
    force = false,
  ): void {
    const latest = this.latestOwnedToolEvent(
      taskId,
      runId,
      OWNED_TOOL_HOLD,
      OWNED_TOOL_SETTLED,
    );
    if (latest?.kind !== OWNED_TOOL_HOLD && !force) return;
    this.store.event(
      taskId,
      OWNED_TOOL_SETTLED,
      JSON.stringify({ runId, evidence }),
    );
  }

  /**
   * The newest owned-tool event for this run, decoded once. The reader walks the
   * event history from the end and stops at the first owned-tool event, so a
   * long history is not re-parsed on every proof.
   */
  private latestOwnedToolEvent(
    taskId: string,
    runId: string,
    ...kinds: string[]
  ): { kind: string; detail: string; id?: number } | null {
    const events = this.store.eventsAll(taskId);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (!kinds.includes(event.kind)) continue;
      const decoded = decodeOwnedToolDetail(event.detail);
      if (!decoded) continue;
      if (decoded.runId === runId)
        return { kind: event.kind, detail: event.detail, id: event.id };
    }
    return null;
  }
}

/** One owned-tool event detail, decoded once into the run it names. */
export function decodeOwnedToolDetail(
  detail: string,
): { runId: string } | null {
  try {
    const decoded = JSON.parse(detail) as { runId?: unknown };
    return typeof decoded.runId === "string" && decoded.runId
      ? { runId: decoded.runId }
      : null;
  } catch {
    return null;
  }
}
