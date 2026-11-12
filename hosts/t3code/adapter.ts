import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { Host, HostAgentSpec, HostWorkspaceSpec, HostMessage, HostGuardedMessage, HostSendGuard, HostAsk, HostWorkspaceRef, HostRetainedAgentRef, HostCatalog, HostTimelinePage, HostThread, NativeDecisionInput, NativeDecisionAnswer } from '../../shared/host';
import type { Task, Profile } from '../../shared/contracts';
import { formatTaskNumber } from '../../shared/contracts';
import { capPaseoTitle } from '../../shared/paseo-title';
import { ProvenPreSendRefusalError, HostUnknownDeliveryError, sanitizeHostDeliveryDiagnostic } from '../../core/host';
import { T3RpcClient, T3RpcError } from './rpc';
import { t3codeVocabulary } from './vocabulary';
import { T3StateFile, canonical, type T3SettleIntent, type T3State } from './state';
import { decode, config, optionDescriptor, shellSnapshot, projection, threadSnapshot, shellThread, project, T3CompatibilityError, runtimeModes, defaultRuntimeMode, type RuntimeMode } from './contracts';

export interface T3CodeConfig { endpoint: string; bearer: string; statePath: string; timeoutMs?: number; probeThreadId?: string }
const identity = (purpose: string, value: string) => `nucleus-${purpose}-${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
const activeStatuses = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
/** A handover settle that never found an ended turn is retired rather than retried forever. */
const SETTLE_INTENT_TTL_MS = 24 * 60 * 60_000;
/** The nightly's newest run: its ordinal when reported, the list order otherwise. */
const latestRun = (projection: Projection) => projection.runs.reduce((best: Projection['runs'][number] | undefined, run) =>
  !best || (run.ordinal ?? -1) >= (best.ordinal ?? -1) ? run : best, undefined);
const inventoryReadAttempts = 5;
const unsupported = (capability: string): never => { throw new ProvenPreSendRefusalError(`T3Code does not support ${capability}`); };
/**
 * The option descriptor a model's thinking level rides: the nightly marks a
 * provider's own thought-level control `role: "reasoning"`, and every stock
 * driver (Codex, Grok, Muse, Kiro) names its reasoning select `reasoningEffort`.
 * The same id is what the nightly reads back out of `modelSelection.options`.
 */
const isReasoningDescriptor = (descriptor: z.infer<typeof optionDescriptor>): descriptor is Extract<z.infer<typeof optionDescriptor>, { type: 'select' }> =>
  descriptor.type === 'select' && (descriptor.role === 'reasoning' || descriptor.id === 'reasoningEffort');
/**
 * The nightly's own wording for the four runtime modes (installed bundle, client
 * `runtimeModes` table): `Supervised`, `Auto-accept edits`, `Auto`, `Full access`.
 * The catalog reports them so Nucleus's profile editor names the choice the way
 * T3 does.
 */
const runtimeModeLabels: Record<RuntimeMode, { label: string; description: string }> = {
  'approval-required': { label: 'Supervised', description: 'Ask before commands and file changes.' },
  'auto-accept-edits': { label: 'Auto-accept edits', description: 'Auto-approve edits, ask before other actions.' },
  auto: { label: 'Auto', description: 'Supported providers approve routine actions; others still ask.' },
  'full-access': { label: 'Full access', description: 'Allow commands and edits without prompts.' },
};
/**
 * The runtime modes one provider offers. The nightly omits `supportedRuntimeModes`
 * for a provider with no restriction, and then passes any of the four through;
 * a reported list restricts it, and a request outside it would silently run as
 * `approval-required`, so that list is what the catalog publishes.
 */
const providerRuntimeModes = (supported: readonly RuntimeMode[] | undefined): readonly RuntimeMode[] =>
  supported && supported.length ? supported : runtimeModes;
type OptionSelection = { id: string; value: string | boolean };
/**
 * The model's real option descriptors from `server.getConfig`, read at launch:
 * a value T3 does not report for that model is refused before send, never
 * dropped silently and never guessed to a nearest choice.
 */
const optionRefusal = (model: string, option: string, value?: string): string =>
  value === undefined ? `T3Code model ${model} has no "${option}" option` : `T3Code model ${model} has no ${option} "${value}"`;
/**
 * The manual fix names the repository path in full. The path comes from
 * Nucleus's own record, not from T3, so it is not secret and is never
 * truncated; only remote-derived fields are bounded.
 */
const createWireGuidance = (repositoryRoot: string) =>
  `T3Code cannot create a project for ${repositoryRoot}; add that folder as a project in T3Code, then restart the task`;
type Projection = z.infer<typeof projection>;
/** One model of `server.getConfig`'s provider snapshot. */
type ConfigModel = z.infer<typeof config>['providers'][number]['models'][number];
type ResponseBinding = NonNullable<T3State['intents'][string]['response']>;

interface ProjectCreateWire { method?: string; payload?: { type?: unknown; commandId?: unknown; projectId?: unknown; workspaceRoot?: unknown; title?: unknown } }
/**
 * Nightly moved project registration from a `project.create` command inside
 * `orchestration.dispatchCommand` to a `projects.mutate` mutation. An unknown
 * intent recorded before that change may carry the identical create on the old
 * route; the command and project IDs are unchanged, so the inventory re-read
 * adopts a landed project and T3's command receipt keeps a resend idempotent.
 * Nothing else may change an intent's payload.
 */
function projectCreateRouteMigrated(previous: string, current: string): boolean {
  try {
    const before = JSON.parse(previous) as ProjectCreateWire, after = JSON.parse(current) as ProjectCreateWire;
    const route = (wire: ProjectCreateWire) => wire.method === 'projects.mutate' || wire.method === 'orchestration.dispatchCommand' ? wire.method : null;
    const create = (wire: ProjectCreateWire) => wire.payload && wire.payload.type === 'project.create'
      && typeof wire.payload.commandId === 'string' && typeof wire.payload.projectId === 'string'
      && typeof wire.payload.workspaceRoot === 'string' && typeof wire.payload.title === 'string'
      ? { commandId: wire.payload.commandId, projectId: wire.payload.projectId, workspaceRoot: wire.payload.workspaceRoot, title: wire.payload.title } : null;
    const beforeRoute = route(before), afterRoute = route(after), beforeCreate = create(before), afterCreate = create(after);
    if (!beforeRoute || !afterRoute || !beforeCreate || !afterCreate || beforeRoute === afterRoute) return false;
    return canonical(beforeCreate) === canonical(afterCreate);
  } catch { return false; }
}

/** Includes pre-binding ledgers so upgrading cannot permit a second response. */
function responseIntents(state: T3State, agentId: string, requestId: string) {
  return Object.entries(state.intents).filter(([, intent]) => {
    if (intent.response) return intent.response.agentId === agentId && intent.response.requestId === requestId;
    try {
      const wire = JSON.parse(intent.payload);
      return wire.method === 'orchestration.dispatchCommand' && ['runtime-request.respond', 'thread.user-input.dismiss'].includes(wire.payload?.type)
        && wire.payload.threadId === agentId && wire.payload.requestId === requestId;
    } catch { throw Error('T3Code durable intent is unreadable; response delivery is unknown'); }
  });
}

/** Native host boundary only. Workflow/reporting integration is deliberately unavailable. */
export class T3CodeHost implements Host {
  readonly vocabulary = t3codeVocabulary;
  readonly rpc: T3RpcClient;
  readonly state: T3StateFile;
  hostId = '';
  version = '';
  private ready = false;
  private pendingThreadShape = false;
  private compatibilityError = '';
  private readonly probeThreadId?: string;
  constructor(options: T3CodeConfig) { this.probeThreadId = options.probeThreadId; this.rpc = new T3RpcClient(options); this.state = new T3StateFile(options.statePath); }
  get connected() { return this.ready && this.rpc.connected; }
  get threadShapePending() { return this.pendingThreadShape; }
  get compatibilityFailure() { return this.compatibilityError; }
  capabilities() { return { reportingViaMcp: false, supportsCoordinatorRecovery: false, nativeDecisions: false, uiContributions: false, lifecycleDispatch: false, perThreadEnvironment: false }; }
  async connect(probeThreadId = this.probeThreadId): Promise<void> {
    this.ready = false;
    this.pendingThreadShape = false;
    this.compatibilityError = '';
    try {
      await this.rpc.connect();
      const observed = decode(config, await this.rpc.call('server.getConfig', {}), 'server.getConfig');
      const hostId = `t3code:${observed.environment.environmentId}`;
      const previous = this.state.read();
      if (previous.hostId && previous.hostId !== hostId) throw new T3CompatibilityError('environment.environmentId changed');
      const shell = await this.readShell();
      const probe = probeThreadId ?? [...shell.threads, ...shell.archivedThreads][0]?.id;
      this.pendingThreadShape = !probe;
      if (probe) await this.readProjection(probe);
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
    try {
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
      this.pendingThreadShape = false;
      return snapshot!;
    } catch (error) {
      if (this.pendingThreadShape && error instanceof T3CompatibilityError) {
        this.compatibilityError = error.message;
        this.close();
      }
      throw error;
    }
  }
  private async inventory() {
    this.requireConnection();
    for (let attempt = 1; attempt <= inventoryReadAttempts; attempt++) {
      const shell = await this.readShell();
      const archived = decode(z.object({ schemaVersion: z.number().int().positive(), snapshotSequence: z.number().int().nonnegative(),
        projects: z.array(project), threads: z.array(shellThread) }), await this.rpc.call('orchestration.getArchivedShellSnapshot', {}), 'getArchivedShellSnapshot');
      // Both loaders report the application event cursor. If it moved between
      // reads, repeat the read-only pair until both describe the same snapshot.
      if (shell.snapshotSequence === archived.snapshotSequence) {
        const threads = [...shell.threads, ...shell.archivedThreads, ...archived.threads];
        if (this.pendingThreadShape && threads[0]) await this.readProjection(threads[0].id);
        return { projects: shell.projects, threads };
      }
      if (attempt < inventoryReadAttempts) await new Promise(resolve => setTimeout(resolve, attempt * 10));
    }
    throw new T3CompatibilityError(`inventory kept moving between live and archived reads after ${inventoryReadAttempts} attempts`);
  }
  private workspaceFor(thread: Projection['thread']) {
    return Object.values(this.state.read().workspaces).find(w => w.projectId === thread.projectId && w.directory === thread.worktreePath)?.id ?? null;
  }
  async catalog(): Promise<HostCatalog> {
    this.requireConnection();
    const value = decode(config, await this.rpc.call('server.getConfig', {}), 'server.getConfig');
    return { providers: value.providers.map(p => ({ key: p.instanceId, label: p.displayName ?? p.instanceId,
      available: p.enabled && p.status === 'ready', problem: p.enabled && p.status === 'ready' ? '' : 'T3Code provider is unavailable',
      models: p.models.map(m => {
        const descriptors = m.capabilities?.optionDescriptors ?? [];
        const reasoning = descriptors.find(isReasoningDescriptor);
        const feature = (descriptor: z.infer<typeof optionDescriptor>) => descriptor.type === 'boolean'
          ? { type: 'toggle' as const, id: descriptor.id, label: descriptor.label, ...(descriptor.description ? { description: descriptor.description } : {}), value: descriptor.currentValue ?? false }
          : { type: 'select' as const, id: descriptor.id, label: descriptor.label, ...(descriptor.description ? { description: descriptor.description } : {}), value: descriptor.currentValue ?? null,
            options: descriptor.options.map(c => ({ id: c.id, label: c.label, ...(c.description ? { description: c.description } : {}), ...(c.isDefault === undefined ? {} : { isDefault: c.isDefault }) })) };
        return { id: m.slug, label: m.name, aliases: m.aliases ?? [],
          thinkingOptions: reasoning ? reasoning.options.map(c => ({ id: c.id, label: c.label, ...(c.isDefault === undefined ? {} : { isDefault: c.isDefault }) })) : [],
          defaultThinkingOptionId: reasoning?.options.find(c => c.isDefault)?.id
            ?? (reasoning?.currentValue && reasoning.options.some(c => c.id === reasoning.currentValue) ? reasoning.currentValue : null),
          modes: providerRuntimeModes(p.supportedRuntimeModes).map(id => ({ id, ...runtimeModeLabels[id] })), features: descriptors.filter(d => d !== reasoning).map(feature) };
    }) })) };
  }
  async profiles(): Promise<Profile[]> { return []; }
  async createWorkspace(spec: HostWorkspaceSpec) {
    this.requireConnection();
    const directory = await realpath(spec.directory);
    const repositoryRoot = spec.project.workspaceRoot ? await realpath(spec.project.workspaceRoot) : undefined;
    const inventory = await this.inventory();
    let selected = repositoryRoot
      ? inventory.projects.find(p => p.workspaceRoot === repositoryRoot)
      : inventory.projects.find(p => spec.project.projectId ? p.id === spec.project.projectId : p.workspaceRoot === directory);
    // An archived project keeps its repository root: the nightly refuses a second
    // registration for it. Reopening the same registration is the native path.
    if (selected?.archivedAt != null) {
      const reopenId = identity('project-open', canonical([this.hostId, selected.id]));
      await this.effect(reopenId, 'projects.mutate', { type: 'project.update', commandId: reopenId, projectId: selected.id, archived: false });
      selected = { ...selected, archivedAt: null };
    }
    if (!selected && repositoryRoot) {
      const projectId = identity('project', canonical([this.hostId, repositoryRoot]));
      const commandId = identity('project-create', canonical([this.hostId, repositoryRoot]));
      const created = await this.effect(commandId, 'projects.mutate', {
        type: 'project.create', commandId, projectId, title: basename(repositoryRoot), workspaceRoot: repositoryRoot,
      }, undefined, undefined, { resendUnknownAfterRead: true, unsupportedMethodGuidance: createWireGuidance(repositoryRoot) });
      decode(z.object({ id: z.literal(projectId), title: z.string(), workspaceRoot: z.string() }).passthrough(), created, 'projects.mutate');
      selected = { id: projectId, title: basename(repositoryRoot), workspaceRoot: repositoryRoot };
    }
    if (!selected) throw new ProvenPreSendRefusalError(createWireGuidance(repositoryRoot ?? directory));
    const id = identity('worktree', canonical([selected.id, directory]));
    this.state.update(state => {
      const old = state.workspaces[id];
      if (old && (old.directory !== directory || old.projectId !== selected.id)) throw new ProvenPreSendRefusalError('T3Code workspace identity conflict');
      state.workspaces[id] = { id, directory, projectId: selected.id, title: spec.title };
    });
    return { id, directory };
  }
  async repositoryProject(root: string) {
    const workspaceRoot = await realpath(root);
    return { projectId: (await this.inventory()).projects.find(p => p.workspaceRoot === workspaceRoot)?.id, workspaceRoot };
  }
  async findWorkspaces(task: Task) { return Object.values(this.state.read().workspaces).filter(w => w.directory === task.directory).map(w => ({ id: w.id, directory: w.directory })); }
  async workspaceAvailable(id: string) { const w = this.state.read().workspaces[id]; return !!w && (await this.inventory()).projects.some(p => p.id === w.projectId && p.archivedAt == null); }
  workspaceIdAccepted(id: unknown) { return typeof id === 'string' && /^nucleus-worktree-[a-f0-9]{40}$/.test(id); }
  workspaceRef(id: string): HostWorkspaceRef {
    const host = this; let available = false;
    return { get directory() { return host.state.read().workspaces[id]?.directory; },
      async refresh() { available = await host.workspaceAvailable(id); return available; },
      current() { const w = host.state.read().workspaces[id]; return available && w ? { projectRootPath: w.directory, workspaceDirectory: w.directory, projectId: w.projectId, workspaceKind: 'external' } : null; },
      /** The native archive is the project's `archived: true` mutation: threads and files are kept. */
      async archive(requestId: string) {
        const workspace = host.state.read().workspaces[id];
        if (!workspace) return { archivedAt: null, error: 'T3Code workspace is not registered' };
        try {
          await host.effect(requestId, 'projects.mutate', { type: 'project.update', commandId: requestId, projectId: workspace.projectId, archived: true });
          const found = (await host.inventory()).projects.find(p => p.id === workspace.projectId);
          return { archivedAt: found?.archivedAt ?? null, error: null };
        } catch (error) { return { archivedAt: null, error: error instanceof Error ? error.message : String(error) }; }
      } };
  }
  async workspaceCatalog(_directory: string) { return { ok: false as const, reason: 'T3Code does not expose a native workspace registration inventory' }; }
  async setWorkspaceTitle(_id: string, _title: string, _request: string, _uncertain: boolean): Promise<void> { unsupported('native workspace titles'); }
  /** Archived is a positive native fact: the project is gone from the inventory or carries `archivedAt`. */
  async workspaceArchived(id: string): Promise<boolean> {
    const workspace = this.state.read().workspaces[id];
    if (!workspace) return true;
    const found = (await this.inventory()).projects.find(p => p.id === workspace.projectId);
    return !found || found.archivedAt != null;
  }
  async workspaceTerminals(_id: string) { return { ok: false as const, reason: 'T3Code does not expose a workspace terminal inventory' }; }
  async workspaceThreads(ids: readonly string[]) { return { ok: true as const, threads: (await this.activeAndArchivedThreads()).filter(t => !!t.workspaceId && ids.includes(t.workspaceId)) }; }
  private async activeAndArchivedThreads(): Promise<HostThread[]> {
    const { threads } = await this.inventory();
    return threads.map(t => ({ id: t.id, workspaceId: this.workspaceFor(t), labels: this.state.read().agents[t.id]?.labels ?? {},
      // The shell's own status, even for an archived thread: `archived` rides
      // its own flag, and the workspace archive proof reads terminal states.
      status: t.deletedAt ? 'gone' : t.status, archived: !!t.archivedAt,
      activeTurn: !!t.activeRunId || activeStatuses.has(t.status), pendingPermissionKinds: t.pendingRuntimeRequest ? [t.pendingRuntimeRequest.kind === 'user_input' ? 'question' : t.pendingRuntimeRequest.kind] : [] }));
  }
  async activeThreads() { return (await this.activeAndArchivedThreads()).filter(t => !t.archived && t.status !== 'gone'); }
  private async effect(key: string, method: string, payload: unknown, beforeSend?: () => void,
    response?: { binding: ResponseBinding; prepare(): Promise<unknown> }, options: {
      /** Caller completed a fresh positive read that reconciles the unknown remote effect. */
      resendUnknownAfterRead?: boolean;
      /** Guidance that rides an unknown delivery when the remote text names no known method. */
      unsupportedMethodGuidance?: string;
    } = {}): Promise<unknown> {
    if (!response) this.requireConnection();
    let encoded = canonical({ method, payload });
    const reserved = this.state.update(state => {
      const matches = response ? responseIntents(state, response.binding.agentId, response.binding.requestId) : [];
      const possibleWrites = matches.filter(([, intent]) => intent.status !== 'refused' || !intent.response);
      if (possibleWrites.length > 1) throw new HostUnknownDeliveryError(possibleWrites.find(([, intent]) => intent.diagnostic)?.[1].diagnostic);
      const [boundKey, old] = possibleWrites[0] ?? matches.find(([id]) => id === key) ?? [key, state.intents[key]];
      // Inspect the original outcome before payload checks or native status reads.
      if (old?.status === 'unknown' && !options.resendUnknownAfterRead || old?.status === 'refused' && matches.length && !old.response)
        throw new HostUnknownDeliveryError(old.diagnostic);
      if (old && matches.length) {
        const wire = JSON.parse(old.payload).payload;
        const legacyInput = canonical({ type: wire.type, response: wire.type === 'runtime-request.respond'
          ? { ...(wire.decision !== undefined ? { decision: wire.decision } : {}), ...(wire.answers !== undefined ? { answers: wire.answers } : {}) } : {} });
        const original = old.response ?? { agentId: wire.threadId, requestId: wire.requestId,
          workspaceId: state.agents[wire.threadId]?.workspaceId, input: legacyInput };
        if (original.workspaceId !== response!.binding.workspaceId || original.input !== response!.binding.input)
          throw new ProvenPreSendRefusalError(`T3Code original runtime response is ${old.status}; changed answer was not sent`);
      } else if (old && old.payload !== encoded && !projectCreateRouteMigrated(old.payload, encoded))
        throw new ProvenPreSendRefusalError('T3Code intent payload changed');
      if (!old) {
        this.requireConnection();
        state.intents[boundKey] = { payload: encoded, status: 'unknown', ...(response ? { response: response.binding } : {}) };
      } else if (response && (!this.hostId || state.hostId !== this.hostId)) {
        throw Error('T3Code prior response requires its recorded host identity; no command was resent');
      }
      return { key: boundKey, prior: old };
    });
    key = reserved.key; const prior = reserved.prior;
    if (prior?.status === 'settled') return prior.result;
    if (prior?.status === 'refused') throw new ProvenPreSendRefusalError('T3Code command was refused; no retry');
    if (prior && !(prior.status === 'unknown' && options.resendUnknownAfterRead)) throw new HostUnknownDeliveryError(prior.diagnostic);
    let wrote = false;
    try {
      if (response) {
        payload = await response.prepare();
        encoded = canonical({ method, payload });
        this.state.update(state => { state.intents[key].payload = encoded; });
      }
      beforeSend?.();
      wrote = true;
      const result = await this.rpc.call(method, payload);
      this.state.update(state => { state.intents[key] = { ...state.intents[key], payload: encoded, status: 'settled', result }; });
      return result;
    } catch (error) {
      // Only a local fence proves non-delivery. The remote text that names no known
      // method cannot prove a phase either (a handler can emit it after an effect),
      // so it stays unknown delivery; the task keeps the path-and-manual-fix
      // guidance and the recorded intent is never marked refused.
      const refusal = error instanceof ProvenPreSendRefusalError ? error
        : !wrote || error instanceof T3RpcError && error.delivery === 'not_sent'
          ? new ProvenPreSendRefusalError(error instanceof T3RpcError ? error.message : 'T3Code send fence refused before delivery') : null;
      if (refusal) this.state.update(state => { state.intents[key] = { ...state.intents[key], payload: encoded, status: 'refused' }; });
      if (refusal) throw refusal;
      const guidance = !refusal && options.unsupportedMethodGuidance && error instanceof T3RpcError && error.code === 'unsupported_method'
        ? options.unsupportedMethodGuidance : undefined;
      const diagnostic = sanitizeHostDeliveryDiagnostic(error instanceof T3RpcError ? { command: error.command, reason: error.reason, guidance }
        : error instanceof HostUnknownDeliveryError ? error.diagnostic : undefined);
      const unknown = new HostUnknownDeliveryError(diagnostic);
      try { this.state.update(state => { state.intents[key] = { ...state.intents[key], diagnostic }; }); }
      catch (persistenceError) { unknown.cause = persistenceError; }
      throw unknown;
    }
  }
  async createAgent(spec: HostAgentSpec) {
    this.requireConnection();
    if (spec.mcpBindingPath) unsupported('per-thread MCP reporting');
    if (spec.guard && !await spec.guard.allowed()) throw new ProvenPreSendRefusalError('T3Code launch guard refused');
    const attempt = spec.attempt(false, false), workspace = this.state.read().workspaces[spec.workspaceId];
    if (!workspace) throw new ProvenPreSendRefusalError('T3Code workspace is not registered');
    if (Object.keys(attempt.environment).length) unsupported('per-thread launch environment');
    // One config read answers every launch fact: the model's options, the
    // runtime mode the provider offers and the provider's own existence.
    const observed = decode(config, await this.rpc.call('server.getConfig', {}), 'server.getConfig');
    const provider = observed.providers.find(p => p.instanceId === spec.profile.provider);
    if (!provider?.models.some(m => m.slug === spec.profile.model))
      throw new ProvenPreSendRefusalError(`T3Code provider ${spec.profile.provider} does not report model ${spec.profile.model}`);
    const options = this.modelSelectionOptions(spec.profile, provider.models.find(m => m.slug === spec.profile.model)!);
    const runtimeMode = this.launchRuntimeMode(spec.profile, provider.supportedRuntimeModes);
    const id = identity('thread', attempt.requestId);
    const payload = { commandId: attempt.requestId, threadId: id, projectId: workspace.projectId, title: this.numberedThreadTitle(spec.taskNumber, attempt.labels.role, spec.title),
      modelSelection: { instanceId: spec.profile.provider, model: spec.profile.model, ...(options.length ? { options } : {}) }, runtimeMode, interactionMode: 'default',
      workspaceStrategy: { type: 'existing_worktree', worktreePath: workspace.directory },
      initialMessage: { messageId: identity('message', attempt.requestId), text: attempt.prompt, attachments: [] } };
    this.state.update(state => {
      const old = state.agents[id], record = { id, workspaceId: spec.workspaceId, labels: attempt.labels };
      if (old && canonical({ id: old.id, workspaceId: old.workspaceId, labels: old.labels }) !== canonical(record))
        throw new ProvenPreSendRefusalError('T3Code retained identity changed');
      state.agents[id] = { ...old, ...record };
    });
    const result = await this.effect(attempt.requestId, 'orchestration.launchThread', payload, () => {
      if (spec.guard && !spec.guard.stillAllowed()) throw new ProvenPreSendRefusalError('T3Code launch guard changed');
    });
    if (decode(z.object({ threadId: z.literal(id) }), result, 'launchThread').threadId !== id) throw new T3CompatibilityError('launchThread.threadId');
    this.state.update(state => { if (state.agents[id]) state.agents[id].title = payload.title; });
    if (this.pendingThreadShape) await this.readProjection(id);
    return { id, workspaceId: spec.workspaceId };
  }
  private numberedThreadTitle(taskNumber: number | null | undefined, role: string | undefined, title: string): string {
    if (!taskNumber) return title;
    const runRole = role && role !== 'worker' ? role : undefined;
    const rolePrefix = runRole ? `${runRole}: ` : '';
    const taskTitle = rolePrefix && title.startsWith(rolePrefix) ? title.slice(rolePrefix.length) : title;
    const titleRole = runRole === 'reviewer' ? 'review' : runRole;
    return capPaseoTitle(`${formatTaskNumber(taskNumber)}${titleRole ? ` ${titleRole}` : ''}: ${taskTitle}`);
  }
  /** The core title projection supplies the same phase-derived title used by Paseo. */
  async setTaskWorkspaceTitle(task: Task, title: string, requestId: string, _uncertain: boolean): Promise<void> {
    title = capPaseoTitle(title);
    const state = this.state.read();
    const threadId = task.agentId && state.agents[task.agentId]?.labels.task === task.id
      ? task.agentId
      : Object.entries(state.agents).find(([, agent]) => agent.labels.task === task.id && agent.labels.role === 'worker')?.[0];
    if (!threadId) throw Error('Task worker thread is missing');
    const projection = await this.readProjection(threadId);
    if (projection.thread.archivedAt || projection.thread.deletedAt) return;
    const key = identity('thread-title', canonical({ threadId, requestId }));
    if (projection.thread.title === title) {
      this.state.update(current => {
        const prior = current.intents[key];
        if (prior?.status === 'unknown') current.intents[key] = { ...prior, status: 'settled', result: { title } };
        if (current.agents[threadId]) current.agents[threadId].title = title;
      });
      return;
    }
    await this.effect(key, 'orchestration.dispatchCommand', { type: 'thread.metadata.update', commandId: key, threadId, title }, undefined, undefined,
      { resendUnknownAfterRead: true });
    this.state.update(current => { if (current.agents[threadId]) current.agents[threadId].title = title; });
  }
  /**
   * The profile's `modeId` as the thread's runtime mode. Nucleus profiles name the
   * host's mode by id, so T3's four modes carry over unchanged (`full-access` is
   * `full-access`, and so on). A profile with no mode gets the mode T3 launches a
   * thread with when none is asked for, `full-access`: the same unattended run a
   * Paseo worker of that role gets today, and never `approval-required`, which
   * would stop at every approval prompt.
   *
   * A profile naming a mode T3 does not have stays ineligible at selection; this
   * fence catches catalog drift and names the mode instead of sending it to be
   * silently downgraded to `approval-required` (nightly `providerRuntimeMode`).
   */
  private launchRuntimeMode(profile: Profile, supported: readonly RuntimeMode[] | undefined): RuntimeMode {
    const requested = !profile.modeId || profile.modeId === 'default' ? defaultRuntimeMode : profile.modeId;
    if (!(runtimeModes as readonly string[]).includes(requested))
      throw new ProvenPreSendRefusalError(`T3Code has no runtime mode ${requested}; its modes are ${runtimeModes.join(', ')}`);
    const offered = providerRuntimeModes(supported);
    if (!offered.includes(requested as RuntimeMode))
      throw new ProvenPreSendRefusalError(`T3Code provider ${profile.provider} does not offer runtime mode ${requested}; it offers ${offered.join(', ')}`);
    return requested as RuntimeMode;
  }
  /**
   * The profile's thinking level and reported feature values as the nightly's
   * `ProviderOptionSelection[]` for this exact model, from the `server.getConfig`
   * read the launch already made. A value the model does not report is refused
   * before send with the option and value named; nothing is dropped or
   * re-anchored to a nearest choice. Selection keeps such a profile out of a
   * T3 task through the host catalog; this fence catches catalog drift.
   */
  private modelSelectionOptions(profile: Profile, model: ConfigModel | undefined): OptionSelection[] {
    const thinking = profile.thinkingOptionId;
    const features = Object.entries(profile.featureValues ?? {});
    if (!thinking && !features.length) return [];
    const descriptors = model?.capabilities?.optionDescriptors ?? [];
    const options: OptionSelection[] = [];
    if (thinking) {
      const reasoning = descriptors.find(isReasoningDescriptor);
      if (!reasoning || !reasoning.options.some(choice => choice.id === thinking))
        throw new ProvenPreSendRefusalError(optionRefusal(profile.model, reasoning?.id ?? 'reasoning option', thinking));
      options.push({ id: reasoning.id, value: thinking });
    }
    for (const [option, feature] of features) {
      const descriptor = descriptors.find(d => d.id === option);
      if (!descriptor) throw new ProvenPreSendRefusalError(optionRefusal(profile.model, option));
      const shown = typeof feature === 'string' ? feature : JSON.stringify(feature);
      if (descriptor.type === 'boolean') {
        if (typeof feature !== 'boolean') throw new ProvenPreSendRefusalError(optionRefusal(profile.model, option, shown));
        options.push({ id: option, value: feature });
      } else if (typeof feature !== 'string' || !descriptor.options.some(choice => choice.id === feature))
        throw new ProvenPreSendRefusalError(optionRefusal(profile.model, option, shown));
      else options.push({ id: option, value: feature });
    }
    return options;
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
    // An archived thread is retired: it reports the terminal closed state, with
    // the archived fact on its own field for retained-read consumers.
    return { id, workspaceId: this.workspaceFor(thread), archived: !!thread.archivedAt,
      status: thread.deletedAt ? 'gone' : thread.archivedAt ? 'closed' : active ? active.status : native && activeStatuses.has(native.status) ? native.status : 'idle',
      active: !!active || !!native?.activeRunId || !!native && activeStatuses.has(native.status), permissions: pending.length > 0 || !!native?.pendingRuntimeRequest,
      error: native?.lastError ?? '', model: thread.modelSelection.model, provider: thread.modelSelection.instanceId,
      modeId: thread.runtimeMode ?? null,
      updatedAt: detail.updatedAt, activeTurnId: active?.id ?? native?.activeRunId ?? null, turnStartedAt: active?.startedAt ?? null,
      lastUserMessageAt: native?.latestUserMessageAt ?? null, labels: this.state.read().agents[id]?.labels ?? {},
      pendingPermissionKinds: pending.map(r => r.kind === 'user_input' ? 'question' : r.kind),
      ...(pending[0] ? { pendingRequest: { id: pending[0].id, kind: pending[0].kind === 'user_input' ? 'question' : pending[0].kind, firstLine: null } } : {}) };
  }
  /** Settle a completed non-worker thread after Nucleus has durably accepted its report. */
  async settleReportedThread(agentId: string, runId: string): Promise<void> {
    this.requireConnection();
    const baseCommandId = identity('settle', canonical([this.hostId, agentId, runId]));
    let commandId = baseCommandId;
    const payload = { type: 'thread.settle', commandId, threadId: agentId } as {
      type: string; commandId: string; threadId: string; expectedLatestRunId?: string;
    };
    let prior = this.state.read().intents[commandId];
    if (prior?.status === 'settled') return;
    const projection = await this.readProjection(agentId);
    if (projection.thread.settledOverride === 'settled') {
      if (prior?.status === 'unknown') this.markSettleObserved(commandId);
      return;
    }
    const latest = projection.runs.reduce((best, run) => !best || (run.ordinal ?? -1) >= (best.ordinal ?? -1) ? run : best, undefined as Projection['runs'][number] | undefined);
    // A fresh run owns the thread now. Never settle it because an older report arrived late.
    if (!latest || activeStatuses.has(latest.status)) return;
    // A proven pre-send refusal can be retried with a new command identity.
    // Unknown delivery still goes through the projection reconciliation below.
    for (let attempt = 1; prior?.status === 'refused'; attempt++) {
      commandId = identity('settle', canonical([this.hostId, agentId, runId, attempt]));
      prior = this.state.read().intents[commandId];
    }
    payload.commandId = commandId;
    if (prior) {
      await this.reconcileSettleIntent(commandId, prior.payload);
      return;
    }
    payload.expectedLatestRunId = latest.id;
    await this.effect(commandId, 'orchestration.dispatchCommand', payload);
  }
  /** Called by the ordinary host sweep; unknown delivery is checked against T3 before reuse. */
  async reconcileReportedSettlements(): Promise<void> {
    const state = this.state.read();
    const workerSettles = state.workerSettles ?? {};
    const pending = Object.entries(state.intents).filter(([key, intent]) => {
      if (intent.status !== 'unknown') return false;
      // A worker handover settle is never resent (nucleus#1154): an unknown
      // outcome stays unknown, and only a settle that was never sent may be
      // retried from its pending record. Resending here would turn one unknown
      // mutation into a second.
      if (workerSettles[key]) return false;
      try {
        const wire = JSON.parse(intent.payload);
        return wire.method === 'orchestration.dispatchCommand' && wire.payload?.type === 'thread.settle';
      } catch { throw new HostUnknownDeliveryError(); }
    });
    for (const [key, intent] of pending) {
      try { await this.reconcileSettleIntent(key, intent.payload); } catch { /* retain unknown delivery for the next sweep */ }
    }
  }
  private markSettleObserved(key: string, result: unknown = { settled: true }) {
    this.state.update(state => {
      const intent = state.intents[key];
      if (intent?.status === 'unknown') state.intents[key] = { ...intent, status: 'settled', result };
    });
  }
  private async reconcileSettleIntent(key: string, encoded: string): Promise<void> {
    const wire = JSON.parse(encoded) as { method?: string; payload?: { type?: string; threadId?: string; expectedLatestRunId?: string } };
    const payload = wire.payload;
    if (wire.method !== 'orchestration.dispatchCommand' || payload?.type !== 'thread.settle' || !payload.threadId || !payload.expectedLatestRunId)
      throw new HostUnknownDeliveryError();
    const projection = await this.readProjection(payload.threadId);
    if (projection.thread.settledOverride === 'settled') { this.markSettleObserved(key); return; }
    const latest = projection.runs.reduce((best, run) => !best || (run.ordinal ?? -1) >= (best.ordinal ?? -1) ? run : best, undefined as Projection['runs'][number] | undefined);
    if (latest?.id !== payload.expectedLatestRunId || activeStatuses.has(latest.status)) {
      // The old report no longer owns the latest run; retire this intent without touching it.
      this.markSettleObserved(key, { settled: false, superseded: true });
      return;
    }
    await this.effect(key, 'orchestration.dispatchCommand', payload, undefined, undefined, { resendUnknownAfterRead: true });
  }
  async observationInventory(ids: readonly string[]) { try { return new Map(await Promise.all(ids.map(async id => [id, await this.observe(id)] as const))); } catch { return null; } }
  /**
   * The origin-agent read distinguishes authoritative absence from an unread
   * inventory. Only a complete shell read may say T3 has no such thread; a
   * failed read or projection is thrown so the caller records it as unknown.
   */
  async originAgent(id: string) {
    this.requireConnection();
    const { threads } = await this.inventory();
    const found = threads.find(t => t.id === id);
    if (!found) return null;
    const p = await this.readProjection(id);
    return { id, workspaceId: this.workspaceFor(p.thread), title: p.thread.title, archived: !!p.thread.archivedAt };
  }
  async listLiveAgents() { return (await this.inventory()).threads.filter(t => !t.archivedAt && !t.deletedAt).map(t => ({ id: t.id, title: t.title, workspaceId: this.workspaceFor(t), labels: this.state.read().agents[t.id]?.labels ?? {} })); }
  async agentTimelinePage(id: string, limit = 100): Promise<HostTimelinePage | null> {
    try {
      // The canonical projection is the thread's complete turn list, so the
      // coverage contract is positive by construction: no gap, no reset, no
      // newer history; the epoch is the thread identity and the cursors are
      // positions in the full list, stable between doubling reads.
      const p = await this.readProjection(id);
      const start = Math.max(0, p.turnItems.length - limit);
      const entries = p.turnItems.slice(start).map(item => ({ timestamp: item.updatedAt ?? item.createdAt ?? p.updatedAt, item }));
      return { entries, hasOlder: start > 0, gap: false, staleCursor: false, reset: false, hasNewer: false,
        epoch: id, startCursor: entries.length ? { epoch: id, seq: start + 1 } : null,
        endCursor: entries.length ? { epoch: id, seq: p.turnItems.length } : null, projection: 'canonical' };
    } catch { return null; }
  }
  async agentTimeline(id: string, limit?: number) { return (await this.agentTimelinePage(id, limit))?.entries ?? null; }
  private async unsettleBeforeMessage(id: string, messageId: string) {
    const projection = await this.readProjection(id);
    if (projection.thread.settledOverride !== 'settled') return;
    const commandId = identity('unsettle', canonical([this.hostId, id, messageId]));
    await this.effect(commandId, 'orchestration.dispatchCommand', { type: 'thread.unsettle', commandId, threadId: id, reason: 'user' });
  }
  async sendMessage(id: string, input: HostMessage) { await this.unsettleBeforeMessage(id, input.messageId); await this.effect(input.messageId, 'orchestration.dispatchCommand', { type: 'message.dispatch', commandId: input.messageId, threadId: id, messageId: identity('message', input.messageId), text: input.text, attachments: [], createdBy: 'user', creationSource: 'server', dispatchMode: { type: 'queue_after_active' } }); }
  async enqueueMessage(id: string, input: HostMessage): Promise<void> { await this.sendMessage(id, input); }
  async sendGuarded(id: string, input: HostGuardedMessage, guard: HostSendGuard) {
    const observed = await this.observe(id);
    if (observed.workspaceId !== input.expectedWorkspaceId || observed.active || observed.permissions || observed.archived || observed.status === 'gone' || !await guard.allowed()) return { sent: false as const, reason: 'T3Code retained-thread guard refused' };
    await this.unsettleBeforeMessage(id, input.messageId);
    await this.effect(input.messageId, 'orchestration.dispatchCommand', { type: 'message.dispatch', commandId: input.messageId, threadId: id, messageId: identity('message', input.messageId), text: input.text, attachments: [], createdBy: 'user', creationSource: 'server', dispatchMode: { type: 'queue_after_active' } }, () => {
      if (!guard.stillAllowed()) throw new ProvenPreSendRefusalError('T3Code send guard changed'); guard.beforeSend?.();
    }); return { sent: true as const };
  }
  async sendWhenIdle(_id: string, _input: HostAsk): Promise<string | null> { return unsupported('in-thread Nucleus questions'); }
  /**
   * One atomic interrupt and continue: the nightly's `steer_active` dispatch
   * mode injects the message into the thread's live run. The run id is read
   * immediately before the send; with no active run there is nothing to steer
   * and the refusal is proven before the socket write.
   */
  async interruptAndContinue(id: string, messageId: string, text: string): Promise<void> {
    const projection = await this.readProjection(id);
    const native = (await this.inventory()).threads.find(t => t.id === id);
    const runId = projection.runs.find(r => activeStatuses.has(r.status))?.id ?? native?.activeRunId ?? null;
    if (!runId) throw new ProvenPreSendRefusalError('T3Code thread has no active run to steer');
    await this.unsettleBeforeMessage(id, messageId);
    await this.effect(messageId, 'orchestration.dispatchCommand', { type: 'message.dispatch', commandId: messageId, threadId: id, messageId: identity('message', messageId), text, attachments: [], createdBy: 'user', creationSource: 'server', dispatchMode: { type: 'steer_active', targetRunId: runId } });
  }
  async stopAgentTurn(id: string) { const p = await this.readProjection(id); const runs = p.runs.filter(r => activeStatuses.has(r.status)).map(r => r.id).sort(); if (!runs.length) return;
    const key = identity('stop', canonical([id, runs])); await this.effect(key, 'orchestration.dispatchCommand', { type: 'thread.stop', commandId: key, threadId: id }); }
  async archiveAgent(id: string) { const key = identity('archive', id); await this.effect(key, 'orchestration.dispatchCommand', { type: 'thread.archive', commandId: key, threadId: id }); }
  /**
   * Settle a worker thread once Nucleus accepted its handover and moved the task
   * to review (Tom, 2026-11-12). `expectedLatestRunId` names the run this
   * handover ended, so a thread a later run already owns is never settled.
   *
   * The accepted receipt is durable before this presentation effect, and the
   * handover's turn may still be ending when it arrives: an active run is never
   * settled (the next turn would clear the marker anyway), so the intent is
   * recorded and the ordinary host sweep retries it once that run has ended.
   * A recorded command is left exactly as recorded — an unknown delivery is not
   * permission to resend, and a settled one is the same settle again. T3 clears
   * the marker when a new message wakes the thread, so a revision round makes the
   * worker active and its next handover settles it again under that run's own
   * command id.
   */
  async settleWorkerThread(agentId: string, runId: string): Promise<void> {
    this.requireConnection();
    const baseCommandId = identity('settle', canonical([this.hostId, agentId, runId]));
    const existing = this.state.read().pendingSettles?.[baseCommandId];
    const commandId = this.workerSettleCommandId(agentId, runId);
    const intent = this.state.read().intents[commandId];
    if (intent?.status === 'unknown') throw new HostUnknownDeliveryError(intent.diagnostic);
    if (intent && intent.status !== 'refused') return;
    await this.attemptWorkerSettle(existing ?? { agentId, runId, commandId, recordedAt: new Date().toISOString() });
  }

  /** Retry durable worker settle intents during the ordinary host sweep. */
  async reconcileSettledThreads(): Promise<void> {
    this.pruneWorkerSettles();
    const pending = Object.values(this.state.read().pendingSettles ?? {});
    if (!pending.length) return;
    this.requireConnection();
    for (const entry of pending) {
      try { await this.attemptWorkerSettle(entry); }
      catch { /* an unreadable thread or unknown delivery keeps its record for the next pass */ }
    }
  }

  /** One worker settle: send when the handover's own run has ended, else retain the intent. */
  private async attemptWorkerSettle(entry: T3SettleIntent): Promise<void> {
    // Unknown delivery is never resent for worker handovers. A proven refusal
    // gets a new id on the next pass; it was known not to reach T3.
    const intent = this.state.read().intents[entry.commandId];
    if (intent && intent.status !== 'refused') { this.forgetSettle(entry.commandId); return; }
    if (intent?.status === 'refused') {
      this.forgetSettle(entry.commandId);
      entry = { ...entry, commandId: this.workerSettleCommandId(entry.agentId, entry.runId) };
    }
    if (Date.now() - Date.parse(entry.recordedAt) > SETTLE_INTENT_TTL_MS) { this.forgetSettle(entry.commandId); return; }
    const projection = await this.readProjection(entry.agentId);
    // Already settled, or retired: the handover needs no further presentation.
    if (projection.thread.settledOverride === 'settled' || projection.thread.archivedAt || projection.thread.deletedAt) {
      this.forgetSettle(entry.commandId); return;
    }
    const latest = latestRun(projection);
    // A later run owns the thread now; this handover must not settle it.
    if (entry.expectedLatestRunId && (!latest || latest.id !== entry.expectedLatestRunId)) { this.forgetSettle(entry.commandId); return; }
    // Still live, or the run has not appeared yet: keep the recorded intent.
    if (!latest || activeStatuses.has(latest.status)) { this.recordSettle({ ...entry, expectedLatestRunId: latest?.id }); return; }
    this.recordSettle({ ...entry, expectedLatestRunId: latest.id });
    this.markWorkerSettle(entry.commandId, entry.recordedAt);
    await this.effect(entry.commandId, 'orchestration.dispatchCommand',
      { type: 'thread.settle', commandId: entry.commandId, threadId: entry.agentId, expectedLatestRunId: latest.id });
    this.forgetSettle(entry.commandId);
  }

  /** First unused worker settle id, after any proven pre-send refusals. */
  private workerSettleCommandId(agentId: string, runId: string): string {
    const base = identity('settle', canonical([this.hostId, agentId, runId]));
    const intents = this.state.read().intents;
    if (!intents[base] || intents[base].status !== 'refused') return base;
    for (let attempt = 1; ; attempt++) {
      const candidate = identity('settle', canonical([this.hostId, agentId, runId, attempt]));
      const prior = intents[candidate];
      if (!prior || prior.status !== 'refused') return candidate;
    }
  }

  /**
   * Record that this command id is a worker handover settle. The mark is written
   * before the send so a crash cannot leave an unknown worker settle looking like
   * a support report's settle to the support reconciler.
   */
  private markWorkerSettle(commandId: string, recordedAt: string): void {
    if (this.state.read().workerSettles?.[commandId]) return;
    this.state.update(state => { state.workerSettles = { ...state.workerSettles, [commandId]: recordedAt }; });
  }

  /** Drop marks whose command has an outcome; an unknown one stays, so it is never resent. */
  private pruneWorkerSettles(): void {
    const state = this.state.read();
    const done = Object.keys(state.workerSettles ?? {}).filter(key => state.intents[key]?.status !== 'unknown');
    if (!done.length) return;
    this.state.update(next => { for (const key of done) delete next.workerSettles?.[key]; });
  }

  /** Record one pending settle; an unchanged record is the same intent, never a rewrite. */
  private recordSettle(entry: T3SettleIntent): void {
    const current = this.state.read().pendingSettles?.[entry.commandId];
    if (current && current.expectedLatestRunId === entry.expectedLatestRunId) return;
    this.state.update(state => {
      state.pendingSettles = { ...state.pendingSettles, [entry.commandId]: { ...entry, recordedAt: current?.recordedAt ?? entry.recordedAt } };
    });
  }

  private forgetSettle(commandId: string): void {
    if (!this.state.read().pendingSettles?.[commandId]) return;
    this.state.update(state => { if (state.pendingSettles) delete state.pendingSettles[commandId]; });
  }
  private async request(agent: string, workspace: string, id: string) {
    this.requireConnection();
    const p = await this.readProjection(agent); if (this.workspaceFor(p.thread) !== workspace) throw new ProvenPreSendRefusalError('T3Code runtime request workspace changed');
    const request = p.runtimeRequests.find(r => r.id === id);
    if (!request || request.status !== 'pending' || request.responseCapability.type === 'not_resumable') throw new ProvenPreSendRefusalError('T3Code runtime request is no longer answerable');
    return { request, projection: p };
  }
  async respondRuntimeRequest(agent: string, workspace: string, requestId: string, response: { decision?: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel'; answers?: Record<string, unknown> }, intentId = identity('response', canonical([agent, requestId]))) {
    await this.runtimeResponse(agent, workspace, requestId, 'runtime-request.respond', response, intentId);
  }
  private async runtimeResponse(agent: string, workspace: string, requestId: string, type: 'runtime-request.respond' | 'thread.user-input.dismiss',
    response: { decision?: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel'; answers?: Record<string, unknown> }, intentId: string,
    mapAnswers?: (projection: Projection) => Record<string, unknown>) {
    response = JSON.parse(canonical(response));
    const payload = { type, commandId: intentId, threadId: agent, requestId, ...response };
    await this.effect(intentId, 'orchestration.dispatchCommand', payload, undefined, {
      binding: { agentId: agent, workspaceId: workspace, requestId, input: canonical({ type, response }) },
      prepare: async () => {
        const { request, projection: p } = await this.request(agent, workspace, requestId);
        if (type === 'thread.user-input.dismiss') {
          if (request.kind !== 'user_input') throw new ProvenPreSendRefusalError('T3Code request is not a question');
          return payload;
        }
        if (request.kind !== 'user_input' && !['command', 'file-read', 'file-change', 'mcp-elicitation', 'permission'].includes(request.kind))
          throw new ProvenPreSendRefusalError('T3Code runtime request kind is unsupported');
        if (request.kind === 'user_input' ? !response.answers || !!response.decision : !response.decision || !!response.answers)
          throw new ProvenPreSendRefusalError('T3Code response does not match request kind');
        return mapAnswers ? { ...payload, answers: mapAnswers(p) } : payload;
      },
    });
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
    answers = { ...answers };
    await this.runtimeResponse(agent, workspace, requestId, 'runtime-request.respond', { answers }, identity('response', canonical([agent, requestId])), p => {
      const questions = p.turnItems.find(t => t.type === 'user_input_request' && t.requestId === requestId)?.questions;
      if (!questions) throw new T3CompatibilityError('runtimeRequest.questions');
      const mapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(answers)) {
        const matches = questions.filter(q => q.id === key || q.header === key);
        if (matches.length !== 1 || mapped[matches[0].id] !== undefined) throw new ProvenPreSendRefusalError('T3Code answer question identity is ambiguous');
        mapped[matches[0].id] = [value];
      }
      if (!Object.keys(mapped).length) throw new ProvenPreSendRefusalError('T3Code question answer is empty');
      return mapped;
    });
  }
  async dismissNativeQuestion(agent: string, workspace: string, requestId: string) {
    await this.runtimeResponse(agent, workspace, requestId, 'thread.user-input.dismiss', {}, identity('dismiss', canonical([agent, requestId])));
  }
  async raiseDecision(_agent: string, _workspace: string, _input: NativeDecisionInput): Promise<string> { return unsupported('in-thread Nucleus decisions'); }
  async answerDecision(_agent: string, _workspace: string, _input: NativeDecisionAnswer): Promise<void> { unsupported('in-thread Nucleus decisions'); }
  retainedAgentRef(id: string): HostRetainedAgentRef {
    const host = this; let observed: Awaited<ReturnType<T3CodeHost['observe']>> | null = null;
    return { get workspaceId() { return observed?.workspaceId ?? null; }, get archivedAt() { return observed?.archived || observed?.status === 'archived' ? true : null; },
      get status() { return observed?.status ?? null; }, get activeTurn() { return observed?.active ? { turnId: observed.activeTurnId } : null; },
      get pendingPermissions() { return observed ? observed.pendingPermissionKinds : null; }, get runtimeInfo() { return observed ? { provider: observed.provider, model: observed.model } : null; },
      async refresh() { observed = await host.observe(id); return observed; }, current() { return observed; }, async send(text, options) { await host.sendMessage(id, { text, messageId: options.messageId }); } };
  }
}
