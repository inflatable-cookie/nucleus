import { z } from "zod";
import type { Task } from "../../shared/contracts";
import type {
  HostParticipantObservation,
  HostThread,
  HostTimelinePage,
} from "../../shared/host";
import {
  hostFailureRefusalDetail,
  HostReadRefusalError,
  ProvenPreSendRefusalError,
  type ArchivedThread,
} from "../../core/host";
import { ThreadUnobservedError } from "../../core/host/errors";
import {
  T3_THREAD_NOT_FOUND_PROJECTION_REASON,
  T3RpcError,
  type T3RpcClient,
} from "./rpc";
import {
  agentRecord,
  canonical,
  t3WorkspaceId,
  type T3StateFile,
} from "./state";
import { labelTask } from "./one-row";
import { linkedWorktreePath } from "../../core/git/git-identity";
import { WIRE_LABEL_KEYS } from "../../shared/wire-labels";
import { T3LiveShell } from "./live-shell";
import {
  decode,
  shellSnapshot,
  projection,
  threadSnapshot,
  threadSnapshotCoverage,
  shellThread,
  project,
  T3CompatibilityError,
} from "./contracts";

/**
 * What one thread snapshot is for. Observation needs the thread record, its runs
 * and its runtime requests; a window read needs the newest bounded suffix of the
 * timeline; a transcript read needs every turn item and refuses a bounded window
 * that left history behind. Custody requires a full snapshot for all provider
 * sessions, including those a bounded window can omit.
 */
export type ThreadReadKind = "observation" | "window" | "transcript" | "custody";
export type Projection = z.infer<typeof projection>;

function backgroundTasks(threads: NonNullable<Projection["providerThreads"]>) {
  return threads.flatMap((thread) =>
    (thread.pendingBackgroundTasks ?? []).map((task) => `${task.kind} ${task.taskId}`),
  );
}
/**
 * One thread snapshot as the nightly answered it: the projection it sent and
 * whether its own window left earlier history behind (`hasMoreHistory`).
 */
export interface ThreadSnapshotRead {
  projection: Projection;
  paged: boolean;
  /** The nightly left the turn items themselves out of a bounded answer. */
  omitsTurnItems: boolean;
}
/** One row of T3's thread list; the whole list is this host's change marker. */
type ShellRow = z.infer<typeof shellThread>;
/**
 * A read for a thread this host no longer observes: its Nucleus task is over, or
 * T3's own thread list reports it archived or removed (nucleus#1328). Leaving
 * observation never deletes, archives or edits the thread; it only stops paying a
 * full snapshot to read it on every sweep, and a caller that still asks is told so
 * instead of being handed a made-up state.
 */
export class T3UnobservedThreadError extends ThreadUnobservedError {
  constructor(readonly threadId: string) {
    super(`T3Code thread ${threadId} is no longer observed`);
    this.name = "T3UnobservedThreadError";
  }
}
/**
 * Thread snapshot reads one host serves at once (Spec 069 batch 5). A bounded
 * snapshot still makes T3 load the thread's projection, so a pass over many
 * changed threads queues behind this cap instead of stacking reads on a busy
 * host. Heartbeats are control frames and never wait here.
 */
export const T3_THREAD_READ_CONCURRENCY = 4;
/** The phases in which a task is over, so its threads need no observation. */
const terminalTaskPhases = new Set(["done", "cancelled"]);
const archivedShellSnapshot = z.object({
  schemaVersion: z.number().int().positive(),
  snapshotSequence: z.number().int().nonnegative(),
  projects: z.array(project),
  threads: z.array(shellThread),
});
/** Transient T3 read/projection failure before a complete binding can be proved. */
export class T3TransientReadError extends HostReadRefusalError {
  constructor(causeError: unknown) {
    super(hostFailureRefusalDetail(causeError));
    this.name = "T3TransientReadError";
    (this as Error & { cause?: unknown }).cause = causeError;
  }
}
export function isThreadNotFoundRpcError(error: unknown): boolean {
  return (
    error instanceof T3RpcError &&
    error.code === "remote" &&
    (error.remoteTag === "ThreadNotFoundError" ||
      (error.remoteTag === "OrchestrationV2GetThreadProjectionError" &&
        error.reason === T3_THREAD_NOT_FOUND_PROJECTION_REASON))
  );
}
export function isTransientT3ReadRpcError(error: unknown): boolean {
  return (
    error instanceof T3RpcError &&
    error.code === "remote" &&
    error.remoteTag === "OrchestrationV2GetThreadProjectionError" &&
    error.reason !== T3_THREAD_NOT_FOUND_PROJECTION_REASON
  );
}
/** One thread observation as this host reports it: a snapshot's answer, or the thread list's. */
export interface T3ThreadObservation {
  id: string;
  workspaceId: string | null;
  archived: boolean;
  status: string;
  active: boolean;
  permissions: boolean;
  error: string;
  model: string;
  provider: string;
  modeId: string | null;
  updatedAt: string;
  activeTurnId: string | null;
  turnStartedAt: string | null;
  lastUserMessageAt: string | null;
  labels: Record<string, string>;
  pendingPermissionKinds: string[];
  pendingRequest?: { id: string; kind: string; firstLine: string | null };
}
/**
 * Whether one held snapshot answers a read of this kind: an observation needs no
 * coverage, a window read needs the turn items, and a transcript read needs every
 * turn item the thread has.
 */
function snapshotCovers(
  read: ThreadSnapshotRead,
  kind: ThreadReadKind,
): boolean {
  if (kind === "observation") return true;
  if (read.omitsTurnItems) return false;
  return kind === "window" || !read.paged;
}
/** Native executions use shared tool kinds; background commands, children and dynamic tools can outlive their run. */
const nativeToolKinds: Record<string, string> = {
  command_execution: "shell",
  file_change: "edit",
  file_search: "search",
  web_search: "fetch",
  subagent: "subagent",
  dynamic_tool: "dynamic_tool",
};
/** The one identity a native execution item names, as text the reader can compare. */
const nativeToolIdentity = (item: Record<string, unknown>): string => {
  const value =
    item.input ??
    item.fileName ??
    item.pattern ??
    item.patterns ??
    item.subagentId ??
    item.toolName;
  if (typeof value === "string") return value.slice(0, 200);
  if (Array.isArray(value))
    return value
      .filter((part) => typeof part === "string")
      .join(" ")
      .slice(0, 200);
  return "";
};
type TimelineRow = {
  position: number;
  sourceThreadId?: string;
  sourceItemId: string;
  item: {
    id: string;
    type: string;
    ordinal: number;
    runId?: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
};
/** This thread's own rendered rows, oldest first: an inherited row belongs to another agent. */
const localRows = (
  rows: readonly TimelineRow[],
  threadId: string,
): TimelineRow[] =>
  rows
    .filter((row) => (row.sourceThreadId ?? threadId) === threadId && row.item)
    .sort((a, b) => a.position - b.position);
/** One row as the shared timeline entry, with a native execution translated into a tool entry. */
const timelineEntry = (
  row: TimelineRow,
  fallback: string,
): import("../../shared/host").HostTimelineEntry => {
  const item = row.item as typeof row.item & Record<string, unknown>;
  const timestamp = item.updatedAt ?? item.createdAt ?? fallback;
  const turnId = item.runId ? { turnId: item.runId } : {};
  const kind = nativeToolKinds[item.type];
  if (kind === undefined) return { timestamp, ...turnId, item };
  const name =
    typeof item.title === "string" && item.title.trim()
      ? item.title
      : item.type;
  const lastOutputAt = typeof item.lastOutputAt === "string" ? item.lastOutputAt
    : typeof item.output === "string" && item.output ? item.updatedAt : undefined;
  return {
    timestamp,
    ...turnId,
    item: {
      type: "tool_call",
      callId: item.id,
      name,
      status: String(item.status ?? ""),
      detail: {
        type: kind,
        command: nativeToolIdentity(item),
        nativeType: item.type,
        ...(item.createdAt ? { startedAt: item.createdAt } : {}),
        ...(lastOutputAt ? { lastOutputAt } : {}),
      },
    },
  };
};
/** The statuses that mean a run is live: the only ones a settle, a steer or a stop waits for. */
export const activeStatuses = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
/** T3's finished-run app states: a run that ended is an idle thread to every reader. */
const finishedRunStatuses = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
/**
 * One shell row's status as Nucleus reads it, the same answer `observe` gives:
 * a tombstone is `gone`, an archived thread is `closed`, a live run keeps its own
 * status (so it holds), a finished run and an idle thread are `idle`, and any other
 * status is returned unchanged so it holds too (nucleus#1381).
 */
export function shellThreadStatus(row: ShellRow): string {
  if (row.deletedAt) return "gone";
  if (row.archivedAt) return "closed";
  if (row.activeRunId || activeStatuses.has(row.status)) return row.status;
  if (row.status === "idle" || finishedRunStatuses.has(row.status))
    return "idle";
  return row.status;
}

/** Whether a shell row shows a live run. */
function rowActive(row: ShellRow): boolean {
  return !!row.activeRunId || activeStatuses.has(row.status);
}
/**
 * A thread-list row built from one exact projection read, for a thread the live
 * shell does not list (archived or tombstoned): its record, the live run and the
 * pending request the projection carries.
 */
export function rowFromProjection(projection: Projection): ShellRow {
  const active = projection.runs.find((run) => activeStatuses.has(run.status));
  const pending = projection.runtimeRequests.find(
    (request) => request.status === "pending",
  );
  return {
    ...projection.thread,
    activeRunId: active?.id ?? null,
    status: active?.status ?? "idle",
    pendingRuntimeRequest: pending
      ? { id: pending.id, kind: pending.kind, createdAt: projection.updatedAt }
      : null,
    latestUserMessageAt: null,
    lastError: null,
  } as ShellRow;
}

/** The connection and durable state a read needs; one host owns both. */
export interface T3ReadContext {
  rpc: T3RpcClient;
  state: T3StateFile;
  /** Refuse a read on a connection that no longer proves this host's durable identity. */
  requireConnection(): void;
  /** Close the connection when the wire shape proves this host cannot read it. */
  close(): void;
}

/**
 * The T3 host's reads: one synchronized snapshot of the shell, one bounded
 * snapshot of a thread, and the observations built from them.
 *
 * A read decodes the nightly's own coverage fields, so a bounded observation
 * snapshot is a positive fact ("these are all the runs and requests that matter")
 * rather than an inference from what happened to arrive. Nothing here writes
 * Queue state or sends a command; the two read facts it keeps are whether the
 * thread shape is still unproven and why the wire shape was refused.
 */
export class T3Reads {
  private pendingThreadShape = false;
  private compatibilityError = "";
  /**
   * The tasks this host still works on, from the last host pass. `null` until the
   * first pass states them: a fresh host has no fact that any thread is over, and
   * observing everything is the conservative reading of no evidence.
   */
  private liveTasks: ReadonlySet<string> | null = null;
  /** One snapshot per thread, kept at the change marker it was read at. */
  private held = new Map<
    string,
    { marker: string; pass: number; read: ThreadSnapshotRead }
  >();
  /** The pass the reads currently happen in; a new pass may still reuse an unchanged snapshot. */
  private pass = 0;
  /**
   * The host's one held shell subscription (Spec 069 batch 5): every shell read,
   * in a pass or not, answers from it.
   */
  readonly live: T3LiveShell;
  /**
   * What an exact read answered for a thread the live shell does not list — an
   * archived or removed thread, or one that never existed. Kept until T3's shell
   * names that thread again, a command goes to it, or the connection drops, so a
   * missing thread costs at most one read, not one per pass.
   */
  private readonly absent = new Map<
    string,
    { read: ThreadSnapshotRead } | { error: unknown }
  >();
  /**
   * Threads a command went to since the live shell last named them (a launch, a
   * child request, an archive). Their absence from the shell may only be the
   * stream's lag, so they still get an exact read.
   */
  private readonly written = new Set<string>();
  /** Threads T3 confirmed removed by a settled `thread.delete` receipt on this connection. */
  private readonly deletedByReceipt = new Set<string>();
  /** The archived walk the retention pass last read, by thread id. */
  private retentionWalk: Map<string, ShellRow> | null = null;
  private threadReads = 0;
  private readonly threadReadWaiters: (() => void)[] = [];
  private observedProjects: readonly z.infer<typeof project>[] | null = null;
  private readonly projectionHeld = new Map<
    string,
    Promise<ThreadSnapshotRead>
  >();
  private shapeProbe: Promise<void> | null = null;
  private readonly forgetEpochs = new Map<string, number>();
  private passing = false;
  constructor(private readonly core: T3ReadContext) {
    this.live = new T3LiveShell(
      core.rpc,
      core.rpc.deadlineFor("orchestration.subscribeShell"),
    );
    this.live.onChange((threadId) => {
      // A discarded copy proves nothing about what a command just started, so the
      // lag protection in `written` survives it; only a positive listing (or a
      // reset of the whole observation) clears that.
      if (threadId === null) {
        this.absent.clear();
        return;
      }
      this.absent.delete(threadId);
      this.written.delete(threadId);
    });
  }

  private forgetEpoch(threadId: string): number {
    return this.forgetEpochs.get(threadId) ?? 0;
  }

  /**
   * The pass opens: these are the tasks the host still works on, and every read in
   * this pass shares one thread list, one narrow projection cache, and one snapshot per thread. A thread whose
   * task is over, or that T3 reports archived or removed, leaves observation here.
   */
  beginPass(tasks: readonly Task[]) {
    this.passing = true;
    this.pass++;
    this.projectionHeld.clear();
    this.noteTaskFacts(tasks);
  }
  /** The pass closes: the next one reads the thread list afresh and may still reuse unchanged snapshots. */
  endPass() {
    this.passing = false;
    this.projectionHeld.clear();
  }
  /** The task facts alone, for a caller that states them outside a pass. */
  noteTaskFacts(tasks: readonly Task[]) {
    this.liveTasks = new Set(
      tasks
        .filter(
          (task) => !task.removedAt && !terminalTaskPhases.has(task.phase),
        )
        .map((task) => task.id),
    );
  }
  /** A connection or host identity change proves nothing about the threads it last saw. */
  resetObservation() {
    this.liveTasks = null;
    this.held.clear();
    this.pass = 0;
    this.passing = false;
    this.projectionHeld.clear();
    this.shapeProbe = null;
    this.forgetEpochs.clear();
    this.live.close();
    this.absent.clear();
    this.written.clear();
    this.deletedByReceipt.clear();
    this.retentionWalk = null;
  }

  /** The Nucleus task a tracked thread was launched for, from its own launch labels. */
  private taskOf(threadId: string) {
    return labelTask(agentRecord(this.core.state.read(), threadId)?.labels);
  }
  /**
   * Whether this host still observes a thread: its launch labels name a task this
   * pass still works on. A thread with no recorded task stays observed, because
   * nothing has proved its work over.
   */
  observes(threadId: string) {
    const task = this.taskOf(threadId);
    return !task || !this.liveTasks || this.liveTasks.has(task);
  }
  /**
   * The same, with T3's own terminal facts, read from the live shell
   * (Spec 069 batch 5): a thread T3 lists as active stays observed, and one it
   * does not list is not live, with no read at all. Only a thread a command went
   * to since the shell last named it (a launch the stream has not shown yet) is
   * read by its exact id, and that answer is kept until T3 names it again.
   */
  async isObserved(threadId: string): Promise<boolean> {
    if (!this.observes(threadId)) return false;
    try {
      const shell = await this.shellRow(threadId);
      if (shell) return !shell.archivedAt && !shell.deletedAt;
      if (!this.written.has(threadId)) return false;
      try {
        const projection = await this.readDirectProjection(
          threadId,
          "observation",
        );
        return !projection.thread.archivedAt && !projection.thread.deletedAt;
      } catch (error) {
        if (error instanceof T3CompatibilityError) throw error;
        if (isTransientT3ReadRpcError(error))
          throw new T3TransientReadError(error);
        // A thread just written to that T3 has not projected yet stays observed.
        return true;
      }
    } catch (error) {
      if (
        error instanceof HostReadRefusalError ||
        error instanceof T3CompatibilityError
      )
        throw error;
      return true;
    }
  }
  /** Whether a retired thread reappeared as an active row in T3's live shell. */
  async isActiveInShell(threadId: string): Promise<boolean> {
    if (!this.observes(threadId)) return false;
    try {
      const row = await this.shellRow(threadId);
      return !!row && !row.archivedAt && !row.deletedAt;
    } catch (error) {
      if (error instanceof T3CompatibilityError) throw error;
      return false;
    }
  }
  /** Whether the live shell lists this thread now; no read beyond the held subscription. */
  async listedLive(threadId: string): Promise<boolean> {
    const row = await this.shellRow(threadId);
    return !!row && !row.archivedAt && !row.deletedAt;
  }
  /** One thread's row in T3's live shell, propagating read/shape failures. */
  async shellRow(threadId: string): Promise<ShellRow | undefined> {
    const snapshot = await this.readShell();
    await this.probePendingThreadShape(snapshot.threads);
    return this.live.row(threadId);
  }
  /**
   * One thread's row from the held shell alone: answered only while the copy is
   * inside its freshness bounds and the thread shape is proved, so it opens no
   * subscription and sends T3 nothing. `undefined` means "ask T3", never absent.
   */
  async heldShellRow(threadId: string): Promise<ShellRow | undefined> {
    // A thread Nucleus just sent a command to may still show its pre-command
    // row in the live shell, so it takes the admitted read instead.
    if (this.pendingThreadShape || this.written.has(threadId)) return undefined;
    return await this.live.liveRow(threadId);
  }
  /**
   * One thread's row by its exact id: the live shell's row when T3 lists it, or
   * else the thread record one exact read answers (an archived or tombstoned
   * thread). `undefined` when T3 has no such thread. A list that cannot be read is
   * an error rather than an absent answer (nucleus#1328 review). No archived or
   * paired inventory is read (Tom, 2026-11-22: "We shouldn't need to be reading
   * archived threads at all").
   */
  private async readListRow(threadId: string): Promise<ShellRow | undefined> {
    const row = await this.shellRow(threadId);
    if (row) return row;
    const record = await this.readThreadRecord(threadId);
    if (!record) return undefined;
    return record.projection
      ? rowFromProjection(record.projection)
      : (record.row as ShellRow);
  }
  /**
   * The live shell's row for a thread no command has gone to since T3 last named
   * it: current to the stream, so a delivery gate can read settle and snooze from
   * it. `undefined` when the shell does not list the thread or a write is pending.
   */
  async currentShellRow(threadId: string): Promise<ShellRow | undefined> {
    const row = await this.shellRow(threadId);
    return row && !this.written.has(threadId) ? row : undefined;
  }
  /** A fresh family read carries T3's background roster beyond the timeline window. */
  async readThreadFamilyRow(threadId: string): Promise<ShellRow | undefined> {
    const family = decode(
      z.object({ threads: z.array(shellThread) }),
      await this.core.rpc.call("orchestration.getThreadFamily", { threadId }),
      "getThreadFamily",
    );
    return family.threads.find((row) => row.id === threadId);
  }
  async observeParticipant(
    id: string,
  ): Promise<HostParticipantObservation | null> {
    this.core.requireConnection();
    // Bounded projections can omit older idle provider sessions, and the
    // shell roster covers only the active session. Require all sessions here.
    const { projection } = await this.readFreshSnapshot(id, "custody");
    if (projection.thread.deletedAt || !projection.providerThreads) return null;
    const row = rowFromProjection(projection);
    return {
      id: row.id,
      workspaceId: this.threadWorkspace(row),
      status: shellThreadStatus(row),
      active: rowActive(row),
      permissions: row.pendingRuntimeRequest !== null,
      activeTurnId: row.activeRunId,
      updatedAt: projection.updatedAt,
      pendingBackgroundTasks: backgroundTasks(projection.providerThreads),
    };
  }
  /** `readListRow` for a caller outside this module. */
  async readListRowById(threadId: string): Promise<ShellRow | undefined> {
    return await this.readListRow(threadId);
  }
  /**
   * One thread's live-shell row: the change marker for its snapshot. The live
   * shell is held for the whole connection, so a read outside a pass uses the same
   * marker a pass does.
   */
  private async threadRow(threadId: string): Promise<ShellRow | undefined> {
    return await this.shellRow(threadId);
  }
  /**
   * The kept answer for a thread the live shell does not list and no command has
   * gone to since: the exact read that already answered it, if any.
   */
  private async absentAnswer(
    threadId: string,
    kind: ThreadReadKind,
  ): Promise<ThreadSnapshotRead | null> {
    if (this.written.has(threadId)) return null;
    const kept = this.absent.get(threadId);
    if (!kept) return null;
    if (await this.shellRow(threadId)) return null;
    if ("error" in kept) throw kept.error;
    return snapshotCovers(kept.read, kind) ? kept.read : null;
  }
  /**
   * Narrow single-thread snapshot without `shell` or `archivedShell` gating.
   * Inside a pass, concurrent observation reads for the same thread coalesce
   * onto one in-flight snapshot until `forget` or pass closeout drops it. A
   * thread the live shell does not list answers from its kept exact read.
   */
  private async readDirectSnapshot(
    threadId: string,
    kind: ThreadReadKind = "observation",
    fresh = false,
  ): Promise<ThreadSnapshotRead> {
    if (fresh) this.projectionHeld.delete(threadId);
    else {
      const kept = await this.absentAnswer(threadId, kind);
      if (kept) return kept;
    }
    if (!fresh && kind === "observation" && this.passing) {
      let pending = this.projectionHeld.get(threadId);
      if (!pending) {
        pending = this.readFreshSnapshot(threadId, kind);
        this.projectionHeld.set(threadId, pending);
      }
      try {
        return await pending;
      } catch (error) {
        if (this.projectionHeld.get(threadId) === pending)
          this.projectionHeld.delete(threadId);
        throw error;
      }
    }
    return this.readFreshSnapshot(threadId, kind);
  }
  /** Narrow single-thread projection without `shell` or `archivedShell` gating. */
  async readDirectProjection(
    threadId: string,
    kind: ThreadReadKind = "observation",
    fresh = false,
  ): Promise<Projection> {
    return (await this.readDirectSnapshot(threadId, kind, fresh)).projection;
  }
  /**
   * Read an already-bound thread: its live-shell row, or else one exact read by
   * id. A thread T3 does not have (`ThreadNotFoundError`, or the projection's
   * proved missing-thread cause) is `null`: removed or never created. Nothing
   * reads the archived inventory.
   */
  async readThreadRecord(
    id: string,
    fresh = false,
  ): Promise<{
    row: ShellRow | Projection["thread"];
    projection: Projection | null;
  } | null> {
    if (!fresh) {
      const shell = await this.threadRow(id);
      if (shell) return { row: shell, projection: null };
    }
    try {
      const projection = await this.readDirectProjection(
        id,
        "observation",
        fresh,
      );
      return { row: projection.thread, projection };
    } catch (error) {
      if (isTransientT3ReadRpcError(error))
        throw new T3TransientReadError(error);
      if (!isThreadNotFoundRpcError(error)) throw error;
      // T3's projection store and its shell can disagree for a moment; a thread
      // the live shell lists is never answered absent (a creation lookup would
      // otherwise launch a second one).
      const listed = this.live.row(id);
      return listed ? { row: listed, projection: null } : null;
    }
  }

  /** A thread shape this connection has not yet proved by reading one thread. */
  get threadShapePending() {
    return this.pendingThreadShape;
  }
  get compatibilityFailure() {
    return this.compatibilityError;
  }
  resetShape() {
    this.pendingThreadShape = false;
    this.compatibilityError = "";
    this.shapeProbe = null;
  }
  markShapePending(pending = true) {
    this.pendingThreadShape = pending;
  }
  /**
   * The live shell (Spec 069 batch 5): the held subscription's copy, opened with
   * one synchronized snapshot the first time it is asked for on a connection and
   * kept current from T3's own stream after that.
   */
  async readShell() {
    let snapshot: z.infer<typeof shellSnapshot>;
    try {
      snapshot = await this.live.current();
    } catch (error) {
      // T3 answered the subscription with a failure of its own: the shell is
      // unreadable for now, a bounded read refusal rather than a host fault.
      if (error instanceof T3RpcError && error.code === "remote")
        throw new T3TransientReadError(error);
      throw error;
    }
    // The projects this read saw are the host's own project observation. The board
    // reads them from here, so a badge never costs an extra host read (nucleus#1450).
    this.observedProjects = snapshot.projects;
    return snapshot;
  }
  /**
   * The projects the last synchronized shell read saw, or null before any read on
   * this connection. Holds no fresh read: a caller decides whether the connection
   * is still live before it trusts the list.
   */
  projectObservation(): readonly z.infer<typeof project>[] | null {
    return this.observedProjects;
  }
  /**
   * One fresh, synchronized thread snapshot. An observation read opts into the
   * nightly's bounded snapshot, which keeps every fact observation reads: the
   * thread record is whole, and the projection carries every queued, preparing,
   * starting, running or waiting run, the runs its window references, the run the
   * shell presents, and every pending or waiting runtime request (nucleus#1188).
   * Older settled runs, resolved requests and the timeline before the window are
   * absent, and none of them changes a status, an active run, a pending request
   * or a settle marker. A window read takes the same bounded snapshot and hands
   * back the newest timeline suffix the nightly kept; a transcript read refuses
   * an incomplete projection rather than requesting unbounded history. Every
   * read strictly decodes the coverage fields.
   */
  async readProjection(
    threadId: string,
    kind: ThreadReadKind = "transcript",
  ): Promise<Projection> {
    return (await this.readThreadSnapshot(threadId, kind)).projection;
  }

  /** One thread snapshot plus the nightly's own window coverage. */
  private async readThreadSnapshot(
    threadId: string,
    kind: ThreadReadKind,
  ): Promise<ThreadSnapshotRead> {
    // Observation is a bounded window of this host's own: a thread whose task is
    // over is not read, and neither is one T3's list reports archived or removed.
    if (!this.observes(threadId)) throw new T3UnobservedThreadError(threadId);
    const row = await this.threadRow(threadId);
    if (row?.archivedAt || row?.deletedAt)
      throw new T3UnobservedThreadError(threadId);
    // The thread list is the change marker: an unchanged row means the snapshot
    // this pass already holds is the same answer, so T3 is not asked again. A
    // thread T3's list does not carry at all keeps its own read, unabridged.
    const marker = row ? canonical(row) : "";
    const held = marker ? this.held.get(threadId) : undefined;
    if (
      held &&
      held.marker === marker &&
      snapshotCovers(held.read, kind) &&
      // The list summarizes one pending request; while one is pending the read
      // that carries its questions is never skipped. A running thread's projection
      // (its `updatedAt`, which a stall check measures quiet time from, and its
      // window's tool output) can move without its row moving, so any read of a
      // running thread is refreshed once per pass too.
      ((this.passing && held.pass === this.pass) ||
        (!row?.pendingRuntimeRequest && !(row && rowActive(row))))
    )
      return held.read;
    const pass = this.pass;
    const epoch = this.forgetEpoch(threadId);
    const directPending = this.passing
      ? this.projectionHeld.get(threadId)
      : undefined;
    const read = directPending
      ? await directPending.then((candidate) =>
          snapshotCovers(candidate, kind)
            ? candidate
            : this.readFreshSnapshot(threadId, kind),
        )
      : kind === "observation" && this.passing
        ? await this.readDirectSnapshot(threadId, kind)
        : await this.readFreshSnapshot(threadId, kind);
    if (marker && this.pass === pass && this.forgetEpoch(threadId) === epoch)
      this.held.set(threadId, { marker, pass, read });
    else if (!marker) this.held.delete(threadId);
    return read;
  }

  /** One fresh synchronized thread snapshot, with no reuse: the nightly's own answer. */
  private async readFreshSnapshot(
    threadId: string,
    kind: ThreadReadKind,
  ): Promise<ThreadSnapshotRead> {
    // Whether T3's live shell lists the thread as this read starts: an answer for
    // one it does not list is kept (see `absent`).
    const unlisted = kind !== "custody" &&
      this.live.live && !this.live.row(threadId) && !this.written.has(threadId);
    const epoch = this.forgetEpoch(threadId);
    const keep = (answer: { read: ThreadSnapshotRead } | { error: unknown }) => {
      if (unlisted && this.forgetEpoch(threadId) === epoch && !this.live.row(threadId))
        this.absent.set(threadId, answer);
    };
    await this.acquireThreadRead();
    try {
      const read = await this.readFreshSnapshotNow(threadId, kind);
      keep({ read });
      return read;
    } catch (error) {
      if (isThreadNotFoundRpcError(error)) keep({ error });
      throw error;
    } finally {
      this.releaseThreadRead();
    }
  }
  /** Wait for one of the host's thread-read places (`T3_THREAD_READ_CONCURRENCY`). */
  private async acquireThreadRead(): Promise<void> {
    if (this.threadReads < T3_THREAD_READ_CONCURRENCY) {
      this.threadReads++;
      return;
    }
    await new Promise<void>((resolve) => this.threadReadWaiters.push(resolve));
  }
  private releaseThreadRead(): void {
    const next = this.threadReadWaiters.shift();
    if (next) next();
    else this.threadReads--;
  }
  /** The thread reads in flight and waiting, for diagnostics and tests. */
  threadReadLoad(): { inFlight: number; waiting: number } {
    return {
      inFlight: this.threadReads,
      waiting: this.threadReadWaiters.length,
    };
  }

  private async readFreshSnapshotNow(
    threadId: string,
    kind: ThreadReadKind,
  ): Promise<ThreadSnapshotRead> {
    let read: ThreadSnapshotRead | undefined;
    try {
      await this.core.rpc.readStream(
        "orchestration.subscribeThread",
        {
          threadId,
          requestCompletionMarker: true,
          acceptBoundedSnapshot: kind !== "custody",
        },
        (value) => {
          const item = decode(
            z.object({ kind: z.string() }).passthrough(),
            value,
            "subscribeThread",
          );
          if (item.kind === "snapshot") {
            if (read)
              throw new T3CompatibilityError(
                "subscribeThread: duplicate authoritative snapshot",
              );
            const complete = decode(threadSnapshot, item, "subscribeThread");
            const coverage = threadSnapshotCoverage(complete);
            if (
              (kind === "transcript" || kind === "custody") &&
              (coverage.paged || coverage.omitsTurnItems)
            )
              throw new T3CompatibilityError(
                "subscribeThread: incomplete projection",
              );
            // A window read consumes the turn items themselves. The compact form of
            // those rows (`turnItemsOmitLocalVisible`) cannot be restored here, so a
            // nightly that sent it would hand back a silent partial window.
            if (kind === "window" && coverage.omitsTurnItems)
              throw new T3CompatibilityError(
                "subscribeThread.turnItemsOmitLocalVisible",
              );
            const snapshot = complete.projection;
            if (snapshot.thread.id !== threadId)
              throw new T3CompatibilityError("subscribeThread.thread.id");
            read = {
              projection: snapshot,
              paged: coverage.paged,
              omitsTurnItems: coverage.omitsTurnItems,
            };
          } else if (item.kind === "synchronized") {
            if (!read)
              throw new T3CompatibilityError(
                "subscribeThread.projection missing",
              );
            return true;
          } else
            throw new T3CompatibilityError(
              "subscribeThread: state changed during snapshot",
            );
          return false;
        },
      );
      if (!read)
        throw new T3CompatibilityError("subscribeThread.projection missing");
      this.pendingThreadShape = false;
      return read;
    } catch (error) {
      if (this.pendingThreadShape && error instanceof T3CompatibilityError) {
        this.compatibilityError = error.message;
        this.core.close();
      }
      throw error;
    }
  }

  /**
   * Pick the first live, non-archived, non-deleted row whose task this host still
   * observes. Archived, deleted and terminal-task rows stay unread.
   */
  private eligibleProbeRow(rows: readonly ShellRow[]): ShellRow | undefined {
    return rows.find(
      (row) => !row.archivedAt && !row.deletedAt && this.observes(row.id),
    );
  }

  /**
   * When startup left thread shape pending on an empty shell, validate the first
   * eligible live row once via direct projection without re-entering `shell` or
   * `inventory`. Concurrent callers coalesce on the single in-flight probe.
   */
  private async probePendingThreadShape(
    rows: readonly ShellRow[],
  ): Promise<void> {
    if (!this.pendingThreadShape) return;
    if (!this.shapeProbe) {
      const probe = this.eligibleProbeRow(rows);
      if (!probe) return;
      this.shapeProbe = this.runShapeProbe(probe).finally(() => {
        this.shapeProbe = null;
      });
    }
    await this.shapeProbe;
  }

  private async runShapeProbe(probe: ShellRow): Promise<void> {
    try {
      await this.readDirectProjection(probe.id, "observation");
    } catch (error) {
      // A missing or transiently unready probe row keeps shape validation pending
      // for the next read without failing unrelated shell callers; compatibility,
      // transport and timeout faults surface immediately.
      if (isThreadNotFoundRpcError(error) || isTransientT3ReadRpcError(error))
        return;
      throw error;
    }
  }

  /**
   * The live shell snapshot: all projects and active non-archived threads, from
   * the host's held subscription, shared by every reader in and out of a pass.
   */
  async shell() {
    this.core.requireConnection();
    const snapshot = await this.readShell();
    await this.probePendingThreadShape(snapshot.threads);
    return snapshot;
  }
  /** One fresh `orchestration.getArchivedShellSnapshot` read without live-shell pairing. */
  async readArchivedShell() {
    this.core.requireConnection();
    return decode(
      archivedShellSnapshot,
      await this.core.rpc.call("orchestration.getArchivedShellSnapshot", {}),
      "getArchivedShellSnapshot",
    );
  }

  workspaceFor(thread: Projection["thread"]) {
    const state = this.core.state.read();
    const inbox = state.inbox;
    if (
      inbox &&
      thread.id === inbox.threadId &&
      thread.projectId === inbox.projectId &&
      thread.worktreePath === null
    )
      return inbox.workspaceId;
    const recorded = Object.values(state.workspaces).find(
      (w) =>
        w.projectId === thread.projectId && w.directory === thread.worktreePath,
    );
    if (recorded) return recorded.id;
    const path = this.threadPath(thread);
    const directory = path && linkedWorktreePath(path);
    return directory ? t3WorkspaceId(thread.projectId, directory) : null;
  }

  private threadPath(thread: Projection["thread"]): string | null {
    return (
      thread.worktreePath ??
      this.observedProjects?.find((project) => project.id === thread.projectId)
        ?.workspaceRoot ??
      null
    );
  }

  /** Origin and observation use the same placement, including project-only threads. */
  threadWorkspace(thread: Projection["thread"]) {
    return (
      this.workspaceFor(thread) ??
      (thread.archivedAt || thread.deletedAt || !this.observes(thread.id)
        ? agentRecord(this.core.state.read(), thread.id)?.workspaceId
        : undefined) ??
      `t3-project:${thread.projectId}`
    );
  }

  private toHostThreads(
    threads: readonly ShellRow[],
    includeWorkspaceDirectory = false,
  ): HostThread[] {
    return threads.map((t) => ({
      id: t.id,
      workspaceId: this.threadWorkspace(t),
      ...(includeWorkspaceDirectory
        ? { workspaceDirectory: this.threadPath(t) }
        : {}),
      labels: agentRecord(this.core.state.read(), t.id)?.labels ?? {},
      // The same terminal normalisation the single-thread read reports, so the
      // workspace archive proof reads one answer for both (nucleus#1381).
      status: shellThreadStatus(t),
      archived: !!t.archivedAt,
      activeTurn: !!t.activeRunId || activeStatuses.has(t.status),
      pendingPermissionKinds: t.pendingRuntimeRequest
        ? [
            t.pendingRuntimeRequest.kind === "user_input"
              ? "question"
              : t.pendingRuntimeRequest.kind,
          ]
        : [],
    }));
  }

  /**
   * The threads of the given workspaces, live and retired: every row the live
   * shell lists, plus each thread this host recorded in those workspaces that the
   * shell no longer lists, read by its exact id (an archived or tombstoned thread
   * answers with its own record; a removed one is absent). No archived inventory
   * is read (Spec 069 batch 5).
   */
  async workspaceThreadsLiveAndRecorded(
    workspaceIds: readonly string[],
  ): Promise<HostThread[]> {
    const { threads } = await this.shell();
    const live = this.toHostThreads(threads).filter(
      (thread) => !!thread.workspaceId && workspaceIds.includes(thread.workspaceId),
    );
    const listed = new Set(threads.map((thread) => thread.id));
    const state = this.core.state.read();
    const recorded = [
      ...Object.entries(state.agents),
      ...Object.entries(state.followUps ?? {}),
      ...Object.entries(state.retiredAgents ?? {}).filter(
        ([, record]) => !record.deletedAt,
      ),
    ]
      .filter(
        ([id, record]) =>
          !listed.has(id) && workspaceIds.includes(record.workspaceId),
      )
      .map(([id]) => id);
    const retired: ShellRow[] = [];
    for (const id of new Set(recorded)) {
      const row = await this.readListRow(id);
      if (row && !row.deletedAt) retired.push(row);
    }
    return [
      ...live,
      ...this.toHostThreads(retired).filter(
        (thread) =>
          !!thread.workspaceId && workspaceIds.includes(thread.workspaceId),
      ),
    ];
  }

  async activeThreads(includeWorkspaceDirectory = false) {
    const { threads } = await this.shell();
    return this.toHostThreads(
      threads.filter((t) => !t.archivedAt && !t.deletedAt),
      includeWorkspaceDirectory,
    );
  }

  private matchingAgentIds(labels: Record<string, string>): string[] {
    const state = this.core.state.read(),
      matches = (candidate: { labels: Record<string, string> }) =>
        Object.entries(labels).every(([k, v]) => candidate.labels[k] === v);
    const live = Object.entries(state.agents).filter(([, agent]) =>
      matches(agent),
    );
    const liveIds = new Set(live.map(([id]) => id));
    const retired = Object.entries(state.retiredAgents ?? {}).filter(
      ([id, agent]) => !agent.deletedAt && !liveIds.has(id) && matches(agent),
    );
    return [...live, ...retired].map(([id]) => id);
  }

  /**
   * Match launch labels, but confirm each identity and workspace against T3: the
   * live shell for a thread it lists, and one exact read for one it does not.
   */
  async findAgents(labels: Record<string, string>) {
    this.core.requireConnection();
    const candidates = this.matchingAgentIds(labels);
    if (!candidates.length) return [];
    const found = [];
    for (const id of candidates) {
      const thread = await this.readListRow(id);
      found.push({
        id,
        workspaceId: thread && !thread.deletedAt ? this.workspaceFor(thread) : null,
        hostConfirmed: !!thread && !thread.deletedAt,
      });
    }
    return found;
  }

  /**
   * A creation lookup (Spec 068 §3). A launch record names a candidate whose
   * existence T3 still needs to confirm, and `derived` names the child threads
   * T3 derives from the create commands the ledger recorded as sent, so a create
   * whose reply was lost (and whose record was dropped) is still found. The live shell is brought inside
   * its freshness bound first, so an empty answer is a complete one: a stale or
   * unreadable shell throws instead of answering absent. Each candidate the shell
   * does not list takes one fresh exact read by id; nothing reads the archived
   * inventory.
   */
  async findRunAgents(
    labels: Record<string, string>,
    derived: readonly string[] = [],
  ) {
    this.core.requireConnection();
    await this.readShell();
    const found = [];
    for (const id of new Set([...this.matchingAgentIds(labels), ...derived])) {
      const listed = this.live.row(id);
      // A fresh exact read by id; a thread T3 does not have is not a candidate.
      const record = listed
        ? { row: listed, projection: null }
        : await this.readThreadRecord(id, true);
      if (record && !record.row.deletedAt)
        found.push({
          id,
          workspaceId: this.workspaceFor(record.row),
          hostConfirmed: true,
        });
      // A removed child of a create this host sent proves the create landed: it
      // is never absence, so it is answered unconfirmed rather than left out.
      else if (record && derived.includes(id))
        found.push({ id, workspaceId: null, hostConfirmed: false });
    }
    return found;
  }

  /**
   * The retention pass's archived inventory (orchestration contract, "Archived
   * thread retention"): every archived thread this host holds that Nucleus
   * created, read from the archived snapshot. A row without a launch record is
   * not Nucleus's and is never listed. Exact cross-list checks happen immediately
   * before deletion via `threadArchiveState`.
   */
  async archivedThreads(): Promise<ArchivedThread[]> {
    const state = this.core.state.read();
    const { threads } = await this.readArchivedShell();
    // T3 reports an archived thread in both the shell list and the archived snapshot;
    // one row per thread is the answer.
    const archived: ArchivedThread[] = [];
    const seen = new Set<string>();
    const walk = new Map<string, ShellRow>();
    for (const row of threads) {
      if (!row.archivedAt || row.deletedAt || seen.has(row.id)) continue;
      seen.add(row.id);
      walk.set(row.id, row);
      const record = agentRecord(state, row.id);
      if (!record) continue;
      archived.push({
        id: row.id,
        workspaceId: this.workspaceFor(row),
        archivedAt: row.archivedAt,
        labels: record.labels,
      });
    }
    this.retentionWalk = walk;
    return archived;
  }

  /**
   * T3 settled a `thread.delete` for this thread: its receipt is the removal's
   * confirmation, so the retention walk no longer lists it.
   */
  noteDeleted(threadId: string) {
    this.retentionWalk?.delete(threadId);
    this.absent.delete(threadId);
    this.deletedByReceipt.add(threadId);
  }

  /**
   * One thread's archive fact, read immediately before the retention pass removes
   * it, and again after. The live shell answers a thread T3 lists (an operator's
   * unarchive shows there at once); otherwise the archived walk this same
   * retention pass just took answers. The read after a removal is not a fresh
   * observation: T3's settled `thread.delete` receipt is what confirms it, and
   * that receipt drops the thread from the walk (`noteDeleted`), so the read
   * answers absent. Without a walk on this connection one exact read by id
   * answers. No paired live and archived inventory is read.
   */
  async threadArchiveState(
    id: string,
  ): Promise<{ archivedAt: string | null; deleted: boolean } | null> {
    // A settled delete receipt is final, even before T3's shell streams the removal.
    if (this.deletedByReceipt.has(id)) return null;
    const live = await this.shellRow(id);
    if (live)
      return { archivedAt: live.archivedAt ?? null, deleted: !!live.deletedAt };
    if (this.retentionWalk) {
      const walked = this.retentionWalk.get(id);
      return walked
        ? { archivedAt: walked.archivedAt ?? null, deleted: !!walked.deletedAt }
        : null;
    }
    const record = await this.readThreadRecord(id);
    if (!record) return null;
    return {
      archivedAt: record.row.archivedAt ?? null,
      deleted: !!record.row.deletedAt,
    };
  }

  async observe(id: string): Promise<T3ThreadObservation> {
    this.core.requireConnection();
    const observed = this.observes(id);
    const native = await this.threadRow(id);
    if (native && (!observed || native.archivedAt || native.deletedAt)) {
      const record = agentRecord(this.core.state.read(), id);
      const active = !!native.activeRunId || activeStatuses.has(native.status);
      return {
        id,
        workspaceId: this.threadWorkspace(native),
        archived: !!native.archivedAt,
        status: shellThreadStatus(native),
        active,
        permissions: !!native.pendingRuntimeRequest,
        error: native.lastError ?? "",
        model: native.modelSelection.model,
        provider: native.modelSelection.instanceId,
        modeId: native.runtimeMode ?? null,
        updatedAt: native.updatedAt,
        activeTurnId: native.activeRunId,
        turnStartedAt: null,
        lastUserMessageAt: native.latestUserMessageAt,
        labels: record?.labels ?? {},
        pendingPermissionKinds: native.pendingRuntimeRequest
          ? [
              native.pendingRuntimeRequest.kind === "user_input"
                ? "question"
                : native.pendingRuntimeRequest.kind,
            ]
          : [],
        ...(native.pendingRuntimeRequest
          ? {
              pendingRequest: {
                id: native.pendingRuntimeRequest.id,
                kind:
                  native.pendingRuntimeRequest.kind === "user_input"
                    ? "question"
                    : native.pendingRuntimeRequest.kind,
                firstLine: null,
              },
            }
          : {}),
      };
    }
    let detail: Projection;
    try {
      detail =
        native && observed
          ? await this.readProjection(id, "observation")
          : await this.readDirectProjection(id, "observation");
    } catch (error) {
      if (isThreadNotFoundRpcError(error))
        return await this.observeThreadList(id);
      if (isTransientT3ReadRpcError(error))
        throw new T3TransientReadError(error);
      throw error;
    }
    const { thread } = detail;
    const shellNative =
      native ??
      (thread.archivedAt || thread.deletedAt
        ? undefined
        : await this.shellRow(id));
    const record = agentRecord(this.core.state.read(), id);
    const active = detail.runs.find((r) => activeStatuses.has(r.status));
    const pending = detail.runtimeRequests.filter(
      (r) => r.status === "pending",
    );
    // An archived thread is retired: it reports the terminal closed state, with
    // the archived fact on its own field for retained-read consumers.
    return {
      id,
      workspaceId: this.threadWorkspace(thread),
      archived: !!thread.archivedAt,
      status: thread.deletedAt
        ? "gone"
        : thread.archivedAt
          ? "closed"
          : active
            ? active.status
            : shellNative && activeStatuses.has(shellNative.status)
              ? shellNative.status
              : "idle",
      active:
        thread.archivedAt || thread.deletedAt
          ? false
          : !!active ||
            !!shellNative?.activeRunId ||
            (!!shellNative && activeStatuses.has(shellNative.status)),
      permissions:
        thread.archivedAt || thread.deletedAt
          ? false
          : pending.length > 0 || !!shellNative?.pendingRuntimeRequest,
      error: shellNative?.lastError ?? "",
      model: thread.modelSelection.model,
      provider: thread.modelSelection.instanceId,
      modeId: thread.runtimeMode ?? null,
      updatedAt: detail.updatedAt,
      activeTurnId:
        thread.archivedAt || thread.deletedAt
          ? null
          : (active?.id ?? shellNative?.activeRunId ?? null),
      turnStartedAt:
        thread.archivedAt || thread.deletedAt
          ? null
          : (active?.startedAt ?? null),
      lastUserMessageAt: shellNative?.latestUserMessageAt ?? null,
      labels: record?.labels ?? {},
      pendingPermissionKinds:
        thread.archivedAt || thread.deletedAt
          ? []
          : pending.map((r) => (r.kind === "user_input" ? "question" : r.kind)),
      ...(!(thread.archivedAt || thread.deletedAt) && pending[0]
        ? {
            pendingRequest: {
              id: pending[0].id,
              kind:
                pending[0].kind === "user_input" ? "question" : pending[0].kind,
              firstLine: null,
            },
          }
        : {}),
    };
  }
  /**
   * The live agents the board and Settings list. While the live shell reopens
   * (past its freshness bound, or after a dropped stream) the last copy answers at
   * once, so a picker never waits on a busy T3; a decision never reads this.
   */
  async listLiveAgents() {
    this.core.requireConnection();
    const { threads, projects } = await this.live.currentOrLast();
    // The first listed thread still proves an unproven thread shape.
    await this.probePendingThreadShape(threads);
    const state = this.core.state.read();
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const parentTaskByThread = new Map(
      Object.entries(state.parents ?? {}).map(([taskId, parent]) => [
        parent.threadId,
        taskId,
      ]),
    );
    const inboxThreadId = state.inbox?.threadId ?? null;
    return threads
      .filter((t) => !t.archivedAt && !t.deletedAt)
      .map((t) => {
        const root = projectById.get(t.projectId)?.workspaceRoot ?? null;
        const recordedLabels = agentRecord(state, t.id)?.labels;
        const parentTaskId = parentTaskByThread.get(t.id);
        const labels =
          recordedLabels && Object.keys(recordedLabels).length > 0
            ? recordedLabels
            : parentTaskId
              ? {
                  [WIRE_LABEL_KEYS.task]: parentTaskId,
                  [WIRE_LABEL_KEYS.role]: "parent",
                }
              : t.id === inboxThreadId
                ? { [WIRE_LABEL_KEYS.role]: "inbox" }
                : t.providerInstanceId === "nucleus"
                  ? { [WIRE_LABEL_KEYS.role]: "parent" }
                  : t.lineage?.relationshipToParent === "subagent" ||
                      t.id.startsWith("thread:subagent:") ||
                      t.id.startsWith("thread:delegated-task:")
                    ? { [WIRE_LABEL_KEYS.role]: "subagent" }
                    : {};
        return {
          id: t.id,
          title: t.title,
          workspaceId: this.threadWorkspace(t),
          directory: t.worktreePath ?? root,
          repositoryRoot: root,
          updatedAt: t.updatedAt,
          labels,
        };
      });
  }

  /**
   * One thread that has left observation, answered from T3's own thread list and the
   * launch identity this host recorded. That row already carries the thread record,
   * its status, active run and pending request — everything an observation reports —
   * so nothing needs a full snapshot to read it (nucleus#1328). Absence from the
   * complete list is the deletion proof, and it is the one case that has no answer.
   */
  private async observeThreadList(id: string): Promise<T3ThreadObservation> {
    const row = await this.readListRow(id);
    if (!row) throw new T3UnobservedThreadError(id);
    const record = agentRecord(this.core.state.read(), id);
    const active = !!row.activeRunId || activeStatuses.has(row.status);
    return {
      id,
      workspaceId: this.threadWorkspace(row),
      archived: !!row.archivedAt,
      // The same status the workspace inventory reports: a finished run reads as idle,
      // an archived thread as closed and a removed one as gone.
      status: shellThreadStatus(row),
      active,
      permissions: !!row.pendingRuntimeRequest,
      error: row.lastError ?? "",
      model: row.modelSelection.model,
      provider: row.modelSelection.instanceId,
      modeId: row.runtimeMode ?? null,
      updatedAt: row.updatedAt,
      activeTurnId: row.activeRunId,
      turnStartedAt: null,
      lastUserMessageAt: row.latestUserMessageAt,
      labels: record?.labels ?? {},
      pendingPermissionKinds: row.pendingRuntimeRequest
        ? [
            row.pendingRuntimeRequest.kind === "user_input"
              ? "question"
              : row.pendingRuntimeRequest.kind,
          ]
        : [],
      ...(row.pendingRuntimeRequest
        ? {
            pendingRequest: {
              id: row.pendingRuntimeRequest.id,
              kind:
                row.pendingRuntimeRequest.kind === "user_input"
                  ? "question"
                  : row.pendingRuntimeRequest.kind,
              firstLine: null,
            },
          }
        : {}),
    };
  }

  /**
   * The newest bounded tool window, not a reconstruction of thread history.
   * Retained request/interrupt dependencies are not rendered window rows. Core
   * combines this window with fresh inactivity and owned-process observations;
   * an older idle provider thread's internal tasks are a known T3 limitation.
   */
  async agentTimelinePage(
    id: string,
    _limit = 100,
  ): Promise<HostTimelinePage | null> {
    let read: ThreadSnapshotRead;
    try {
      read = await this.readThreadSnapshot(id, "window");
    } catch (error) {
      if (isTransientT3ReadRpcError(error))
        throw new T3TransientReadError(error);
      throw error;
    }
    const rows = read.projection.visibleTurnItems;
    if (!rows)
      throw new T3CompatibilityError("subscribeThread.visibleTurnItems");
    if (!read.projection.providerThreads)
      throw new T3CompatibilityError("subscribeThread.providerThreads");
    // Never trim the provider's window: doing so could drop live tool evidence.
    // The shared reader does not widen bounded liveness evidence through history.
    const block = localRows(rows, id);
    const entries = block.map((row) =>
      timelineEntry(row, read.projection.updatedAt),
    );
    const oldest = block.at(0),
      newest = block.at(-1);
    return {
      entries,
      hasOlder: read.paged,
      gap: false,
      staleCursor: false,
      reset: false,
      hasNewer: false,
      epoch: id,
      startCursor: oldest ? { epoch: id, seq: oldest.item.ordinal } : null,
      endCursor: newest ? { epoch: id, seq: newest.item.ordinal } : null,
      projection: "bounded",
      pendingBackgroundTasks: backgroundTasks(read.projection.providerThreads),
    };
  }

  /** The newest page's entries only. A failure reads as no evidence here, as on every host. */
  async agentTimeline(id: string, limit?: number) {
    try {
      return (await this.agentTimelinePage(id, limit))?.entries ?? null;
    } catch {
      return null;
    }
  }

  async activeRunId(id: string): Promise<string | null> {
    const native = await this.threadRow(id);
    if (native && (native.archivedAt || native.deletedAt))
      return native.activeRunId ?? null;
    if (!this.observes(id)) {
      try {
        const projection = await this.readDirectProjection(id, "observation");
        return (
          projection.runs.find((r) => activeStatuses.has(r.status))?.id ??
          native?.activeRunId ??
          null
        );
      } catch (error) {
        if (isTransientT3ReadRpcError(error))
          throw new T3TransientReadError(error);
        if (!isThreadNotFoundRpcError(error)) throw error;
        const row = await this.readListRow(id);
        return row?.activeRunId ?? null;
      }
    }
    let projection: Projection;
    try {
      projection = native
        ? await this.readProjection(id, "observation")
        : await this.readDirectProjection(id, "observation");
    } catch (error) {
      if (isTransientT3ReadRpcError(error))
        throw new T3TransientReadError(error);
      if (!isThreadNotFoundRpcError(error)) throw error;
      const row = await this.readListRow(id);
      return row?.activeRunId ?? null;
    }
    return (
      projection.runs.find((r) => activeStatuses.has(r.status))?.id ??
      native?.activeRunId ??
      null
    );
  }
  /** Drop the snapshot held for one thread, because a command is about to change it. */
  forget(threadId: string) {
    this.held.delete(threadId);
    this.projectionHeld.delete(threadId);
    this.absent.delete(threadId);
    this.written.add(threadId);
    this.forgetEpochs.set(threadId, this.forgetEpoch(threadId) + 1);
  }

  /**
   * Every run of this thread that is live, the identity an explicit stop names. A
   * thread that has left observation still answers from the thread list's own
   * `activeRunId`, because stopping a live turn is a control action and not a read of
   * the thread this host stopped paying for. A list that cannot be read is an error:
   * a stop must never report success because it could not look (nucleus#1328 review).
   */
  async activeRunIds(id: string): Promise<string[]> {
    const native = await this.threadRow(id);
    if (native && (native.archivedAt || native.deletedAt))
      return native.activeRunId ? [native.activeRunId] : [];
    let projection: Projection;
    try {
      projection =
        native && this.observes(id)
          ? await this.readProjection(id, "observation")
          : await this.readDirectProjection(id, "observation");
    } catch (error) {
      if (isTransientT3ReadRpcError(error))
        throw new T3TransientReadError(error);
      if (!isThreadNotFoundRpcError(error)) throw error;
      const row = await this.readListRow(id);
      return row?.activeRunId ? [row.activeRunId] : [];
    }
    return projection.runs
      .filter((r) => activeStatuses.has(r.status))
      .map((r) => r.id)
      .sort();
  }
  /**
   * A thread's pending native questions, read from the bounded snapshot. The
   * nightly keeps every pending runtime request and the `user_input_request` item
   * that carries its questions, so a long thread answers this read without a
   * full transcript (nucleus#1217). A pending request whose item the window does
   * not carry is reported precisely: the item cannot be fetched by itself, and a
   * window is never widened into the full snapshot.
   */
  async pendingQuestions(id: string) {
    if (!(await this.isObserved(id))) return [];
    // Only a thread T3's shell marks as awaiting input is read for its questions
    // (Spec 069 batch 5); a thread just written to keeps its exact read.
    const row = await this.shellRow(id);
    if (row && !row.pendingRuntimeRequest && !this.written.has(id)) return [];
    const p = await this.readProjection(id, "window");
    return p.runtimeRequests
      .filter((r) => r.kind === "user_input" && r.status === "pending")
      .map((r) => {
        const item = p.turnItems.find(
          (t) => t.type === "user_input_request" && t.requestId === r.id,
        );
        if (!item?.questions)
          throw new T3CompatibilityError(
            `runtimeRequest.${r.id}.user_input_request is outside the bounded timeline window`,
          );
        return {
          requestId: r.id,
          questions: item.questions.map((q) => ({
            header: q.header,
            question: q.question,
            options: q.options.map((o) => o.label),
          })),
        };
      });
  }

  /**
   * A thread's answered native questions, read from the bounded snapshot. The
   * nightly keeps the resolved requests its window still references, so this is
   * the newest answered window rather than every answer a thread ever had: a
   * resolved request the window dropped is absent, and one whose question item
   * the window dropped keeps its answers with no question text rather than an
   * invented one. Only a complete transcript could enumerate the whole history,
   * and a long thread has no such read (nucleus#1217).
   */
  async answeredQuestions(id: string) {
    // A projection this read cannot trust answers nothing: the caller must see
    // an unknown read, not an operator who answered nothing.
    let p: Projection;
    try {
      if (!(await this.isObserved(id)))
        return {
          ok: false as const,
          reason: "T3Code thread is no longer observed",
        };
      p = await this.readProjection(id, "window");
    } catch (error) {
      return {
        ok: false as const,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      ok: true as const,
      answered: p.runtimeRequests
        .filter(
          (r) =>
            r.kind === "user_input" && r.status === "resolved" && r.answers,
        )
        .map((r) => ({
          requestId: r.id,
          question:
            p.turnItems
              .find((t) => t.requestId === r.id)
              ?.questions?.map((q) => q.question)
              .join("\n") ?? "",
          answers: Object.fromEntries(
            Object.entries(r.answers!).map(([k, v]) => [
              k,
              typeof v === "string" ? v : JSON.stringify(v),
            ]),
          ),
        })),
    };
  }

  async runtimeRequest(
    agent: string,
    workspace: string,
    id: string,
    kind: ThreadReadKind = "observation",
  ) {
    this.core.requireConnection();
    if (!this.observes(agent))
      throw new ProvenPreSendRefusalError(
        "T3Code thread is no longer observed",
      );
    let p: Projection;
    try {
      p = await this.readDirectProjection(agent, kind);
    } catch (error) {
      if (isThreadNotFoundRpcError(error))
        throw new ProvenPreSendRefusalError(
          "T3Code thread is no longer observed",
        );
      if (isTransientT3ReadRpcError(error))
        throw new T3TransientReadError(error);
      throw error;
    }
    if (p.thread.archivedAt || p.thread.deletedAt)
      throw new ProvenPreSendRefusalError(
        "T3Code thread is no longer observed",
      );
    if (this.workspaceFor(p.thread) !== workspace)
      throw new ProvenPreSendRefusalError(
        "T3Code runtime request workspace changed",
      );
    const request = p.runtimeRequests.find((r) => r.id === id);
    if (
      !request ||
      request.status !== "pending" ||
      request.responseCapability.type === "not_resumable"
    )
      throw new ProvenPreSendRefusalError(
        "T3Code runtime request is no longer answerable",
      );
    return { request, projection: p };
  }
}
