import { z } from 'zod';
import type { Task } from '../../shared/contracts';
import type { HostThread, HostTimelinePage } from '../../shared/host';
import { ProvenPreSendRefusalError } from '../../core/host';
import type { T3RpcClient } from './rpc';
import { agentRecord, canonical, type T3StateFile } from './state';
import { labelTask } from './one-row';
import { decode, shellSnapshot, projection, threadSnapshot, threadSnapshotCoverage, shellThread, project, T3CompatibilityError } from './contracts';

/**
 * What one thread snapshot is for. Observation needs the thread record, its runs
 * and its runtime requests; a window read needs the newest bounded suffix of the
 * timeline; a transcript read needs every turn item and refuses a bounded window
 * that left history behind. No read requests a full snapshot.
 */
export type ThreadReadKind = 'observation' | 'window' | 'transcript';
export type Projection = z.infer<typeof projection>;
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
/** Both thread lists at one snapshot sequence, as one inventory read answers them. */
export interface T3Inventory { projects: z.infer<typeof project>[]; threads: ShellRow[] }
/**
 * A read for a thread this host no longer observes: its Nucleus task is over, or
 * T3's own thread list reports it archived or removed (nucleus#1328). Leaving
 * observation never deletes, archives or edits the thread; it only stops paying a
 * full snapshot to read it on every sweep, and a caller that still asks is told so
 * instead of being handed a made-up state.
 */
export class T3UnobservedThreadError extends Error {
  constructor(readonly threadId: string) { super(`T3Code thread ${threadId} is no longer observed`); this.name = 'T3UnobservedThreadError'; }
}
/** The phases in which a task is over, so its threads need no observation. */
const terminalTaskPhases = new Set(['done', 'cancelled']);
/** One thread observation as this host reports it: a snapshot's answer, or the thread list's. */
export interface T3ThreadObservation {
  id: string; workspaceId: string | null; archived: boolean; status: string; active: boolean; permissions: boolean;
  error: string; model: string; provider: string; modeId: string | null; updatedAt: string;
  activeTurnId: string | null; turnStartedAt: string | null; lastUserMessageAt: string | null;
  labels: Record<string, string>; pendingPermissionKinds: string[];
  pendingRequest?: { id: string; kind: string; firstLine: string | null };
}
/**
 * Whether one held snapshot answers a read of this kind: an observation needs no
 * coverage, a window read needs the turn items, and a transcript read needs every
 * turn item the thread has.
 */
function snapshotCovers(read: ThreadSnapshotRead, kind: ThreadReadKind): boolean {
  if (kind === 'observation') return true;
  if (read.omitsTurnItems) return false;
  return kind === 'window' || !read.paged;
}
/** Native executions use shared tool kinds; background commands, children and dynamic tools can outlive their run. */
const nativeToolKinds: Record<string, string> = { command_execution: 'shell', file_change: 'edit',
  file_search: 'search', web_search: 'fetch', subagent: 'subagent', dynamic_tool: 'dynamic_tool' };
/** The one identity a native execution item names, as text the reader can compare. */
const nativeToolIdentity = (item: Record<string, unknown>): string => {
  const value = item.input ?? item.fileName ?? item.pattern ?? item.patterns ?? item.subagentId ?? item.toolName;
  if (typeof value === 'string') return value.slice(0, 200);
  if (Array.isArray(value)) return value.filter(part => typeof part === 'string').join(' ').slice(0, 200);
  return '';
};
type TimelineRow = { position: number; sourceThreadId?: string; sourceItemId: string; item: { id: string; type: string; ordinal: number;
  runId?: string | null; createdAt?: string; updatedAt?: string } };
/** This thread's own rendered rows, oldest first: an inherited row belongs to another agent. */
const localRows = (rows: readonly TimelineRow[], threadId: string): TimelineRow[] =>
  rows.filter(row => (row.sourceThreadId ?? threadId) === threadId && row.item).sort((a, b) => a.position - b.position);
/** One row as the shared timeline entry, with a native execution translated into a tool entry. */
const timelineEntry = (row: TimelineRow, fallback: string): import('../../shared/host').HostTimelineEntry => {
  const item = row.item as typeof row.item & Record<string, unknown>;
  const timestamp = item.updatedAt ?? item.createdAt ?? fallback;
  const turnId = item.runId ? { turnId: item.runId } : {};
  const kind = nativeToolKinds[item.type];
  if (kind === undefined) return { timestamp, ...turnId, item };
  const name = typeof item.title === 'string' && item.title.trim() ? item.title : item.type;
  return { timestamp, ...turnId, item: { type: 'tool_call', callId: item.id, name, status: String(item.status ?? ''),
    detail: { type: kind, command: nativeToolIdentity(item), nativeType: item.type } } };
};
/** The statuses that mean a run is live: the only ones a settle, a steer or a stop waits for. */
export const activeStatuses = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const inventoryReadAttempts = 5;

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
  private compatibilityError = '';
  /**
   * The tasks this host still works on, from the last host pass. `null` until the
   * first pass states them: a fresh host has no fact that any thread is over, and
   * observing everything is the conservative reading of no evidence.
   */
  private liveTasks: ReadonlySet<string> | null = null;
  /** One snapshot per thread, kept at the change marker it was read at. */
  private held = new Map<string, { marker: string; pass: number; read: ThreadSnapshotRead }>();
  /** The pass the reads currently happen in; a new pass may still reuse an unchanged snapshot. */
  private pass = 0;
  /** One pass's thread list, shared by every consumer in it. */
  private inventoryHeld: Promise<T3Inventory> | null = null;
  private passing = false;
  constructor(private readonly core: T3ReadContext) {}

  /**
   * The pass opens: these are the tasks the host still works on, and every read in
   * this pass shares one thread list and one snapshot per thread. A thread whose
   * task is over, or that T3 reports archived or removed, leaves observation here.
   */
  beginPass(tasks: readonly Task[]) {
    this.passing = true; this.pass++; this.inventoryHeld = null; this.noteTaskFacts(tasks);
  }
  /** The pass closes: the next one reads the thread list afresh and may still reuse unchanged snapshots. */
  endPass() { this.passing = false; this.inventoryHeld = null; }
  /** The task facts alone, for a caller that states them outside a pass. */
  noteTaskFacts(tasks: readonly Task[]) {
    this.liveTasks = new Set(tasks.filter(task => !task.removedAt && !terminalTaskPhases.has(task.phase)).map(task => task.id));
  }
  /** A connection or host identity change proves nothing about the threads it last saw. */
  resetObservation() { this.liveTasks = null; this.held.clear(); this.pass = 0; this.passing = false; this.inventoryHeld = null; }

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
   * The same, with T3's own terminal facts: a thread its thread list reports
   * archived or removed has left observation whatever its task says. A thread the
   * list does not carry at all is left to the read that asked, which is what proves
   * a deletion today. An unreadable list proves no terminal fact, so the task facts
   * alone answer.
   */
  async isObserved(threadId: string): Promise<boolean> {
    if (!this.observes(threadId)) return false;
    const row = await this.listRow(threadId);
    return !row || (!row.archivedAt && !row.deletedAt);
  }
  /** One thread's row in T3's thread list, or undefined when the list cannot answer. */
  private async listRow(threadId: string): Promise<ShellRow | undefined> {
    try { return (await this.memoisedInventory()).threads.find(row => row.id === threadId); } catch { return undefined; }
  }
  /**
   * One thread's row inside a pass: the change marker for its snapshot. Only a pass
   * holds a thread list, so an out-of-pass read asks T3 for the thread itself rather
   * than paying for the whole list first — a callback's fresh read stays as fresh as
   * it was before this window existed.
   */
  private async threadRow(threadId: string): Promise<ShellRow | undefined> {
    if (!this.passing) return undefined;
    return this.listRow(threadId);
  }
  /** The pass's thread list, read once; an out-of-pass read always asks T3 afresh. */
  private async memoisedInventory(): Promise<T3Inventory> {
    if (!this.passing) return this.inventory();
    if (!this.inventoryHeld) this.inventoryHeld = this.inventory();
    return this.inventoryHeld;
  }

  /** A thread shape this connection has not yet proved by reading one thread. */
  get threadShapePending() { return this.pendingThreadShape; }
  get compatibilityFailure() { return this.compatibilityError; }
  resetShape() { this.pendingThreadShape = false; this.compatibilityError = ''; }
  markShapePending(pending = true) { this.pendingThreadShape = pending; }
  async readShell() {
    let snapshot: z.infer<typeof shellSnapshot> | undefined;
    await this.core.rpc.readStream('orchestration.subscribeShell', { requestCompletionMarker: true }, value => {
      const item = decode(z.object({ kind: z.string() }).passthrough(), value, 'subscribeShell');
      if (item.kind === 'snapshot') {
        if ('resolvedRepositoryIdentityRoots' in item) return false;
        if (snapshot) throw new T3CompatibilityError('subscribeShell: duplicate authoritative snapshot');
        snapshot = decode(shellSnapshot, item.snapshot, 'subscribeShell.snapshot');
      } else if (item.kind === 'synchronized') {
        if (!snapshot) throw new T3CompatibilityError('subscribeShell.snapshot missing');
        return true;
      } else throw new T3CompatibilityError('subscribeShell: state changed during snapshot');
      return false;
    });
    return snapshot!;
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
  async readProjection(threadId: string, kind: ThreadReadKind = 'transcript'): Promise<Projection> {
    return (await this.readThreadSnapshot(threadId, kind)).projection;
  }

  /** One thread snapshot plus the nightly's own window coverage. */
  private async readThreadSnapshot(threadId: string, kind: ThreadReadKind): Promise<ThreadSnapshotRead> {
    // Observation is a bounded window of this host's own: a thread whose task is
    // over is not read, and neither is one T3's list reports archived or removed.
    if (!this.observes(threadId)) throw new T3UnobservedThreadError(threadId);
    const row = await this.threadRow(threadId);
    if (row?.archivedAt || row?.deletedAt) throw new T3UnobservedThreadError(threadId);
    // The thread list is the change marker: an unchanged row means the snapshot
    // this pass already holds is the same answer, so T3 is not asked again. A
    // thread T3's list does not carry at all keeps its own read, unabridged.
    const marker = row ? canonical(row) : '';
    const held = marker ? this.held.get(threadId) : undefined;
    if (held && held.marker === marker && snapshotCovers(held.read, kind)
        // The list summarizes one pending request; while one is pending the read
        // that carries its questions is never skipped.
        && (held.pass === this.pass || !row?.pendingRuntimeRequest)) return held.read;
    const read = await this.readFreshSnapshot(threadId, kind);
    if (marker) this.held.set(threadId, { marker, pass: this.pass, read });
    else this.held.delete(threadId);
    return read;
  }

  /** One fresh synchronized thread snapshot, with no reuse: the nightly's own answer. */
  private async readFreshSnapshot(threadId: string, kind: ThreadReadKind): Promise<ThreadSnapshotRead> {
    let read: Omit<ThreadSnapshotRead, 'omitsTurnItems'> | undefined;
    try {
      await this.core.rpc.readStream('orchestration.subscribeThread', {
        threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true,
      }, value => {
        const item = decode(z.object({ kind: z.string() }).passthrough(), value, 'subscribeThread');
        if (item.kind === 'snapshot') {
          if (read) throw new T3CompatibilityError('subscribeThread: duplicate authoritative snapshot');
          const complete = decode(threadSnapshot, item, 'subscribeThread');
          const coverage = threadSnapshotCoverage(complete);
          if (kind === 'transcript' && (coverage.paged || coverage.omitsTurnItems))
            throw new T3CompatibilityError('subscribeThread: incomplete projection');
          // A window read consumes the turn items themselves. The compact form of
          // those rows (`turnItemsOmitLocalVisible`) cannot be restored here, so a
          // nightly that sent it would hand back a silent partial window.
          if (kind === 'window' && coverage.omitsTurnItems)
            throw new T3CompatibilityError('subscribeThread.turnItemsOmitLocalVisible');
          const snapshot = complete.projection;
          if (snapshot.thread.id !== threadId) throw new T3CompatibilityError('subscribeThread.thread.id');
          read = { projection: snapshot, paged: coverage.paged };
          (read as ThreadSnapshotRead).omitsTurnItems = coverage.omitsTurnItems;
        } else if (item.kind === 'synchronized') {
          if (!read) throw new T3CompatibilityError('subscribeThread.projection missing');
          return true;
        } else throw new T3CompatibilityError('subscribeThread: state changed during snapshot');
        return false;
      });
      this.pendingThreadShape = false;
      return read! as ThreadSnapshotRead;
    } catch (error) {
      if (this.pendingThreadShape && error instanceof T3CompatibilityError) {
        this.compatibilityError = error.message;
        this.core.close();
      }
      throw error;
    }
  }

  async inventory(): Promise<T3Inventory> {
    const inventory = await this.memoisedInventoryRead();
    if (this.pendingThreadShape && inventory.threads[0]) await this.readProjection(inventory.threads[0].id, 'observation');
    return inventory;
  }
  /**
   * The pass's inventory read. The shape probe runs after this promise is recorded,
   * so a thread read inside it reuses this same answer instead of reading the lists
   * a second time.
   */
  private async memoisedInventoryRead(): Promise<T3Inventory> {
    if (!this.passing) return this.readInventory();
    if (!this.inventoryHeld) this.inventoryHeld = this.readInventory();
    return this.inventoryHeld;
  }
  /** Both thread lists at one snapshot sequence, repeated while the sequence moves under us. */
  private async readInventory(): Promise<T3Inventory> {
    this.core.requireConnection();
    for (let attempt = 1; attempt <= inventoryReadAttempts; attempt++) {
      const shell = await this.readShell();
      const archived = decode(z.object({ schemaVersion: z.number().int().positive(), snapshotSequence: z.number().int().nonnegative(),
        projects: z.array(project), threads: z.array(shellThread) }), await this.core.rpc.call('orchestration.getArchivedShellSnapshot', {}), 'getArchivedShellSnapshot');
      // Both loaders report the application event cursor. If it moved between
      // reads, repeat the read-only pair until both describe the same snapshot.
      if (shell.snapshotSequence === archived.snapshotSequence)
        return { projects: shell.projects, threads: [...shell.threads, ...shell.archivedThreads, ...archived.threads] };
      if (attempt < inventoryReadAttempts) await new Promise(resolve => setTimeout(resolve, attempt * 10));
    }
    throw new T3CompatibilityError(`inventory kept moving between live and archived reads after ${inventoryReadAttempts} attempts`);
  }

  workspaceFor(thread: Projection['thread']) {
    return Object.values(this.core.state.read().workspaces).find(w => w.projectId === thread.projectId && w.directory === thread.worktreePath)?.id ?? null;
  }

  async activeAndArchivedThreads(): Promise<HostThread[]> {
    const { threads } = await this.inventory();
    return threads.map(t => ({ id: t.id, workspaceId: this.workspaceFor(t), labels: agentRecord(this.core.state.read(), t.id)?.labels ?? {},
      // The shell's own status, even for an archived thread: `archived` rides
      // its own flag, and the workspace archive proof reads terminal states.
      status: t.deletedAt ? 'gone' : t.status, archived: !!t.archivedAt,
      activeTurn: !!t.activeRunId || activeStatuses.has(t.status), pendingPermissionKinds: t.pendingRuntimeRequest ? [t.pendingRuntimeRequest.kind === 'user_input' ? 'question' : t.pendingRuntimeRequest.kind] : [] }));
  }

  async activeThreads() { return (await this.activeAndArchivedThreads()).filter(t => !t.archived && t.status !== 'gone'); }

  /**
   * The exact lookup: every thread whose recorded launch labels match, answered from
   * what this host recorded. A thread it still observes is re-read so a changed
   * retained workspace is refused; a thread that left observation answers from its
   * retired record, which is all that lookup needs (nucleus#1328).
   */
  async findAgents(labels: Record<string, string>) { this.core.requireConnection();
    const state = this.core.state.read(), matches = (candidate: { labels: Record<string, string> }) =>
      Object.entries(labels).every(([k,v]) => candidate.labels[k] === v);
    const live = Object.entries(state.agents).filter(([, agent]) => matches(agent));
    const retired = Object.entries(state.retiredAgents ?? {}).filter(([, agent]) => !agent.deletedAt && matches(agent));
    const found = await Promise.all(live.map(async ([id, {workspaceId}]) => {
      if (!this.observes(id)) return { id, workspaceId };
      const p = await this.readProjection(id, 'observation');
      if (this.workspaceFor(p.thread) !== workspaceId) throw new T3CompatibilityError('retained thread workspace changed');
      return {id,workspaceId};
    }));
    return [...found, ...retired.map(([id, {workspaceId}]) => ({ id, workspaceId }))];
  }

  async observe(id: string): Promise<T3ThreadObservation> {
    this.core.requireConnection();
    if (!await this.isObserved(id)) return await this.observeThreadList(id);
    const detail = await this.readProjection(id, 'observation'), { thread } = detail;
    const active = detail.runs.find(r => activeStatuses.has(r.status));
    const pending = detail.runtimeRequests.filter(r => r.status === 'pending');
    const native = (await this.inventory()).threads.find(t => t.id === id);
    // An archived thread is retired: it reports the terminal closed state, with
    // the archived fact on its own field for retained-read consumers.
    return { id, workspaceId: this.workspaceFor(thread), archived: !!thread.archivedAt,
      status: thread.deletedAt ? 'gone' : thread.archivedAt ? 'closed' : active ? active.status : native && activeStatuses.has(native.status) ? native.status : 'idle',
      active: !!active || !!native?.activeRunId || !!native && activeStatuses.has(native.status), permissions: pending.length > 0 || !!native?.pendingRuntimeRequest,
      error: native?.lastError ?? '', model: thread.modelSelection.model, provider: thread.modelSelection.instanceId,
      modeId: thread.runtimeMode ?? null,
      updatedAt: detail.updatedAt, activeTurnId: active?.id ?? native?.activeRunId ?? null, turnStartedAt: active?.startedAt ?? null,
      lastUserMessageAt: native?.latestUserMessageAt ?? null, labels: agentRecord(this.core.state.read(), id)?.labels ?? {},
      pendingPermissionKinds: pending.map(r => r.kind === 'user_input' ? 'question' : r.kind),
      ...(pending[0] ? { pendingRequest: { id: pending[0].id, kind: pending[0].kind === 'user_input' ? 'question' : pending[0].kind, firstLine: null } } : {}) };
  }
  async listLiveAgents() { return (await this.inventory()).threads.filter(t => !t.archivedAt && !t.deletedAt).map(t => ({ id: t.id, title: t.title, workspaceId: this.workspaceFor(t), labels: agentRecord(this.core.state.read(), t.id)?.labels ?? {} })); }

  /**
   * One thread that has left observation, answered from T3's own thread list and the
   * launch identity this host recorded. That row already carries the thread record,
   * its status, active run and pending request — everything an observation reports —
   * so nothing needs a full snapshot to read it (nucleus#1328). Absence from the
   * complete list is the deletion proof, and it is the one case that has no answer.
   */
  private async observeThreadList(id: string): Promise<T3ThreadObservation> {
    const row = await this.listRow(id);
    if (!row) throw new T3UnobservedThreadError(id);
    const record = agentRecord(this.core.state.read(), id);
    const active = !!row.activeRunId || activeStatuses.has(row.status);
    return { id, workspaceId: this.workspaceFor(row) ?? record?.workspaceId ?? null, archived: !!row.archivedAt,
      // The same status an observed thread reports: a finished run reads as idle, an
      // archived thread as closed and a removed one as gone.
      status: row.deletedAt ? 'gone' : row.archivedAt ? 'closed' : active ? row.status : 'idle', active, permissions: !!row.pendingRuntimeRequest,
      error: row.lastError ?? '', model: row.modelSelection.model, provider: row.modelSelection.instanceId,
      modeId: row.runtimeMode ?? null, updatedAt: row.updatedAt, activeTurnId: row.activeRunId, turnStartedAt: null,
      lastUserMessageAt: row.latestUserMessageAt, labels: record?.labels ?? {},
      pendingPermissionKinds: row.pendingRuntimeRequest ? [row.pendingRuntimeRequest.kind === 'user_input' ? 'question' : row.pendingRuntimeRequest.kind] : [],
      ...(row.pendingRuntimeRequest ? { pendingRequest: { id: row.pendingRuntimeRequest.id,
        kind: row.pendingRuntimeRequest.kind === 'user_input' ? 'question' : row.pendingRuntimeRequest.kind, firstLine: null } } : {}) };
  }

  /**
   * The newest bounded tool window, not a reconstruction of thread history.
   * Retained request/interrupt dependencies are not rendered window rows. Core
   * combines this window with fresh inactivity and owned-process observations;
   * an older idle provider thread's internal tasks are a known T3 limitation.
   */
  async agentTimelinePage(id: string, _limit = 100): Promise<HostTimelinePage | null> {
    let read: ThreadSnapshotRead;
    try { read = await this.readThreadSnapshot(id, 'window'); }
    catch (error) { if (error instanceof T3CompatibilityError) throw error; return null; }    const rows = read.projection.visibleTurnItems;
    if (!rows) throw new T3CompatibilityError('subscribeThread.visibleTurnItems');
    if (!read.projection.providerThreads) throw new T3CompatibilityError('subscribeThread.providerThreads');
    // Never trim the provider's window: doing so could drop live tool evidence.
    // The shared reader does not widen bounded liveness evidence through history.
    const block = localRows(rows, id);
    const entries = block.map(row => timelineEntry(row, read.projection.updatedAt));
    const oldest = block.at(0), newest = block.at(-1);
    return { entries, hasOlder: read.paged, gap: false, staleCursor: false, reset: false, hasNewer: false,
      epoch: id, startCursor: oldest ? { epoch: id, seq: oldest.item.ordinal } : null,
      endCursor: newest ? { epoch: id, seq: newest.item.ordinal } : null, projection: 'bounded',
      pendingBackgroundTasks: read.projection.providerThreads.flatMap(thread => (thread.pendingBackgroundTasks ?? [])
        .map(task => `${task.kind} ${task.taskId}`)) };
  }

  /** The newest page's entries only. A failure reads as no evidence here, as on every host. */
  async agentTimeline(id: string, limit?: number) {
    try { return (await this.agentTimelinePage(id, limit))?.entries ?? null; } catch { return null; }
  }

  async activeRunId(id: string): Promise<string | null> {
    if (!await this.isObserved(id)) return (await this.listRow(id))?.activeRunId ?? null;
    const projection = await this.readProjection(id, 'observation');
    const native = (await this.inventory()).threads.find(t => t.id === id);
    return projection.runs.find(r => activeStatuses.has(r.status))?.id ?? native?.activeRunId ?? null;
  }
  /**
   * Every run of this thread that is live, the identity an explicit stop names. A
   * thread that has left observation still answers from the thread list's own
   * `activeRunId`: stopping a live turn is a control action, not a read of the
   * thread this host stopped paying for (nucleus#1328 review).
   */
  async activeRunIds(id: string): Promise<string[]> {
    if (!await this.isObserved(id)) {
      const row = await this.listRow(id);
      return row?.activeRunId ? [row.activeRunId] : [];
    }
    const projection = await this.readProjection(id, 'observation');
    return projection.runs.filter(r => activeStatuses.has(r.status)).map(r => r.id).sort();
  }
  /**
   * A thread's pending native questions, read from the bounded snapshot. The
   * nightly keeps every pending runtime request and the `user_input_request` item
   * that carries its questions, so a long thread answers this read without a
   * full transcript (nucleus#1217). A pending request whose item the window does
   * not carry is reported precisely: the item cannot be fetched by itself, and a
   * window is never widened into the full snapshot.
   */
  async pendingQuestions(id: string) { if (!await this.isObserved(id)) return [];
    const p = await this.readProjection(id, 'window'); return p.runtimeRequests.filter(r => r.kind === 'user_input' && r.status === 'pending').map(r => {
    const item = p.turnItems.find(t => t.type === 'user_input_request' && t.requestId === r.id);
    if (!item?.questions) throw new T3CompatibilityError(`runtimeRequest.${r.id}.user_input_request is outside the bounded timeline window`);
    return { requestId: r.id, questions: item.questions.map(q => ({ header: q.header, question: q.question, options: q.options.map(o => o.label) })) };
  }); }

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
    if (!await this.isObserved(id)) return { ok: false as const, reason: 'T3Code thread is no longer observed' };
    // A projection this read cannot trust answers nothing: the caller must see
    // an unknown read, not an operator who answered nothing.
    let p;
    try { p = await this.readProjection(id, 'window'); }
    catch (error) { return { ok: false as const, reason: error instanceof Error ? error.message : String(error) }; }
    return { ok: true as const, answered: p.runtimeRequests.filter(r => r.kind === 'user_input' && r.status === 'resolved' && r.answers).map(r => ({ requestId: r.id,
      question: p.turnItems.find(t => t.requestId === r.id)?.questions?.map(q => q.question).join('\n') ?? '',
      answers: Object.fromEntries(Object.entries(r.answers!).map(([k,v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) })) };
  }

  async runtimeRequest(agent: string, workspace: string, id: string, kind: ThreadReadKind = 'observation') {
    this.core.requireConnection();
    if (!await this.isObserved(agent)) throw new ProvenPreSendRefusalError('T3Code thread is no longer observed');
    const p = await this.readProjection(agent, kind); if (this.workspaceFor(p.thread) !== workspace) throw new ProvenPreSendRefusalError('T3Code runtime request workspace changed');
    const request = p.runtimeRequests.find(r => r.id === id);
    if (!request || request.status !== 'pending' || request.responseCapability.type === 'not_resumable') throw new ProvenPreSendRefusalError('T3Code runtime request is no longer answerable');
    return { request, projection: p };
  }
}
