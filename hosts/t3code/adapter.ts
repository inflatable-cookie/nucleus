import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { Host, HostAgentSpec, HostWorkspaceSpec, HostMessage, HostGuardedMessage, HostSendGuard, HostAsk, HostWorkspaceRef, HostRetainedAgentRef, HostCatalog, HostTimelinePage, HostThread, NativeDecisionInput, NativeDecisionAnswer } from '../../shared/host';
import type { Task, Profile } from '../../shared/contracts';
import { ProvenPreSendRefusalError } from '../../core/host';
import { T3RpcClient, T3RpcError } from './rpc';
import { T3StateFile, canonical } from './state';
import { decode, config, shellSnapshot, projection, threadSnapshot, shellThread, project, T3CompatibilityError } from './contracts';

export interface T3CodeConfig { endpoint: string; bearer: string; statePath: string; timeoutMs?: number; probeThreadId?: string }
const identity = (purpose: string, value: string) => `nucleus-${purpose}-${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
const activeStatuses = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const unsupported = (capability: string): never => { throw new ProvenPreSendRefusalError(`T3Code does not support ${capability}`); };
type Projection = z.infer<typeof projection>;

/** Native host boundary only. Workflow/reporting integration is deliberately unavailable. */
export class T3CodeHost implements Host {
  readonly rpc: T3RpcClient;
  readonly state: T3StateFile;
  hostId = '';
  version = '';
  private ready = false;
  private readonly probeThreadId?: string;
  constructor(options: T3CodeConfig) { this.probeThreadId = options.probeThreadId; this.rpc = new T3RpcClient(options); this.state = new T3StateFile(options.statePath); }
  get connected() { return this.ready && this.rpc.connected; }
  capabilities() { return { reportingViaMcp: false, supportsCoordinatorRecovery: false, nativeDecisions: false, uiContributions: false, lifecycleDispatch: false, perThreadEnvironment: false }; }
  async connect(probeThreadId = this.probeThreadId): Promise<void> {
    this.ready = false;
    try {
      await this.rpc.connect();
      const observed = decode(config, await this.rpc.call('server.getConfig', {}), 'server.getConfig');
      const hostId = `t3code:${observed.environment.environmentId}`;
      const previous = this.state.read();
      if (previous.hostId && previous.hostId !== hostId) throw new T3CompatibilityError('environment.environmentId changed');
      const shell = await this.readShell();
      const probe = probeThreadId ?? [...shell.threads, ...shell.archivedThreads][0]?.id;
      if (!probe) throw new T3CompatibilityError('subscribeThread: no readable thread for probe');
      await this.readProjection(probe);
      this.state.update(state => { state.hostId = hostId; state.lastPassedVersion = observed.environment.serverVersion; });
      this.hostId = hostId; this.version = observed.environment.serverVersion; this.ready = true;
    } catch (error) { this.close(); throw error; }
  }
  close() { this.ready = false; this.rpc.close(); }
  private requireConnection() {
    if (!this.connected) throw new T3CompatibilityError('authenticated host connection is unavailable');
    if (this.state.read().hostId !== this.hostId) throw new T3CompatibilityError('durable host identity changed');
  }
  private async readShell() {
    let snapshot: z.infer<typeof shellSnapshot> | undefined;
    await this.rpc.readStream('orchestration.subscribeShell', { requestCompletionMarker: true }, value => {
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
  private async readProjection(threadId: string): Promise<Projection> {
    let snapshot: Projection | undefined;
    await this.rpc.readStream('orchestration.subscribeThread', { threadId, requestCompletionMarker: true }, value => {
      const item = decode(z.object({ kind: z.string() }).passthrough(), value, 'subscribeThread');
      if (item.kind === 'snapshot') {
        if (snapshot) throw new T3CompatibilityError('subscribeThread: duplicate authoritative snapshot');
        const complete = decode(threadSnapshot, item, 'subscribeThread');
        if (complete.hasMoreHistory || complete.historyCursor != null || complete.turnItemsOmitLocalVisible || complete.idTable !== undefined)
          throw new T3CompatibilityError('subscribeThread: incomplete projection');
        snapshot = complete.projection;
        if (snapshot.thread.id !== threadId) throw new T3CompatibilityError('subscribeThread.thread.id');
      } else if (item.kind === 'synchronized') {
        if (!snapshot) throw new T3CompatibilityError('subscribeThread.projection missing');
        return true;
      } else throw new T3CompatibilityError('subscribeThread: state changed during snapshot');
      return false;
    });
    return snapshot!;
  }
  private async inventory() {
    this.requireConnection();
    const shell = await this.readShell();
    const archived = decode(z.object({ schemaVersion: z.number().int().positive(), snapshotSequence: z.number().int().nonnegative(),
      projects: z.array(project), threads: z.array(shellThread) }), await this.rpc.call('orchestration.getArchivedShellSnapshot', {}), 'getArchivedShellSnapshot');
    // Both loaders report the application event cursor. An archive/unarchive
    // between them can otherwise disappear from their union. Refuse that read.
    if (shell.snapshotSequence !== archived.snapshotSequence) throw new T3CompatibilityError('inventory.snapshotSequence changed between live and archived reads');
    return { projects: shell.projects, threads: [...shell.threads, ...shell.archivedThreads, ...archived.threads] };
  }
  private workspaceFor(thread: Projection['thread']) {
    return Object.values(this.state.read().workspaces).find(w => w.projectId === thread.projectId && w.directory === thread.worktreePath)?.id ?? null;
  }
  async catalog(): Promise<HostCatalog> {
    this.requireConnection();
    const value = decode(config, await this.rpc.call('server.getConfig', {}), 'server.getConfig');
    return { providers: value.providers.map(p => ({ key: p.instanceId, label: p.displayName ?? p.instanceId,
      available: p.enabled && p.status === 'ready', problem: p.enabled && p.status === 'ready' ? '' : 'T3Code provider is unavailable',
      models: p.models.map(m => ({ id: m.slug, label: m.name, aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] })) })) };
  }
  async profiles(): Promise<Profile[]> { return []; }
  async createWorkspace(spec: HostWorkspaceSpec) {
    this.requireConnection();
    const directory = await realpath(spec.directory), inventory = await this.inventory();
    const selected = inventory.projects.find(p => spec.project.projectId ? p.id === spec.project.projectId : p.workspaceRoot === directory);
    if (!selected) throw new ProvenPreSendRefusalError('T3Code project is not registered');
    const id = identity('worktree', canonical([selected.id, directory]));
    this.state.update(state => {
      const old = state.workspaces[id];
      if (old && (old.directory !== directory || old.projectId !== selected.id)) throw new ProvenPreSendRefusalError('T3Code workspace identity conflict');
      state.workspaces[id] = { id, directory, projectId: selected.id, title: spec.title };
    });
    return { id, directory };
  }
  async repositoryProject(root: string) { return { projectId: (await this.inventory()).projects.find(p => p.workspaceRoot === root)?.id }; }
  async findWorkspaces(task: Task) { return Object.values(this.state.read().workspaces).filter(w => w.directory === task.directory).map(w => ({ id: w.id, directory: w.directory })); }
  async workspaceAvailable(id: string) { const w = this.state.read().workspaces[id]; return !!w && (await this.inventory()).projects.some(p => p.id === w.projectId); }
  workspaceIdAccepted(id: unknown) { return typeof id === 'string' && /^nucleus-worktree-[a-f0-9]{40}$/.test(id); }
  workspaceRef(id: string): HostWorkspaceRef {
    const host = this; let available = false;
    return { get directory() { return host.state.read().workspaces[id]?.directory; },
      async refresh() { available = await host.workspaceAvailable(id); return available; },
      current() { const w = host.state.read().workspaces[id]; return available && w ? { projectRootPath: w.directory, workspaceDirectory: w.directory, projectId: w.projectId, workspaceKind: 'external' } : null; },
      async archive() { return unsupported('workspace archive'); } };
  }
  async workspaceCatalog(_directory: string) { return { ok: false as const, reason: 'T3Code does not expose a native workspace registration inventory' }; }
  async setWorkspaceTitle(_id: string, _title: string, _request: string, _uncertain: boolean): Promise<void> { unsupported('native workspace titles'); }
  async workspaceArchived(_id: string): Promise<boolean> { return unsupported('workspace archive observation'); }
  async workspaceTerminals(_id: string) { return { ok: false as const, reason: 'T3Code does not expose a workspace terminal inventory' }; }
  async workspaceThreads(ids: readonly string[]) { return { ok: true as const, threads: (await this.activeAndArchivedThreads()).filter(t => !!t.workspaceId && ids.includes(t.workspaceId)) }; }
  private async activeAndArchivedThreads(): Promise<HostThread[]> {
    const { threads } = await this.inventory();
    return threads.map(t => ({ id: t.id, workspaceId: this.workspaceFor(t), labels: this.state.read().agents[t.id]?.labels ?? {},
      status: t.deletedAt ? 'gone' : t.archivedAt ? 'archived' : t.status, archived: !!t.archivedAt,
      activeTurn: !!t.activeRunId || activeStatuses.has(t.status), pendingPermissionKinds: t.pendingRuntimeRequest ? [t.pendingRuntimeRequest.kind === 'user_input' ? 'question' : t.pendingRuntimeRequest.kind] : [] }));
  }
  async activeThreads() { return (await this.activeAndArchivedThreads()).filter(t => !t.archived && t.status !== 'gone'); }
  private async effect(key: string, method: string, payload: unknown, beforeSend?: () => void): Promise<unknown> {
    this.requireConnection(); const encoded = canonical({ method, payload });
    const prior = this.state.update(state => {
      const old = state.intents[key];
      if (old && old.payload !== encoded) throw new ProvenPreSendRefusalError('T3Code intent payload changed');
      if (!old) state.intents[key] = { payload: encoded, status: 'unknown' };
      return old;
    });
    if (prior?.status === 'settled') return prior.result;
    if (prior?.status === 'refused') throw new ProvenPreSendRefusalError('T3Code command was refused; no retry');
    if (prior) throw Error('T3Code delivery is unknown; command was not resent');
    let wrote = false;
    try {
      beforeSend?.();
      wrote = true;
      const result = await this.rpc.call(method, payload);
      this.state.update(state => { state.intents[key] = { payload: encoded, status: 'settled', result }; });
      return result;
    } catch (error) {
      const refusal = error instanceof ProvenPreSendRefusalError ? error
        : !wrote || error instanceof T3RpcError && error.delivery === 'not_sent'
          ? new ProvenPreSendRefusalError(error instanceof T3RpcError ? error.message : 'T3Code send fence refused before delivery') : null;
      if (refusal) this.state.update(state => { state.intents[key] = { payload: encoded, status: 'refused' }; });
      throw refusal ?? error;
    }
  }
  async createAgent(spec: HostAgentSpec) {
    this.requireConnection();
    if (spec.mcpBindingPath) unsupported('per-thread MCP reporting');
    if (spec.profile.thinkingOptionId || Object.keys(spec.profile.featureValues ?? {}).length) unsupported('unreported model options');
    if (spec.profile.modeId && spec.profile.modeId !== 'default') unsupported('unreported runtime mode');
    if (spec.guard && !await spec.guard.allowed()) throw new ProvenPreSendRefusalError('T3Code launch guard refused');
    const attempt = spec.attempt(false, false), workspace = this.state.read().workspaces[spec.workspaceId];
    if (!workspace) throw new ProvenPreSendRefusalError('T3Code workspace is not registered');
    if (Object.keys(attempt.environment).length) unsupported('per-thread launch environment');
    const id = identity('thread', attempt.requestId);
    const payload = { commandId: attempt.requestId, threadId: id, projectId: workspace.projectId, title: spec.title,
      modelSelection: { instanceId: spec.profile.provider, model: spec.profile.model }, runtimeMode: 'approval-required', interactionMode: 'default',
      workspaceStrategy: { type: 'existing_worktree', worktreePath: workspace.directory },
      initialMessage: { messageId: identity('message', attempt.requestId), text: attempt.prompt, attachments: [] } };
    this.state.update(state => {
      const old = state.agents[id], record = { id, workspaceId: spec.workspaceId, labels: attempt.labels };
      if (old && canonical(old) !== canonical(record)) throw new ProvenPreSendRefusalError('T3Code retained identity changed');
      state.agents[id] = record;
    });
    const result = await this.effect(attempt.requestId, 'orchestration.launchThread', payload, () => {
      if (spec.guard && !spec.guard.stillAllowed()) throw new ProvenPreSendRefusalError('T3Code launch guard changed');
    });
    if (decode(z.object({ threadId: z.literal(id) }), result, 'launchThread').threadId !== id) throw new T3CompatibilityError('launchThread.threadId');
    return { id, workspaceId: spec.workspaceId };
  }
  async findAgents(labels: Record<string, string>) { this.requireConnection();
    const candidates = Object.values(this.state.read().agents).filter(a => Object.entries(labels).every(([k,v]) => a.labels[k] === v));
    return Promise.all(candidates.map(async ({id,workspaceId}) => {
      const p = await this.readProjection(id);
      if (this.workspaceFor(p.thread) !== workspaceId) throw new T3CompatibilityError('retained thread workspace changed');
      return {id,workspaceId};
    }));
  }
  async observe(id: string) {
    this.requireConnection(); const detail = await this.readProjection(id), { thread } = detail;
    const active = detail.runs.find(r => activeStatuses.has(r.status));
    const pending = detail.runtimeRequests.filter(r => r.status === 'pending');
    const native = (await this.inventory()).threads.find(t => t.id === id);
    return { id, workspaceId: this.workspaceFor(thread), status: thread.deletedAt ? 'gone' : thread.archivedAt ? 'archived' : active ? active.status : native && activeStatuses.has(native.status) ? native.status : 'idle',
      active: !!active || !!native?.activeRunId || !!native && activeStatuses.has(native.status), permissions: pending.length > 0 || !!native?.pendingRuntimeRequest,
      error: native?.lastError ?? '', model: thread.modelSelection.model, provider: thread.modelSelection.instanceId,
      updatedAt: detail.updatedAt, activeTurnId: active?.id ?? native?.activeRunId ?? null, turnStartedAt: active?.startedAt ?? null,
      lastUserMessageAt: native?.latestUserMessageAt ?? null, labels: this.state.read().agents[id]?.labels ?? {},
      pendingPermissionKinds: pending.map(r => r.kind === 'user_input' ? 'question' : r.kind),
      ...(pending[0] ? { pendingRequest: { id: pending[0].id, kind: pending[0].kind === 'user_input' ? 'question' : pending[0].kind, firstLine: null } } : {}) };
  }
  async observationInventory(ids: readonly string[]) { try { return new Map(await Promise.all(ids.map(async id => [id, await this.observe(id)] as const))); } catch { return null; } }
  async originAgent(id: string) { this.requireConnection(); const p = await this.readProjection(id); return { id, workspaceId: this.workspaceFor(p.thread), title: p.thread.title, archived: !!p.thread.archivedAt }; }
  async listLiveAgents() { return (await this.inventory()).threads.filter(t => !t.archivedAt && !t.deletedAt).map(t => ({ id: t.id, title: t.title, workspaceId: this.workspaceFor(t), labels: this.state.read().agents[t.id]?.labels ?? {} })); }
  async agentTimelinePage(id: string, limit = 100): Promise<HostTimelinePage | null> {
    try { const p = await this.readProjection(id); const entries = p.turnItems.slice(-limit).map(item => ({ timestamp: item.updatedAt ?? item.createdAt ?? p.updatedAt, item }));
      return { entries, hasOlder: p.turnItems.length > limit, gap: false, hasNewer: false, projection: 'canonical' }; } catch { return null; }
  }
  async agentTimeline(id: string, limit?: number) { return (await this.agentTimelinePage(id, limit))?.entries ?? null; }
  async sendMessage(id: string, input: HostMessage) { await this.effect(input.messageId, 'orchestration.dispatchCommand', { type: 'message.dispatch', commandId: input.messageId, threadId: id, messageId: identity('message', input.messageId), text: input.text, attachments: [], createdBy: 'user', creationSource: 'server', dispatchMode: { type: 'queue_after_active' } }); }
  async enqueueMessage(id: string, input: HostMessage): Promise<void> { await this.sendMessage(id, input); }
  async sendGuarded(id: string, input: HostGuardedMessage, guard: HostSendGuard) {
    const observed = await this.observe(id);
    if (observed.workspaceId !== input.expectedWorkspaceId || observed.active || observed.permissions || observed.status === 'archived' || observed.status === 'gone' || !await guard.allowed()) return { sent: false as const, reason: 'T3Code retained-thread guard refused' };
    await this.effect(input.messageId, 'orchestration.dispatchCommand', { type: 'message.dispatch', commandId: input.messageId, threadId: id, messageId: identity('message', input.messageId), text: input.text, attachments: [], createdBy: 'user', creationSource: 'server', dispatchMode: { type: 'queue_after_active' } }, () => {
      if (!guard.stillAllowed()) throw new ProvenPreSendRefusalError('T3Code send guard changed'); guard.beforeSend?.();
    }); return { sent: true as const };
  }
  async sendWhenIdle(_id: string, _input: HostAsk): Promise<string | null> { return unsupported('in-thread Nucleus questions'); }
  async interruptAndContinue(_id: string, _messageId: string, _text: string): Promise<void> { unsupported('atomic interrupt and continue'); }
  async stopAgentTurn(id: string) { const p = await this.readProjection(id); const runs = p.runs.filter(r => activeStatuses.has(r.status)).map(r => r.id).sort(); if (!runs.length) return;
    const key = identity('stop', canonical([id, runs])); await this.effect(key, 'orchestration.dispatchCommand', { type: 'thread.stop', commandId: key, threadId: id }); }
  async archiveAgent(id: string) { const key = identity('archive', id); await this.effect(key, 'orchestration.dispatchCommand', { type: 'thread.archive', commandId: key, threadId: id }); }
  private async request(agent: string, workspace: string, id: string) {
    this.requireConnection();
    const p = await this.readProjection(agent); if (this.workspaceFor(p.thread) !== workspace) throw new ProvenPreSendRefusalError('T3Code runtime request workspace changed');
    const request = p.runtimeRequests.find(r => r.id === id);
    if (!request || request.status !== 'pending' || request.responseCapability.type === 'not_resumable') throw new ProvenPreSendRefusalError('T3Code runtime request is no longer answerable');
    return { request, projection: p };
  }
  async respondRuntimeRequest(agent: string, workspace: string, requestId: string, response: { decision?: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel'; answers?: Record<string, unknown> }, intentId = identity('response', canonical([agent, requestId]))) {
    const { request } = await this.request(agent, workspace, requestId);
    if (request.kind !== 'user_input' && !['command', 'file-read', 'file-change', 'mcp-elicitation', 'permission'].includes(request.kind))
      throw new ProvenPreSendRefusalError('T3Code runtime request kind is unsupported');
    if (request.kind === 'user_input' ? !response.answers || !!response.decision : !response.decision || !!response.answers)
      throw new ProvenPreSendRefusalError('T3Code response does not match request kind');
    await this.effect(intentId, 'orchestration.dispatchCommand', { type: 'runtime-request.respond', commandId: intentId, threadId: agent, requestId, ...response });
  }
  async pendingQuestions(id: string) { const p = await this.readProjection(id); return p.runtimeRequests.filter(r => r.kind === 'user_input' && r.status === 'pending').map(r => {
    const item = p.turnItems.find(t => t.type === 'user_input_request' && t.requestId === r.id);
    if (!item?.questions) throw new T3CompatibilityError('runtimeRequest.questions');
    return { requestId: r.id, questions: item.questions.map(q => ({ header: q.header, question: q.question, options: q.options.map(o => o.label) })) };
  }); }
  async answeredQuestions(id: string) { const p = await this.readProjection(id); return p.runtimeRequests.filter(r => r.kind === 'user_input' && r.status === 'resolved' && r.answers).map(r => ({ requestId: r.id,
    question: p.turnItems.find(t => t.requestId === r.id)?.questions?.map(q => q.question).join('\n') ?? '',
    answers: Object.fromEntries(Object.entries(r.answers!).map(([k,v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) })); }
  async answerNativeQuestion(agent: string, workspace: string, requestId: string, answers: Record<string, string>) {
    const { request, projection: p } = await this.request(agent, workspace, requestId);
    if (request.kind !== 'user_input') throw new ProvenPreSendRefusalError('T3Code request is not a question');
    const questions = p.turnItems.find(t => t.type === 'user_input_request' && t.requestId === requestId)?.questions;
    if (!questions) throw new T3CompatibilityError('runtimeRequest.questions');
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(answers)) {
      const matches = questions.filter(q => q.id === key || q.header === key);
      if (matches.length !== 1 || mapped[matches[0].id] !== undefined) throw new ProvenPreSendRefusalError('T3Code answer question identity is ambiguous');
      mapped[matches[0].id] = [value];
    }
    if (!Object.keys(mapped).length) throw new ProvenPreSendRefusalError('T3Code question answer is empty');
    await this.respondRuntimeRequest(agent, workspace, requestId, { answers: mapped });
  }
  async dismissNativeQuestion(agent: string, workspace: string, requestId: string) { const { request } = await this.request(agent, workspace, requestId); if (request.kind !== 'user_input') throw new ProvenPreSendRefusalError('T3Code request is not a question');
    const key = identity('dismiss', canonical([agent, requestId])); await this.effect(key, 'orchestration.dispatchCommand', { type: 'thread.user-input.dismiss', commandId: key, threadId: agent, requestId }); }
  async raiseDecision(_agent: string, _workspace: string, _input: NativeDecisionInput): Promise<string> { return unsupported('in-thread Nucleus decisions'); }
  async answerDecision(_agent: string, _workspace: string, _input: NativeDecisionAnswer): Promise<void> { unsupported('in-thread Nucleus decisions'); }
  retainedAgentRef(id: string): HostRetainedAgentRef {
    const host = this; let observed: Awaited<ReturnType<T3CodeHost['observe']>> | null = null;
    return { get workspaceId() { return observed?.workspaceId ?? null; }, get archivedAt() { return observed?.status === 'archived' ? true : null; },
      get status() { return observed?.status ?? null; }, get activeTurn() { return observed?.active ? { turnId: observed.activeTurnId } : null; },
      get pendingPermissions() { return observed ? observed.pendingPermissionKinds : null; }, get runtimeInfo() { return observed ? { provider: observed.provider, model: observed.model } : null; },
      async refresh() { observed = await host.observe(id); return observed; }, current() { return observed; }, async send(text, options) { await host.sendMessage(id, { text, messageId: options.messageId }); } };
  }
}
