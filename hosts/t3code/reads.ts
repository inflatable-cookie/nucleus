import { z } from 'zod';
import type { HostThread, HostTimelinePage } from '../../shared/host';
import { ProvenPreSendRefusalError } from '../../core/host';
import type { T3RpcClient } from './rpc';
import type { T3StateFile } from './state';
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
export interface ThreadSnapshotRead { projection: Projection; paged: boolean }
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
  constructor(private readonly core: T3ReadContext) {}

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
    let read: ThreadSnapshotRead | undefined;
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
        } else if (item.kind === 'synchronized') {
          if (!read) throw new T3CompatibilityError('subscribeThread.projection missing');
          return true;
        } else throw new T3CompatibilityError('subscribeThread: state changed during snapshot');
        return false;
      });
      this.pendingThreadShape = false;
      return read!;
    } catch (error) {
      if (this.pendingThreadShape && error instanceof T3CompatibilityError) {
        this.compatibilityError = error.message;
        this.core.close();
      }
      throw error;
    }
  }

  async inventory() {
    this.core.requireConnection();
    for (let attempt = 1; attempt <= inventoryReadAttempts; attempt++) {
      const shell = await this.readShell();
      const archived = decode(z.object({ schemaVersion: z.number().int().positive(), snapshotSequence: z.number().int().nonnegative(),
        projects: z.array(project), threads: z.array(shellThread) }), await this.core.rpc.call('orchestration.getArchivedShellSnapshot', {}), 'getArchivedShellSnapshot');
      // Both loaders report the application event cursor. If it moved between
      // reads, repeat the read-only pair until both describe the same snapshot.
      if (shell.snapshotSequence === archived.snapshotSequence) {
        const threads = [...shell.threads, ...shell.archivedThreads, ...archived.threads];
        if (this.pendingThreadShape && threads[0]) await this.readProjection(threads[0].id, 'observation');
        return { projects: shell.projects, threads };
      }
      if (attempt < inventoryReadAttempts) await new Promise(resolve => setTimeout(resolve, attempt * 10));
    }
    throw new T3CompatibilityError(`inventory kept moving between live and archived reads after ${inventoryReadAttempts} attempts`);
  }

  workspaceFor(thread: Projection['thread']) {
    return Object.values(this.core.state.read().workspaces).find(w => w.projectId === thread.projectId && w.directory === thread.worktreePath)?.id ?? null;
  }

  async activeAndArchivedThreads(): Promise<HostThread[]> {
    const { threads } = await this.inventory();
    return threads.map(t => ({ id: t.id, workspaceId: this.workspaceFor(t), labels: this.core.state.read().agents[t.id]?.labels ?? {},
      // The shell's own status, even for an archived thread: `archived` rides
      // its own flag, and the workspace archive proof reads terminal states.
      status: t.deletedAt ? 'gone' : t.status, archived: !!t.archivedAt,
      activeTurn: !!t.activeRunId || activeStatuses.has(t.status), pendingPermissionKinds: t.pendingRuntimeRequest ? [t.pendingRuntimeRequest.kind === 'user_input' ? 'question' : t.pendingRuntimeRequest.kind] : [] }));
  }

  async activeThreads() { return (await this.activeAndArchivedThreads()).filter(t => !t.archived && t.status !== 'gone'); }

  async findAgents(labels: Record<string, string>) { this.core.requireConnection();
    const candidates = Object.values(this.core.state.read().agents).filter(a => Object.entries(labels).every(([k,v]) => a.labels[k] === v));
    return Promise.all(candidates.map(async ({id,workspaceId}) => {
      const p = await this.readProjection(id, 'observation');
      if (this.workspaceFor(p.thread) !== workspaceId) throw new T3CompatibilityError('retained thread workspace changed');
      return {id,workspaceId};
    }));
  }

  async observe(id: string) {
    this.core.requireConnection(); const detail = await this.readProjection(id, 'observation'), { thread } = detail;
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
      lastUserMessageAt: native?.latestUserMessageAt ?? null, labels: this.core.state.read().agents[id]?.labels ?? {},
      pendingPermissionKinds: pending.map(r => r.kind === 'user_input' ? 'question' : r.kind),
      ...(pending[0] ? { pendingRequest: { id: pending[0].id, kind: pending[0].kind === 'user_input' ? 'question' : pending[0].kind, firstLine: null } } : {}) };
  }
  async listLiveAgents() { return (await this.inventory()).threads.filter(t => !t.archivedAt && !t.deletedAt).map(t => ({ id: t.id, title: t.title, workspaceId: this.workspaceFor(t), labels: this.core.state.read().agents[t.id]?.labels ?? {} })); }

  /**
   * The newest window of one thread's timeline (nucleus#1217). A long thread has
   * no complete transcript read, so a page describes exactly what the nightly's
   * bounded snapshot carried instead of asking for one: a contiguous newest
   * suffix, no gap, no newer history, the thread as its epoch and cursors as
   * positions inside the window. `hasOlder` is true when either the requested
   * depth or the nightly's own window left earlier history behind; the shared
   * owned-tool reader widens by asking for a deeper page, and a window that
   * cannot go deeper is reported by its own progress check, never as null.
   * `turnId` is the T3 run that owns the item: one run is one provider turn, so a
   * window that reaches back into an earlier run proves its partial coverage.
   */
  async agentTimelinePage(id: string, limit = 100): Promise<HostTimelinePage | null> {
    let read: ThreadSnapshotRead;
    try { read = await this.readThreadSnapshot(id, 'window'); }
    // An interrupted read stays unknown (`null`); a shape problem names its field
    // so the reader reports the exact cause instead of `unavailable`.
    catch (error) { if (error instanceof T3CompatibilityError) throw error; return null; }
    const items = read.projection.turnItems;
    const take = Number.isFinite(limit) ? Math.max(0, Math.min(items.length, Math.floor(limit))) : items.length;
    const start = items.length - take;
    const entries = items.slice(start).map(item => ({ timestamp: item.updatedAt ?? item.createdAt ?? read.projection.updatedAt,
      ...(item.runId ? { turnId: item.runId } : {}), item }));
    return { entries, hasOlder: start > 0 || read.paged, gap: false, staleCursor: false, reset: false, hasNewer: false,
      epoch: id, startCursor: entries.length ? { epoch: id, seq: start + 1 } : null,
      endCursor: entries.length ? { epoch: id, seq: items.length } : null, projection: 'projected' };
  }

  /** The newest page's entries only. A failure reads as no evidence here, as on every host. */
  async agentTimeline(id: string, limit?: number) {
    try { return (await this.agentTimelinePage(id, limit))?.entries ?? null; } catch { return null; }
  }

  async activeRunId(id: string): Promise<string | null> {
    const projection = await this.readProjection(id, 'observation');
    const native = (await this.inventory()).threads.find(t => t.id === id);
    return projection.runs.find(r => activeStatuses.has(r.status))?.id ?? native?.activeRunId ?? null;
  }
  /**
   * A thread's pending native questions, read from the bounded snapshot. The
   * nightly keeps every pending runtime request and the `user_input_request` item
   * that carries its questions, so a long thread answers this read without a
   * full transcript (nucleus#1217). A pending request whose item the window does
   * not carry is reported precisely: the item cannot be fetched by itself, and a
   * window is never widened into the full snapshot.
   */
  async pendingQuestions(id: string) { const p = await this.readProjection(id, 'window'); return p.runtimeRequests.filter(r => r.kind === 'user_input' && r.status === 'pending').map(r => {
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
  async answeredQuestions(id: string) { const p = await this.readProjection(id, 'window'); return p.runtimeRequests.filter(r => r.kind === 'user_input' && r.status === 'resolved' && r.answers).map(r => ({ requestId: r.id,
    question: p.turnItems.find(t => t.requestId === r.id)?.questions?.map(q => q.question).join('\n') ?? '',
    answers: Object.fromEntries(Object.entries(r.answers!).map(([k,v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) })); }

  async runtimeRequest(agent: string, workspace: string, id: string, kind: ThreadReadKind = 'observation') {
    this.core.requireConnection();
    const p = await this.readProjection(agent, kind); if (this.workspaceFor(p.thread) !== workspace) throw new ProvenPreSendRefusalError('T3Code runtime request workspace changed');
    const request = p.runtimeRequests.find(r => r.id === id);
    if (!request || request.status !== 'pending' || request.responseCapability.type === 'not_resumable') throw new ProvenPreSendRefusalError('T3Code runtime request is no longer answerable');
    return { request, projection: p };
  }
}
