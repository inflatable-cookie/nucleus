import {
  observeRunningTool,
  recordActivityTool,
} from "../telemetry/task-activity-observation";
import type { Run, Task } from "../../shared/contracts";
import { isTransportFailure } from "../../shared/transport";
import { agentSettled } from "./agent-settled";
import { boundedToolHold } from "./bounded-tool";
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
  type TimelineEntry,
} from "../recovery/stall";
import type { HostProcessFact } from "../host/types";
import {
  PASS_PROCESS_READ_DEADLINE_MS,
  QUANTUM_READ_DEADLINE_MS,
  boundedRead,
  type PassProcessRead,
  type PassTimelinePageRead,
} from "../scheduling/pass-snapshot";

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
  ) {
    if (!this.resolution.readPassTimelinePage) return this.resolution.host;
    return {
      agentTimelinePage: async (id: string, limit?: number) => {
        const read = await this.resolution.readPassTimelinePage(
          id,
          limit,
          hostId,
          this.readDeadlineMs,
        );
        onRead?.(read);
        if (read.state === "unknown") throw new Error(read.reason);
        return read.value;
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
        () => this.adapter.hostProcessListing!(),
        this.processDeadlineMs,
      ).catch(() => ({ state: "unknown" as const, reason: "failed" }));
      return read.state === "ok" && read.value
        ? {
            state: "listed",
            processes: read.value,
            capturedAt,
            fromPassSnapshot: false,
          }
        : {
            state: "unknown",
            reason:
              read.state === "unknown"
                ? read.reason
                : "the host process listing is unreadable",
            capturedAt,
            fromPassSnapshot: false,
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
  private processSnapshotPredatesEvidence(
    read: PassProcessRead,
    hostId: string | null | undefined,
    agentId: string,
    turn?: ObservedTurnState | null,
    entries?: TimelineEntry[],
  ): string | null {
    if (!read.fromPassSnapshot) return null;
    if (entries) {
      for (const entry of entries) {
        const at = Date.parse(entry.timestamp);
        if (Number.isFinite(at) && at > read.capturedAt) {
          return "the pass process snapshot predates observed tool activity; waiting for the next host pass";
        }
      }
    }
    if (turn?.updatedAt) {
      const updatedMs = Date.parse(turn.updatedAt);
      if (Number.isFinite(updatedMs) && updatedMs > read.capturedAt) {
        return "the pass process snapshot predates the participant's latest activity; waiting for the next host pass";
      }
    }
    const prior =
      this.resolution.passObservedBeforeProcesses?.(hostId, agentId) ?? null;
    const priorInactive = Boolean(
      prior &&
        (noTurnLive(prior) ||
          prior.status === "gone" ||
          prior.status === "closed" ||
          prior.archived === true),
    );
    if (!priorInactive) {
      return "the pass process snapshot was captured before the participant was proven inactive; waiting for the next host pass";
    }
    const priorTerminal = Boolean(
      prior && (prior.status === "gone" || prior.archived === true),
    );
    if (turn?.updatedAt) {
      if (!priorTerminal && prior?.updatedAt !== turn.updatedAt) {
        return "the participant was active after the pass process snapshot; waiting for the next host pass";
      }
    }
    return null;
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
    if ("issue" in read) return null;
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
   * The existing owned-tool proof, for a delivered turn that is claimed stopped
   * and for every participant of an author capability upgrade: no live tool by
   * timeline evidence. A stop-backed resume and a retirement need *positive*
   * proof, so an adapter with no timeline is unavailable evidence and refuses
   * rather than reading as clear; inconclusive evidence always holds (review
   * 5672703363, finding 2).
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
    } = {},
  ): Promise<string | null> {
    const task = options.taskId ? this.store.task(options.taskId) : null;
    const taskRuns = task ? this.store.runs(task.id) : [];
    const boundRun = options.runId ? this.store.run(options.runId) : null;
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
    if (options.allowRetired) {
      const custody = await this.classifyRetiredCustody(agentId, workspaceId);
      if (custody.kind === "refuse") return custody.reason;
      if (custody.kind === "retired" || custody.kind === "gone") {
        if (
          this.adapter.noLiveWorkspaceProcesses &&
          this.adapter.hostProcessListing
        ) {
          const processIssue =
            await this.verifyOwnedWorkspaceAndScratchProcesses(
              agentId,
              task,
              taskRuns,
              runIds,
              workspaceId,
              options.runId,
              custody.observation,
            );
          if (
            processIssue &&
            task &&
            options.runId &&
            this.acceptOwnedToolHold(task.id, options.runId, processIssue)
          )
            return null;
          if (!processIssue && task)
            for (const runId of runIds)
              this.recordOwnedToolSettlement(
                task.id,
                runId,
                `retired participant (${custody.kind}), workspace inactivity and owned-process observations are clear`,
              );
          return processIssue;
        }
        if (custody.kind === "gone")
          return "owned workspace or run process identity is unavailable";
      }
    }
    if (!this.adapter.agentTimelinePage)
      return options.requireCompleteEvidence
        ? "owned tool evidence is unavailable: this adapter offers no tool timeline"
        : null;
    let read: Awaited<ReturnType<typeof readToolTimeline>>;
    let lastPageRead: PassTimelinePageRead | null = null;
    try {
      read = await readToolTimeline(
        this.timelineHost(boundRun?.hostId ?? task?.hostId, (pageRead) => {
          lastPageRead = pageRead;
        }),
        agentId,
        this.readDeadlineMs,
      );
    } catch (error) {
      if (
        error instanceof HostReadRefusalError ||
        isTransportFailure(error) ||
        isHostOperationTimeout(error) ||
        error instanceof HostTransportFault
      )
        throw error;
      return "owned tool evidence is unreadable";
    }
    if ("issue" in read) {
      if (read.transientError) throw read.transientError;
      return `owned tool evidence is inconclusive: ${read.issue}`;
    }
    if (read.coverage === "bounded") {
      const hold = await boundedToolHold(
        read,
        this.resolution.host,
        agentId,
        workspaceId,
        (observed) =>
          this.verifyOwnedWorkspaceAndScratchProcesses(
            agentId,
            task,
            taskRuns,
            runIds,
            workspaceId,
            options.runId,
            observed,
            read.entries,
          ),
        this.readDeadlineMs,
      );
      if (
        hold &&
        task &&
        options.runId &&
        this.acceptOwnedToolHold(task.id, options.runId, hold)
      )
        return null;
      if (!hold && task)
        for (const runId of runIds)
          this.recordOwnedToolSettlement(
            task.id,
            runId,
            "bounded tool window, participant inactivity and owned-process observations are clear",
          );
      return hold;
    }
    if (!liveToolIssueFact(read.entries)) {
      // Spec 068 §6: a warmed tool page with no live call may only clear a
      // hold when a fresh observation proves no newer turn occurred since the
      // page was captured (positive matching `coveredObservation.updatedAt`).
      // A missing activity stamp never proves the turn did not change.
      const pageMeta = lastPageRead as PassTimelinePageRead | null;
      if (pageMeta?.fromPassSnapshot) {
        const freshTurn = await observedTurnState(
          this.resolution.host,
          agentId,
          this.readDeadlineMs,
        );
        const freshInactive = Boolean(
          freshTurn &&
            !freshTurn.active &&
            !freshTurn.permissions &&
            !freshTurn.activeTurnId &&
            ["idle", "error", "closed", "gone"].includes(
              freshTurn.status ?? "",
            ),
        );
        if (!freshInactive) {
          return "owned tool evidence is inconclusive: cached tool timeline predates the participant's latest observation; waiting for the next host pass";
        }
        const covered = pageMeta.coveredObservation;
        const coveredUpdatedAt = covered?.updatedAt ?? null;
        const freshUpdatedAt = freshTurn?.updatedAt ?? null;
        const positiveMatch = Boolean(
          coveredUpdatedAt &&
            freshUpdatedAt &&
            freshUpdatedAt === coveredUpdatedAt,
        );
        if (!positiveMatch) {
          // If neither side carries an activity stamp (e.g. a host adapter that
          // omits `updatedAt`), never settle on the cached pass page: re-read
          // boundedly directly so a newer tool call is observed and a hung read
          // returns unknown inside the quantum deadline.
          if (coveredUpdatedAt === null && freshUpdatedAt === null) {
            const directHost = {
              agentTimelinePage: async (id: string, limit?: number) => {
                const direct = await boundedRead(
                  "agent timeline page",
                  () => this.resolution.host.agentTimelinePage(id, limit),
                  this.readDeadlineMs,
                );
                if (direct.state === "unknown") throw new Error(direct.reason);
                return direct.value;
              },
            };
            let freshRead: Awaited<ReturnType<typeof readToolTimeline>>;
            try {
              freshRead = await readToolTimeline(
                directHost,
                agentId,
                this.readDeadlineMs,
              );
            } catch {
              return "owned tool evidence is inconclusive: cached tool timeline has no activity stamp and fresh timeline read failed";
            }
            if ("issue" in freshRead)
              return `owned tool evidence is inconclusive: ${freshRead.issue}`;
            const freshIssue = liveToolIssueFact(freshRead.entries);
            if (freshIssue) return formatLiveToolIssue(freshIssue);
          } else {
            return "owned tool evidence is inconclusive: cached tool timeline predates the participant's latest observation; waiting for the next host pass";
          }
        }
      }
      if (options.taskId)
        for (const runId of runIds)
          this.recordOwnedToolSettlement(
            options.taskId,
            runId,
            "complete tool timeline has no live or unknown calls",
          );
      return null;
    }
    // The turn proof is read AFTER the evidence it settles: an agent that became
    // active, permissioned or turn-bound since then is caught here and holds.
    const turn = await observedTurnState(
      this.resolution.host,
      agentId,
      this.readDeadlineMs,
    );
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
        (processIssue.status === "running" || INTERRUPTED_TOOL_STATUSES.has(processIssue.status))) ||
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
      const predates = this.processSnapshotPredatesEvidence(
        processRead,
        processHostId,
        agentId,
        turn,
        read.entries,
      );
      if (verdict.state === "empty") {
        if (predates) {
          hold = `${toolLabel}; ${predates}`;
        } else {
          const heldRunId = options.runId ?? verdict.runId;
          this.recordOwnedToolSettlement(
            options.taskId,
            heldRunId,
            `run ${heldRunId}: stale non-turn-bound tool settled; agent helper run ${verdict.runId} proves provider pid ${verdict.providerPid} has no live descendants except Nucleus MCP report helper pid ${verdict.helperPid}`,
            true,
          );
          hold = null;
        }
      } else if (verdict.state === "live") {
        hold = `${toolLabel}; descendant pid ${verdict.pid} remains under provider pid ${verdict.providerPid}`;
      } else if (
        verdict.code === "helper-missing" &&
        options.workspaceId &&
        this.adapter.noLiveWorkspaceProcesses
      ) {
        if (predates) {
          hold = `${toolLabel}; ${predates}`;
        } else {
          const workspaceRead = await boundedRead(
            "workspace process probe",
            () =>
              this.adapter.noLiveWorkspaceProcesses!(
                options.workspaceId!,
                runIds,
                runtime,
                processes,
              ),
            this.readDeadlineMs,
          );
          const workspaceIssue =
            workspaceRead.state === "ok"
              ? workspaceRead.value
              : workspaceRead.reason;
          if (!workspaceIssue) {
            this.recordOwnedToolSettlement(
              options.taskId,
              runIds[0]!,
              `run ids ${runIds.join(", ")}: stale non-turn-bound tool settled; no process carried an MCP ticket and the task workspace process tree was empty`,
              true,
            );
            hold = null;
          } else hold = `${toolLabel}; ${workspaceIssue}`;
        }
      } else
        hold = `${toolLabel}; process tree is unreadable: ${verdict.reason}`;
    }
    if (
      hold &&
      options.runId &&
      options.taskId &&
      this.acceptOwnedToolHold(options.taskId, options.runId, hold)
    )
      return null;
    if (!hold && options.taskId)
      for (const runId of runIds)
        this.recordOwnedToolSettlement(
          options.taskId,
          runId,
          "fresh tool and owner observations prove the recorded hold settled",
        );
    return hold ? `an owned tool is still live: ${hold}` : null;
  }

  private async classifyRetiredCustody(
    agentId: string,
    workspaceId: string | undefined,
  ): Promise<
    | { kind: "live" }
    | { kind: "retired" | "gone"; observation?: ObservedTurnState | null }
    | { kind: "refuse"; reason: string }
  > {
    let observeError: unknown;
    try {
      const read = await boundedRead(
        "participant observation",
        () => this.resolution.host.observe(agentId),
        this.readDeadlineMs,
      );
      if (read.state === "unknown")
        return {
          kind: "refuse",
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
          this.readDeadlineMs,
        );
        if (read.state === "unknown")
          return {
            kind: "refuse",
            reason: `owned tool custody observation is unknown: ${read.reason}`,
          };
        origin = read.value;
      } catch (originError) {
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
  ): Promise<string | null> {
    if (
      !task ||
      !runIds.length ||
      !workspaceId ||
      !this.adapter.noLiveWorkspaceProcesses ||
      !this.adapter.hostProcessListing
    )
      return "owned workspace or run process identity is unavailable";
    const temporaryDirectories = runIds.map((id) =>
      participantTemporaryDirectory(task, taskRuns, id),
    );
    if (temporaryDirectories.some((directory) => !directory))
      return "a participant run temporary directory is unrecorded";
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
    const processes =
      processRead.state === "listed" ? processRead.processes : null;
    if (!processes) return "the host process listing is unreadable";
    const predates = this.processSnapshotPredatesEvidence(
      processRead,
      processHostId,
      agentId,
      turn,
      entries,
    );
    if (predates) return predates;
    const workspaceRead = await boundedRead(
      "workspace process probe",
      () =>
        this.adapter.noLiveWorkspaceProcesses!(
          workspaceId,
          runIds,
          runtime,
          processes,
        ),
      this.readDeadlineMs,
    );
    if (workspaceRead.state === "unknown") return workspaceRead.reason;
    const workspaceIssue = workspaceRead.value;
    if (workspaceIssue !== null)
      return (
        workspaceIssue || "the workspace process probe returned no verdict"
      );
    for (const directory of new Set(temporaryDirectories)) {
      const issue = workspaceToolProcessIssue(
        processes,
        directory!,
        runIds,
        runtime,
      );
      if (issue) return issue;
    }
    return null;
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
