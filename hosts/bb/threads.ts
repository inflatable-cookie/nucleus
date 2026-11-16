import { HostUnknownDeliveryError, ProvenPreSendRefusalError } from '../../core/host/errors';
import type { TimelinePage } from '../../core/host/types';
import type { AgentObservation } from '../../core/host/adapter';
import type { HostAgentSpec, HostCatalog } from '../../shared/host';
import type { HostOperationName, HostOperationOutcome } from '../../shared/host-operation';
import { parseHostOperationOutcome } from '../../shared/service/host-channel';
import { WIRE_LABEL_KEYS, wireLabels } from '../../shared/wire-labels';

export interface BbWorkspaceRecord {
  id: string; directory: string; repositoryRoot: string; projectId: string; title: string;
  environmentId?: string; archivedAt?: string;
}
interface BbAgent { id: string; task: string; run: string; role: string; workspaceId: string; labels: Record<string, string> }
interface SpawnIntent { task: string; run: string; workspaceId: string; attemptedAt: number; agentId?: string }
interface WriteIntent { status: 'unknown' | 'refused' | 'settled'; value?: string }
export interface BbThreadState { agents: Record<string, BbAgent>; spawns: Record<string, SpawnIntent>; writes: Record<string, WriteIntent> }
export const emptyBbThreadState = (): BbThreadState => ({ agents: {}, spawns: {}, writes: {} });
export interface BbThreadPorts {
  hostId: string;
  operation(op: HostOperationName, input: unknown): Promise<HostOperationOutcome>;
  state(): BbThreadState;
  save(state: BbThreadState): void;
  workspace(id: string): BbWorkspaceRecord | undefined;
  putWorkspace(workspace: BbWorkspaceRecord): void;
  parent(taskId: string): string;
  helperPath: string;
  ticketPath(runId: string): string;
  /** Only local pre-send errors and the channel's two proven refusal codes. */
  notSent(error: unknown): boolean;
  now?: () => number;
}
export interface BbRow {
  threadId: string; title: string | null; status: string; displayStatus: string; providerId: string;
  execution?: { model: string; permissionMode: string; reasoningLevel: string } | null;
  environmentId: string | null; environmentPath: string | null; parentThreadId: string | null;
  parentNotifications: string; originPluginId: string | null; archivedAt: number | null;
  updatedAt: number; queuedWork: string; hasPendingInteraction: boolean;
  interactions: Array<{ id: string; kind: string; status: string; title: string | null }>;
}
const chunks = <T>(items: readonly T[]): T[][] => Array.from({ length: Math.ceil(items.length / 200) }, (_, i) => items.slice(i * 200, i * 200 + 200));
const unknown = (reason: string) => new HostUnknownDeliveryError({ command: 'bb.threads.spawn', guidance: reason });

/** Native thread operations; persistence and lifecycle policy are supplied by the service. */
export class BbThreads {
  constructor(private readonly ports: BbThreadPorts) {}
  private async read<T>(op: HostOperationName, input: unknown): Promise<T> {
    const answer = parseHostOperationOutcome(op, await this.ports.operation(op, input));
    if (!answer.ok) throw new HostUnknownDeliveryError({ command: `bb.${op}`, guidance: answer.failure.message });
    const value = answer.value.value as Record<string, unknown>;
    const id = (input as { threadId?: string } | null)?.threadId;
    if (id && value.threadId !== id) throw new HostUnknownDeliveryError({ command: `bb.${op}`, guidance: 'The answer named a different thread' });
    return value as T;
  }
  private observation(row: BbRow): AgentObservation {
    const agent = this.ports.state().agents[row.threadId];
    const workspace = agent && this.ports.workspace(agent.workspaceId);
    const workspaceId = workspace?.environmentId === row.environmentId && workspace.directory === row.environmentPath ? agent.workspaceId : null;
    const pending = row.interactions.filter(i => i.status === 'pending' || i.status === 'resolving');
    if (row.hasPendingInteraction && !pending.length) throw new Error('BB pending interaction flag has no readable interaction');
    const active = ['starting', 'active', 'stopping'].includes(row.status) || ['provisioning', 'waiting-for-host'].includes(row.displayStatus) || row.queuedWork === 'waiting';
    if (!active) {
      const state = this.ports.state(); let changed = false;
      for (const [key, intent] of Object.entries(state.writes)) if (key.startsWith(`stop:${row.threadId}:`) && intent.status === 'unknown') { intent.status = 'settled'; changed = true; }
      if (changed) this.ports.save(state);
    }
    return {
      id: row.threadId, workspaceId,
      status: row.archivedAt !== null ? 'closed' : row.status,
      active, permissions: pending.length > 0,
      // A terminal execution status proves no tracked turn. Busy/pending rows
      // keep its identity unknown; BB sends no positive turn id in a list row.
      ...(!active && ['idle', 'error'].includes(row.status) ? { activeTurnId: null } : {}),
      error: row.status === 'error' ? 'BB thread failed' : row.queuedWork === 'failed' ? 'BB queued work failed' : '',
      provider: row.providerId,
      ...(row.execution ? { model: row.execution.model, modeId: row.execution.permissionMode, thinkingOptionId: row.execution.reasoningLevel } : {}),
      labels: agent?.labels, updatedAt: new Date(row.updatedAt).toISOString(),
      // BB list rows expose execution status, not an active-turn id or start stamp.
      ...(pending[0] ? { pendingRequest: { id: pending[0].id, kind: pending[0].kind, firstLine: pending[0].title }, pendingPermissionKinds: pending.map(i => i.kind) } : {}),
    };
  }
  async observe(id: string): Promise<AgentObservation> {
    const row = await this.read<BbRow>('thread.observe', { threadId: id });
    if (row.threadId !== id) throw new Error('BB observation answered another thread');
    return this.observation(row);
  }
  async observationInventory(ids: readonly string[]): Promise<ReadonlyMap<string, AgentObservation> | null> {
    const answer = new Map<string, AgentObservation>();
    try {
      for (const group of chunks([...new Set(ids)])) {
        const { rows } = await this.read<{ rows: BbRow[] }>('thread.read', { threadIds: group });
        if (rows.length !== group.length || new Set(rows.map(r => r.threadId)).size !== group.length || rows.some(r => !group.includes(r.threadId))) return null;
        for (const row of rows) answer.set(row.threadId, this.observation(row));
      }
      return answer;
    } catch { return null; }
  }
  private bind(threadId: string, environmentId: string | null, task: string, run: string, workspaceId: string, role: string) {
    const workspace = this.ports.workspace(workspaceId);
    if (!workspace || !environmentId || (workspace.environmentId && workspace.environmentId !== environmentId)) throw unknown('The spawn has no matching workspace environment; nothing was bound');
    // Environment custody must be durable before core sees a created run.
    this.ports.putWorkspace({ ...workspace, environmentId });
    const state = this.ports.state();
    state.agents[threadId] = { id: threadId, task, run, role, workspaceId, labels: wireLabels({ task, run, role }) };
    if (state.spawns[run]) state.spawns[run].agentId = threadId;
    this.ports.save(state);
    return { id: threadId, workspaceId };
  }
  async createAgent(spec: HostAgentSpec) {
    if (spec.mcpBindingPath) throw new ProvenPreSendRefusalError('BB uses helper reporting');
    if (spec.guard && (!await spec.guard.allowed() || !spec.guard.stillAllowed())) throw new ProvenPreSendRefusalError('BB launch guard changed');
    const attempt = spec.attempt(false, false);
    if (Object.keys(attempt.environment).length) throw new ProvenPreSendRefusalError('BB has no per-thread environment');
    const task = attempt.labels[WIRE_LABEL_KEYS.task], run = attempt.labels[WIRE_LABEL_KEYS.run], role = attempt.labels[WIRE_LABEL_KEYS.role] ?? 'worker';
    const workspace = this.ports.workspace(spec.workspaceId);
    if (!task || !run || !workspace?.projectId || workspace.archivedAt) throw new ProvenPreSendRefusalError('BB launch identity or workspace is incomplete');
    if (this.ports.state().spawns[run]) {
      const found = await this.findAgents(task, run);
      if (found.length === 1) return found[0];
      throw unknown('No exact metadata match is visible; the recorded spawn was not resent');
    }
    const parentThreadId = this.ports.parent(task);
    const mode = spec.profile.modeId;
    if (mode && !['default', 'full', 'auto', 'accept-edits'].includes(mode)) throw new ProvenPreSendRefusalError(`BB permission mode ${mode} is unavailable`);
    const input = {
      projectId: workspace.projectId, title: `${spec.taskNumber ? `#${spec.taskNumber} ` : ''}${spec.title}`.slice(0, 200),
      environmentPath: workspace.directory, parentThreadId, parentNotifications: 'off',
      prompt: attempt.prompt, providerId: spec.profile.provider, model: spec.profile.model,
      permissionMode: mode && mode !== 'default' ? mode : 'full',
      ...(spec.profile.thinkingOptionId ? { reasoningLevel: spec.profile.thinkingOptionId } : {}),
      ...(Object.keys(spec.profile.featureValues ?? {}).length ? { sessionOptions: spec.profile.featureValues } : {}),
      pluginMetadata: { nucleus: { task, run, role, host: this.ports.hostId, helperPath: this.ports.helperPath, ticketPath: this.ports.ticketPath(run) } },
    };
    const state = this.ports.state();
    state.spawns[run] = { task, run, workspaceId: spec.workspaceId, attemptedAt: (this.ports.now ?? Date.now)() };
    this.ports.save(state);
    let value: { threadId: string; environmentId: string; parentThreadId: string | null; parentNotifications: string; pluginMetadata: Record<string, unknown> | null };
    try {
      if (spec.guard && !spec.guard.stillAllowed()) throw new ProvenPreSendRefusalError('BB launch guard changed');
      value = await this.read('run.attach', input);
    } catch (error) {
      if (this.ports.notSent(error) || error instanceof ProvenPreSendRefusalError) {
        const next = this.ports.state(); delete next.spawns[run]; this.ports.save(next);
      }
      throw error;
    }
    const metadata = value.pluginMetadata?.nucleus as Record<string, unknown> | undefined;
    if (value.parentThreadId !== parentThreadId || value.parentNotifications !== 'off' || !metadata || !Object.entries(input.pluginMetadata.nucleus).every(([key, expected]) => metadata[key] === expected)) throw unknown('The attach answer changed the run metadata or parent');
    return this.bind(value.threadId, value.environmentId, task, run, spec.workspaceId, role);
  }
  /** Both origin walks must reach their positive end before any identity is bound. */
  async findAgents(task: string, run: string): Promise<Array<{ id: string; workspaceId: string | null }>> {
    const state = this.ports.state(), intent = state.spawns[run];
    if (!intent || intent.task !== task) return [];
    const candidates = new Map<string, BbRow>();
    for (const archived of [false, true]) {
      let complete = false;
      for (let offset = 0; offset < 100_000; offset += 200) {
        const page = await this.read<{ complete: boolean; rows: BbRow[] }>('thread.inventory', { originPluginId: 'nucleus', includeHidden: true, archived, offset });
        if (page.complete !== (page.rows.length < 200) || page.rows.some(r => r.originPluginId !== 'nucleus' || (r.archivedAt !== null) !== archived || candidates.has(r.threadId))) throw unknown('The origin walk was partial or repeated a row; nothing was bound');
        for (const row of page.rows) candidates.set(row.threadId, row);
        if (page.complete) { complete = true; break; }
      }
      if (!complete) throw unknown('The origin walk exceeded its bounded window; nothing was bound');
    }
    const matches: Array<{ row: BbRow; role: string }> = [];
    for (const ids of chunks([...candidates.keys()])) {
      const read = await this.read<{ threads: Array<{ threadId: string; metadata: Record<string, unknown> | null }> }>('thread.metadata', { threadIds: ids });
      if (read.threads.length !== ids.length || new Set(read.threads.map(r => r.threadId)).size !== ids.length || read.threads.some(r => !ids.includes(r.threadId))) throw unknown('Plugin metadata walk omitted a candidate; nothing was bound');
      for (const candidate of read.threads) {
        const meta = candidate.metadata?.nucleus as Record<string, unknown> | undefined;
        if (meta?.task === task && meta.run === run && meta.host === this.ports.hostId && typeof meta.role === 'string') matches.push({ row: candidates.get(candidate.threadId)!, role: meta.role });
      }
    }
    if (matches.length > 1) throw unknown('Two or more threads name the exact task and run; adoption is refused');
    if (!matches.length) {
      const elapsed = (this.ports.now ?? Date.now)() - intent.attemptedAt;
      // Never return an empty result to core's absent-worker replacement ladder.
      throw unknown(`Complete live and archived origin search found no exact task/run metadata match${elapsed >= 20_000 ? '; observation window expired, owner action is required' : '; a later sweep may adopt a late spawn'}. The run remains uncreated`);
    }
    const { row, role } = matches[0];
    const workspace = this.ports.workspace(intent.workspaceId);
    if (row.environmentPath !== workspace?.directory) throw unknown('The matching thread is attached to another directory');
    return [this.bind(row.threadId, row.environmentId, task, run, intent.workspaceId, role)];
  }
  async archiveAgent(id: string) {
    const owned = this.ports.state().agents[id];
    if (!owned) throw new ProvenPreSendRefusalError('BB archive only accepts a Nucleus-created thread');
    const row = await this.read<BbRow>('thread.observe', { threadId: id });
    if (row.archivedAt !== null) return;
    if (this.observation(row).active) throw new ProvenPreSendRefusalError('BB thread still has a live turn');
    const key = `archive:${id}`;
    if (this.ports.state().writes[key]?.status === 'unknown') throw new HostUnknownDeliveryError({ command: 'bb.thread.archive' });
    const cascade = await this.read<{ cascadeThreadIds: string[] }>('thread.cascade', { threadId: id, action: 'archive' });
    // Leaf archive only in phase 3. Multi-role children-first closeout is phase 4.
    if (cascade.cascadeThreadIds.some(child => child !== id)) throw new ProvenPreSendRefusalError('BB archive cascade contains an unretired dependent');
    await this.write(key, 'thread.archive', { threadId: id, expectedCascadeThreadIds: cascade.cascadeThreadIds });
  }
  private async write(key: string, op: HostOperationName, input: unknown) {
    const state = this.ports.state();
    if (state.writes[key]?.status === 'settled') return;
    state.writes[key] = { status: 'unknown', ...(op === 'thread.title' ? { value: (input as { title: string }).title } : {}) }; this.ports.save(state);
    try {
      const result = await this.read<{ title?: string; status?: string }>(op, input);
      if (op === 'thread.stop' && !['idle', 'error', 'pending'].includes(result.status ?? '')) throw new HostUnknownDeliveryError({ command: 'bb.thread.stop' });
      if (op === 'thread.title' && result.title !== (input as { title: string }).title) throw new HostUnknownDeliveryError({ command: 'bb.thread.title' });
      const next = this.ports.state(); next.writes[key] = { ...next.writes[key], status: 'settled' }; this.ports.save(next);
    } catch (error) {
      if (this.ports.notSent(error)) { const next = this.ports.state(); next.writes[key] = { status: 'refused' }; this.ports.save(next); }
      throw error;
    }
  }
  async stopAgentTurn(id: string) {
    const row = await this.read<BbRow>('thread.observe', { threadId: id });
    if (!this.observation(row).active) {
      const state = this.ports.state();
      for (const [key, intent] of Object.entries(state.writes)) if (key.startsWith(`stop:${id}:`)) intent.status = 'settled';
      this.ports.save(state); return;
    }
    const key = `stop:${id}:${row.updatedAt}`;
    if (Object.entries(this.ports.state().writes).some(([key, intent]) => key.startsWith(`stop:${id}:`) && intent.status === 'unknown')) throw new HostUnknownDeliveryError({ command: 'bb.thread.stop' });
    await this.write(key, 'thread.stop', { threadId: id });
  }
  async title(id: string, title: string, requestId: string) {
    const row = await this.read<BbRow>('thread.observe', { threadId: id });
    const observedState = this.ports.state();
    for (const [key, intent] of Object.entries(observedState.writes)) if (key.startsWith(`title:${id}:`) && intent.value === row.title) intent.status = 'settled';
    this.ports.save(observedState);
    if (row.title === title) {
      const state = this.ports.state();
      for (const [key, intent] of Object.entries(state.writes)) if (key.startsWith(`title:${id}:`) && intent.value === title) intent.status = 'settled';
      this.ports.save(state); return;
    }
    const key = `title:${id}:${requestId}:${title}`;
    if (Object.entries(this.ports.state().writes).some(([other, intent]) => other.startsWith(`title:${id}:`) && intent.status === 'unknown')) throw new HostUnknownDeliveryError({ command: 'bb.thread.title' });
    await this.write(key, 'thread.title', { threadId: id, title });
  }
  async catalog(): Promise<HostCatalog> {
    const { providers } = await this.read<{ providers: Array<{ id: string; modes: string[]; models: Array<{ id: string; reasoningLevels: string[] }> }> }>('provider.catalog', {});
    return { featuresDeferred: true, providers: providers.map(p => ({ key: p.id, label: p.id, available: true, problem: '', models: p.models.map(m => ({
      id: m.id, label: m.id, aliases: [], thinkingOptions: m.reasoningLevels.map(id => ({ id, label: id })), defaultThinkingOptionId: null,
      modes: p.modes.map(id => ({ id, label: id })), features: [],
    })) })) };
  }
  /** A bounded liveness window, always combined with core's inactivity and process proof. */
  async timeline(id: string): Promise<TimelinePage> {
    const read = await this.read<{ entries: Array<{ id: string; seq: number; at: number; turnId: string | null; status: string; name: string }>; hasOlder: boolean; pendingBackgroundTasks: string[] }>('thread.timeline', { threadId: id });
    const status: Record<string, string> = { pending: 'running', completed: 'completed', error: 'failed', interrupted: 'canceled' };
    return { entries: read.entries.map(row => ({ timestamp: new Date(row.at).toISOString(), ...(row.turnId ? { turnId: row.turnId } : {}),
      item: { type: 'tool_call', callId: row.id, name: row.name, status: status[row.status], detail: { type: 'unknown' } } })),
      epoch: id, startCursor: read.entries[0] ? { epoch: id, seq: read.entries[0].seq } : null,
      endCursor: read.entries.length ? { epoch: id, seq: read.entries.at(-1)!.seq } : null,
      hasOlder: read.hasOlder, hasNewer: false, gap: false, staleCursor: false, reset: false,
      projection: 'bounded', pendingBackgroundTasks: read.pendingBackgroundTasks };
  }
  async send(id: string, text: string, messageId: string) {
    if (!this.ports.state().agents[id]) throw new ProvenPreSendRefusalError('BB delivery needs a recorded task thread');
    const key = `send:${id}:${messageId}`;
    const previous = this.ports.state().writes[key];
    if (previous?.status === 'unknown') throw new HostUnknownDeliveryError({ command: 'bb.thread.send' });
    await this.write(key, 'thread.send', { threadId: id, text, messageId });
  }
  async inventoryRows() {
    const rows: BbRow[] = [];
    const seen = new Set<string>();
    for (const archived of [false, true]) {
      let complete = false;
      for (let offset = 0; offset < 100_000; offset += 200) {
        const page = await this.read<{ complete: boolean; rows: BbRow[] }>('thread.inventory', { includeHidden: true, archived, offset });
        if (page.complete !== (page.rows.length < 200) || page.rows.some(r => seen.has(r.threadId))) throw new Error('BB thread inventory is incomplete');
        for (const row of page.rows) { seen.add(row.threadId); rows.push(row); }
        if (page.complete) { complete = true; break; }
      }
      if (!complete) throw new Error('BB thread inventory exceeded its bound');
    }
    return rows;
  }
  agents() { return Object.values(this.ports.state().agents); }
}
