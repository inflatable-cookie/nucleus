import { ArchiveNotDeliveredError, ProvenPreSendRefusalError } from '../../../core/host';
import type { HostPolicyConstructor, Adapter, AgentObservation, OriginAgent, ExternalWorkspaceArchiveInput, ExternalWorkspaceSourceExpectation, RunPresenceDaemon, RunUsageSource, RunUsageStream, RunUsageStreamEvent, ProcessSearch, WorkspaceCreationState } from '../../../core/host';
import { capPaseoTitle } from '../../../shared/paseo-title';
import { mcpBindingPathFromHostRecord } from '../../../shared/report-binding';
import { timedDaemonRequests } from './paseo-call-timing';
import { paseoWorkspaceIdAccepted } from "./workspace-id";
import { historicalWireLabel, validateWireLabels } from "../../../shared/wire-labels";

import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { DaemonClient as ProvenanceClient } from "paseo-provenance-client/internal/daemon-client";

import type { Run } from "../../../shared/contracts";

import type { Profile, ReviewEntryInput, StashEntry, Task } from "../../../shared/contracts";
import type { HostAgentSpec, HostCatalog, HostCatalogOptions, HostFeature, HostModel, HostProvider, HostWorkspaceRef, NativeDecisionInput } from "../../../shared/host";
import type { NucleusProfile } from "../../../shared/profiles";

import { PaseoWorkspaceHost } from './host-workspaces';
import { PaseoMessageHost } from './host-messages';
import { PaseoQuestionHost } from './host-questions';
import { PaseoAskHost } from './host-asks';
import { paseoVocabulary } from '../vocabulary';

export type * from "../../../core/host";

/**
 * The one observation a complete `agents.list` entry supplies, or null when it
 * does not carry what `observe` reads (audit A6). Every field is read from the
 * same daemon snapshot `observe` reads through a refreshed handle: a status,
 * the active turn, pending permissions, workspace, labels, runtime info and
 * activity stamps. An entry missing a required field, or holding a value of the
 * wrong shape, answers nothing so the caller takes the narrow per-agent read.
 * A status and an active turn that disagree are reported exactly as they are —
 * an active turn still reads active — because the conservative direction is
 * never to infer inactivity from a contradiction.
 */
export function observationFromInventoryEntry(entry: unknown): AgentObservation | null {
  if (!entry || typeof entry !== "object") return null;
  const agent = entry as Record<string, unknown>;
  if (typeof agent.id !== "string" || !agent.id) return null;
  if (typeof agent.status !== "string") return null;
  if (!Array.isArray(agent.pendingPermissions)) return null;
  if (agent.workspaceId !== undefined && agent.workspaceId !== null && typeof agent.workspaceId !== "string") return null;
  const activeTurn = agent.activeTurn;
  if (activeTurn !== undefined && activeTurn !== null && typeof activeTurn !== "object") return null;
  const runtime = agent.runtimeInfo && typeof agent.runtimeInfo === "object" ? agent.runtimeInfo as Record<string, unknown> : null;
  const pending = agent.pendingPermissions as Array<Record<string, unknown> | null | undefined>;
  const request = pending.find(item => item?.kind === "question") ?? pending[0];
  const requestText = String(request?.description ?? "").trim() || String(request?.title ?? "").trim() || String(request?.name ?? "").trim() || "";
  const firstLine = requestText.split(/\r?\n/, 1)[0]?.trim() || null;
  const turn = activeTurn && typeof activeTurn === "object" ? activeTurn as { turnId?: unknown; startedAt?: unknown } : null;
  const labels = agent.labels && typeof agent.labels === "object" ? agent.labels as Record<string, string> : undefined;
  const lastError = typeof agent.lastError === "string" ? agent.lastError : agent.lastError ? JSON.stringify(agent.lastError) : "";
  return { id: agent.id, workspaceId: typeof agent.workspaceId === "string" ? agent.workspaceId : null, status: agent.status, active: Boolean(turn),
    model: String(runtime?.model ?? agent.model ?? ""), provider: String(runtime?.provider ?? agent.provider ?? ""),
    modeId: typeof runtime?.modeId === "string" ? runtime.modeId : null,
    thinkingOptionId: typeof runtime?.thinkingOptionId === "string" ? runtime.thinkingOptionId : null,
    labels, permissions: pending.length > 0, pendingPermissionKinds: pending.map(item => typeof item?.kind === "string" ? item.kind : ""), error: lastError,
    ...(request ? { pendingRequest: { id: String(request.id ?? ""), kind: String(request.kind ?? ""), firstLine } } : {}),
    activeTurnId: turn && typeof turn.turnId === "string" ? turn.turnId : null,
    updatedAt: typeof agent.updatedAt === "string" ? agent.updatedAt : "",
    turnStartedAt: turn && typeof turn.startedAt === "string" ? turn.startedAt : null,
    lastUserMessageAt: typeof agent.lastUserMessageAt === "string" ? agent.lastUserMessageAt : null,
    mcpBindingPath: mcpBindingPathFromHostRecord(agent) };
}
/** Catalog feature discovery runs at most this many host requests at once. */
const CATALOG_FEATURE_CONCURRENCY = 4;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export function paseoAdapterClass(Policy: HostPolicyConstructor) {
return class PaseoAdapter extends Policy {
  readonly supportsCoordinatorRecovery = true;
  readonly vocabulary = paseoVocabulary;
  readonly client: DaemonClient;
  readonly provenanceClient: ProvenanceClient;
  readonly api;
  hostId = "";
  constructor(url: string, readonly socketPath: string, readonly helperPath: string, password?: string, readonly mcpScriptPath?: string,
    readonly testPlacement?: { dataDir: string; retainedDataDirs?: string[]; admit: (path: string) => void }) {
    super();
    this.client = new DaemonClient({ url, password, clientId: "nucleus-backend", appVersion: "0.8.0", connectTimeoutMs: 5000, reconnect: { enabled: true, maxDelayMs: 15000 } });
    this.provenanceClient = new ProvenanceClient({ url, password, clientId: "nucleus-provenance", appVersion: "0.15.2", connectTimeoutMs: 5000, reconnect: { enabled: true, maxDelayMs: 15000 } });
    this.api = createPaseoApi(timedDaemonRequests(this.client));
  }
  admissionLaunchEnv: Record<string, string> = {};
  private presenceProjection: RunPresenceDaemon | null = null;
  private messageHostCache: PaseoMessageHost | null = null;
  get messageHost(): PaseoMessageHost { return this.messageHostCache ??= new PaseoMessageHost(this); }
  private questionHostCache: PaseoQuestionHost | null = null;
  private get questionHost(): PaseoQuestionHost { return this.questionHostCache ??= new PaseoQuestionHost(this); }
  private askHostCache: PaseoAskHost | null = null;
  /** The native ask, consult and decider calls (`host/paseo/host-asks.ts`), built once over this adapter. */
  private get askHost(): PaseoAskHost { return this.askHostCache ??= new PaseoAskHost(this); }
  private workspaceHostCache: PaseoWorkspaceHost | null = null;
  /**
   * The Paseo host's workspace calls (`host/paseo/host-workspaces.ts`): native
   * inventory, project lookup, registration and title. Built once over this
   * adapter and reading `this.api` per call, so a test's replaced daemon surface
   * is the one called. Core keeps inspection, the owned path and Git, and calls
   * these at the points it already called Paseo.
   */
  createReviewEntryWorkspace(spec: {requestId:string;title:string;repoPath:string;prNumber:number}) {
    return this.api.workspaces.create({requestId:spec.requestId,title:spec.title,
      source:{kind:'worktree',cwd:spec.repoPath,action:'checkout',checkoutSource:{kind:'change_request',forge:'github',number:spec.prNumber,projectPath:spec.repoPath}}});
  }

  get workspaceHost(): PaseoWorkspaceHost { return this.workspaceHostCache ??= new PaseoWorkspaceHost(this); }
  /**
   * The daemon surface the live-run presence projection uses (task 530): the
   * operator's workspace inventory, this host's terminals and the workspace
   * labels. These are best-effort projections outside every admitted run's
   * timing and call budget: a failed call is logged by the caller and nothing
   * here can admit, hold or settle a run.
   */
  get liveRunPresence(): RunPresenceDaemon {
    return this.presenceProjection ??= {
      workspaces: async () => (await this.workspaceHost.workspaceInventory()).map(workspace => ({
        id: workspace.id, directory: workspace.workspaceDirectory ?? null, labels: workspace.labels ?? [] })),
      listTerminals: async workspaceId => (await this.client.listTerminals(undefined, undefined, { workspaceId }))
        .terminals.map(terminal => ({ id: terminal.id, name: terminal.name })),
      createTerminal: async input => {
        const created = await this.client.createTerminal(input.cwd, input.name, input.requestId,
          { command: input.command, args: input.args, workspaceId: input.workspaceId });
        if (!created.terminal) throw new Error(created.error || "Paseo created no terminal");
        return { id: created.terminal.id };
      },
      // Opening the project's own entry on a checkout is the one workspace effect
      // this projection makes, and only when the operator has none open on it: the
      // daemon registers the entry and creates no worktree.
      openWorkspace: async input => {
        const workspace = await this.api.workspaces.open(input.directory, input.requestId);
        return { id: workspace.id, directory: workspace.directory };
      },
      ensureWorkspaceLabel: async label => { await this.client.updateWorkspaceLabel({ name: label.name, color: label.color }); },
      assignWorkspaceLabel: async input => {
        await this.client.setWorkspaceLabel({ workspaceId: input.workspaceId, label: input.label, assigned: input.assigned, requestId: input.requestId });
      },
    };
  }
  /** Queue-owned Effigy admission hook env for worker/reviewer launches. Empty until the admission socket is configured. */
  setAdmissionLaunchEnv(env: Record<string, string> | null): void {
    this.admissionLaunchEnv = env ?? {};
  }
  get reportingViaMcp() { return Boolean(this.mcpScriptPath); }
  private mcpConfig(path:string) { return {nucleus:{type:"stdio" as const,command:"node",args:[this.mcpScriptPath!,path,"report"],alwaysLoad:true}}; }
  unsupportedMcp(error: unknown) { return /Provider '.+' does not support MCP servers/.test(error instanceof Error ? error.message : String(error)); }
  async connect() { await this.client.connect(); await this.provenanceClient.connect(); const status = await this.client.getDaemonStatus(); this.hostId = status.serverId; }
  async close() { await this.provenanceClient.close(); await this.client.close(); }
  /**
   * The host catalog (`shared/host.ts`): every provider the daemon reports, each
   * model with its thinking options, and the modes and feature values the host
   * offers for it. One snapshot read lists providers, models and modes; feature
   * values need a working directory because Paseo resolves project config per
   * directory, so they are listed only when the caller supplies one.
   */
  async catalog(options: HostCatalogOptions = {}): Promise<HostCatalog> {
    const snapshot = await this.api.providers.snapshot(options.cwd ? { cwd: options.cwd } : {});
    const providers: HostProvider[] = (snapshot.entries ?? []).map(entry => {
      const modes = (entry.modes ?? []).map(mode => ({ id: mode.id, label: mode.label, ...(mode.description ? { description: mode.description } : {}) }));
      const label = entry.label ?? entry.provider;
      // A provider the host has disabled still counts as reported, but not as a
      // host this profile can run on.
      const enabled = entry.enabled !== false;
      const available = enabled && entry.status === "ready";
      return {
        key: entry.provider, label, available,
        problem: entry.error ?? (!enabled ? `Provider ${label} is disabled on this host` : available ? "" : `Provider ${label} is ${entry.status}`),
        models: (entry.models ?? []).map(model => ({
          id: model.id, label: model.label, aliases: model.aliases ?? [],
          thinkingOptions: (model.thinkingOptions ?? []).map(option => ({
            id: option.id, label: option.label, ...(option.isDefault ? { isDefault: true } : {}),
          })),
          defaultThinkingOptionId: model.defaultThinkingOptionId ?? null,
          modes,
          features: [],
        } as HostModel)),
      };
    });
    if (options.cwd) await this.listCatalogFeatures(providers, options.cwd);
    // Without a working directory this read carries no feature answer: mark it
    // deferred so availability judges feature values only against an
    // authoritative one (nucleus#1139 review).
    return options.cwd ? { providers } : { providers, featuresDeferred: true };
  }
  /**
   * Feature controls are per provider and model and need a project directory. A
   * model the host cannot describe keeps its empty set, and requests are bounded
   * rather than one per model at once.
   */
  private async listCatalogFeatures(providers: HostProvider[], cwd: string) {
    const targets = providers.filter(provider => provider.available)
      .flatMap(provider => provider.models.map(model => ({ key: provider.key, model })));
    for (let start = 0; start < targets.length; start += CATALOG_FEATURE_CONCURRENCY) {
      await Promise.all(targets.slice(start, start + CATALOG_FEATURE_CONCURRENCY).map(async ({ key, model }) => {
        try {
          const result = await this.api.providers.listFeatures({ provider: `${key}/${model.id}`, cwd });
          model.features = (result.features ?? []).map((feature): HostFeature => feature.type === "toggle"
            ? { type: "toggle", id: feature.id, label: feature.label, value: feature.value, ...(feature.description ? { description: feature.description } : {}) }
            : { type: "select", id: feature.id, label: feature.label, value: feature.value, ...(feature.description ? { description: feature.description } : {}),
                options: feature.options.map(option => ({ id: option.id, label: option.label, ...(option.isDefault ? { isDefault: true } : {}), ...(option.description ? { description: option.description } : {}) })) });
        } catch { /* The model keeps its empty feature set; the rest of the catalog still stands. */ }
      }));
    }
  }

  /** Tests may stub this to inject still-running / unknown process evidence. */
  scanForWorktreeAdd?: (targetPath: string) => ProcessSearch;
  /** Engine hook for durable per-step creation timings and the visible wait reason. */
  workspaceCreationProgress?: (taskId: string, step: string, status: "started" | "finished" | "skipped", elapsedMs?: number, outcome?: "ok" | "failed") => void;
  /**
   * Write one core-computed title through the host. The cap and the identity
   * refusal are core's, so this is a plain return of the host's own promise: no
   * async wrapper adds a turn ahead of the native refresh.
   */
  setTaskWorkspaceTitle(task:Task,title:string,requestId:string,uncertain:boolean):Promise<void> {
    title=capPaseoTitle(title);
    const workspaceId=task.workspaceId;
    if(!workspaceId)return Promise.reject(Error('Task workspace is missing'));
    return this.workspaceHost.setWorkspaceTitle(workspaceId,title,requestId,uncertain);
  }
  workspaceIdAccepted(id: unknown) { return paseoWorkspaceIdAccepted(id); }
  workspaceAvailable(id:string) {
    return this.workspaceHost.workspaceAvailable(id);
  }
  taskWorkspaceArchived(id:string) {
    return this.workspaceHost.workspaceArchived(id);
  }
  /** The native create for one worker attempt: the host's configuration, MCP config when attached, and core's attempt facts. */
  nativeAgentCreate(spec: HostAgentSpec, mcp: boolean, retry: boolean) {
    const p = spec.profile;
    const attempt = spec.attempt(mcp, retry);
    return this.api.workspaces.ref(spec.workspaceId).agents.create({
      config: { provider: `${p.provider}/${p.model}`, modeId: p.modeId, thinkingOptionId: p.thinkingOptionId, featureValues: p.featureValues, mcpServers: mcp ? this.mcpConfig(spec.mcpBindingPath!) : undefined },
      title: capPaseoTitle(spec.title), prompt: attempt.prompt, autoArchive: false, requestId: attempt.requestId,
      labels: attempt.labels, env: attempt.environment,
    });
  }
  /** Query the current labels, requiring complete inventories and one identity per native agent. */
  private async labelledAgents(filters: Record<string, string>[], includeArchived: boolean) {
    const entries = new Map<string, { agent: any }>();
    for (const labels of filters) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (;;) {
        const result = await this.api.agents.list({ filter: { labels, includeArchived }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
        for (const entry of result.entries) {
          const agent = entry.agent;
          if (!agent || typeof agent.id !== "string") continue;
          if (agent.labels) validateWireLabels(agent.labels);
          const previous = entries.get(agent.id);
          if (previous && (previous.agent.workspaceId !== agent.workspaceId || JSON.stringify(previous.agent.labels ?? {}) !== JSON.stringify(agent.labels ?? {}))) throw new Error('Conflicting agent inventory identity');
          entries.set(agent.id, entry);
        }
        if (!result.pageInfo.hasMore) break;
        const next = result.pageInfo.nextCursor;
        if (!next || cursors.has(next)) throw new Error('Agent lookup was incomplete');
        cursors.add(next); cursor = next;
      }
    }
    return [...entries.values()];
  }
  async findAgents(task: Task) {
    if (!task.runId) return [];
    // Archived history: a thread created before Nucleus still answers by its old run label.
    const entries = await this.labelledAgents([{ 'nucleus.task': task.id }], true);
    return entries.filter(e => historicalWireLabel(e.agent.labels, 'run') === task.runId).map(e => ({ id: e.agent.id, workspaceId: e.agent.workspaceId ?? null }));
  }
  async originAgent(id:string):Promise<OriginAgent|null>{
    const agent=this.api.agents.ref(id);if(!await agent.refresh())return null;
    return {id,workspaceId:agent.workspaceId,title:agent.current()?.title??"",archived:Boolean(agent.archivedAt)};
  }
  async listLiveAgents(): Promise<Array<{ id: string; title: string; workspaceId: string | null; labels?: Record<string, string> }>> {
    const found: Array<{ id: string; title: string; workspaceId: string | null; labels?: Record<string, string> }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.api.agents.list({ filter: { includeArchived: false }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      found.push(...result.entries.map(e => e.agent).filter(a => !a.archivedAt).map(a => {
        const labels = a.labels && typeof a.labels === "object" && !Array.isArray(a.labels)
          ? a.labels as Record<string, string> : undefined;
        return { id: a.id, title: a.title ?? "", workspaceId: a.workspaceId ?? null, ...(labels ? { labels } : {}) };
      }));
      if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) return found;
      cursor = result.pageInfo.nextCursor;
    }
    throw new Error("Live agent inventory was incomplete");
  }
  /**
   * Audit A6: one complete labelled inventory for a pass, answering only the
   * identities it really carries. The label names every thread Queue created, so
   * no foreign thread enters the pass. Only live threads are listed: archived
   * history grows without bound, and an archived identity the pass still wants
   * is absent here and takes the narrow per-agent read. Pagination must reach the
   * daemon's own end with forward cursor progress — a repeated, missing or
   * still-open page answers null, so a partial list is never read as "these are
   * all the threads" and no identity is inferred gone from it.
   */
  async observationInventory(agentIds: readonly string[]): Promise<ReadonlyMap<string, AgentObservation> | null> {
    const wanted = new Set(agentIds.filter(id => typeof id === "string" && id));
    if (!wanted.size) return new Map();
    let entries: Array<{ agent?: Record<string, unknown> }>;
    try {
      entries = await this.labelledAgents([{ 'nucleus.plugin': 'nucleus' }], false);
    } catch (error) {
      if (error instanceof Error && /Agent lookup was incomplete|Conflicting|Invalid .* plugin label/.test(error.message)) return null;
      throw error;
    }
    const observations = new Map<string, AgentObservation>();
    for (const entry of entries) {
      const id = entry?.agent?.id;
      if (typeof id !== "string" || !wanted.has(id)) continue;
      const observation = observationFromInventoryEntry(entry.agent);
      if (observation && observation.id === id) observations.set(id, observation);
    }
    return observations;
  }
  async observe(id: string): Promise<AgentObservation> {
    const agent = this.api.agents.ref(id);
    if (!await agent.refresh()) throw new Error("Agent was not found");
    const current = agent.current();
    const pending = agent.pendingPermissions ?? [];
    const request = pending.find(item => item.kind === "question") ?? pending[0];
    const requestText = request?.description?.trim() || request?.title?.trim() || request?.name?.trim() || "";
    const firstLine = requestText.split(/\r?\n/, 1)[0]?.trim() || null;
    return { id, workspaceId: agent.workspaceId, status: agent.status ?? "unknown", active: Boolean(agent.activeTurn),
      model: String(agent.runtimeInfo?.model ?? current?.model ?? ""),
      provider: String(agent.runtimeInfo?.provider ?? current?.provider ?? ""),
      modeId: agent.runtimeInfo?.modeId ?? null, thinkingOptionId: agent.runtimeInfo?.thinkingOptionId ?? null,
      labels: current?.labels,
      permissions: Boolean(agent.pendingPermissions?.length), pendingPermissionKinds: pending.map(request => request.kind), error: agent.lastError ? typeof agent.lastError === "string" ? agent.lastError : JSON.stringify(agent.lastError) : "",
      ...(request ? { pendingRequest: { id: request.id, kind: request.kind, firstLine } } : {}),
      activeTurnId: agent.activeTurn?.turnId ?? null,
      updatedAt: current?.updatedAt ?? "", turnStartedAt: agent.activeTurn?.startedAt ?? null,
      lastUserMessageAt: (current as { lastUserMessageAt?: string | null } | undefined)?.lastUserMessageAt ?? null,
      mcpBindingPath: mcpBindingPathFromHostRecord(current) };
  }
  pendingQuestions(agentId: string) { return this.questionHost.pendingQuestions(agentId); }
  answerNativeQuestion(agentId: string, workspaceId: string, requestId: string, answers: Record<string, string>) { return this.questionHost.answerNativeQuestion(agentId, workspaceId, requestId, answers); }
  dismissNativeQuestion(agentId: string, workspaceId: string, requestId: string) { return this.questionHost.dismissNativeQuestion(agentId, workspaceId, requestId); }
  /** Interrupt the active turn and deliver one continuation; used by disposition drain. */
  interruptAndContinue(id: string, messageId: string, text: string): Promise<void> {
    return this.messageHost.interruptAndContinue(id, messageId, text);
  }
  /** Queue a message behind the current step; used by live brief amendments. */
  enqueueMessage(id: string, messageId: string, text: string): Promise<void> {
    return this.messageHost.enqueueMessage(id, messageId, text);
  }
  /**
   * Spec 058 slice 1: a live stream of one agent's turn events, established before this
   * resolves. Push delivery only: Queue never polls for usage. The stream carries each
   * turn's own usage on `turn_completed`; the snapshot's `lastUsage` is last turn only.
   */
  async subscribeRunUsage(id: string, handler: (event: RunUsageStreamEvent) => void): Promise<RunUsageStream> {
    const stream = this.api.agents.ref(id).timeline.subscribe(event => handler(event as unknown as RunUsageStreamEvent));
    await stream.ready;
    return stream;
  }
  /** Cancel only the active agent turn; unlike interruptAndContinue this starts no continuation. */
  async stopAgentTurn(id: string): Promise<void> {
    await this.client.cancelAgent(id);
  }
  /**
   * One newest page. Preserve missing coverage facts as unknown; the shared
   * owned-tool reader widens bounded tails when this page is insufficient.
   */
  async agentTimelinePage(id: string, limit = 40): Promise<import('../../../core/host').TimelinePage | null> {
    try {
      const payload = await this.api.agents.ref(id).timeline.refetch({ direction: "tail", limit });
      if (payload.error) return null;
      const entries = (payload.entries as Array<{ timestamp?: string; turnId?: string; item: import('../../../core/host').TimelineEntry['item'] }>)
        .map(entry => ({ timestamp: String(entry.timestamp ?? ''), ...(entry.turnId ? { turnId: entry.turnId } : {}), item: entry.item }));
      return { entries, hasOlder: payload.hasOlder, gap: payload.gap, hasNewer: payload.hasNewer,
        staleCursor: payload.staleCursor, reset: payload.reset, epoch: payload.epoch,
        startCursor: payload.startCursor, endCursor: payload.endCursor, projection: payload.projection };
    } catch { return null; }
  }
  /** One newest timeline page for a stalled-turn or long-shell check; any failure reads as no evidence. */
  async agentTimeline(id: string, limit = 40): Promise<import('../../../core/host').TimelineEntry[] | null> {
    return (await this.agentTimelinePage(id, limit))?.entries ?? null;
  }
  /**
   * Spec 058 (task 542): answered native questions from the existing
   * permission-resolution surface. A timeline `permission_resolved` entry with
   * an allow behavior and an answers map is one answered question; anything
   * unreadable is empty, never evidence.
   */
  answeredQuestions(agentId: string): Promise<Array<{ requestId: string; question: string; answers: Record<string, string> }>> { return this.questionHost.answeredQuestions(agentId); }

  async archiveAgent(id: string): Promise<void> {
    const agent = this.api.agents.ref(id);
    let refreshed;
    try { refreshed = await agent.refresh(); }
    catch (error) { throw new ArchiveNotDeliveredError(error); }
    if (!refreshed || agent.archivedAt) return;
    const result = await agent.archive();
    if (!result.archivedAt) throw new Error(`Agent archive was not confirmed for ${id}`);
  }
  async findRunAgents(run: Run) {
    // Archived history: a thread created before Nucleus still answers by its old task label.
    const entries = await this.labelledAgents([{ 'nucleus.run': run.id }], true);
    return entries.filter(e => historicalWireLabel(e.agent.labels, 'task') === run.taskId).map(e => ({ id: e.agent.id, workspaceId: e.agent.workspaceId ?? null }));
  }
  /** The caller persists the intent before invoking this operation. */
  raiseTaskDecision(task: Task, input: NativeDecisionInput): Promise<string> { return this.questionHost.raiseTaskDecision(task, input); }
  /** Read by the Paseo ask host and by the adapter's own notices; the one idle delivery path. */
  sendWhenIdle(agentId: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }): Promise<boolean> {
    return this.messageHost.sendWhenIdle(agentId, input);
  }
  /** Answers arrive only through the authenticated command, never through the host's chat output. */
  askPlanner(planner: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }): Promise<string | null> { return this.askHost.askPlanner(planner, input); }
  askReviewer(reviewer: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }): Promise<string | null> { return this.askHost.askReviewer(reviewer, input); }
  createConsultReviewer(task: Task, input: { profile: Profile; id: string }) { return this.askHost.createConsultReviewer(task, input); }
  runDecider(task: Task, input: { profile: Profile; signal: AbortSignal; timeoutMs: number; decisionId: string }): Promise<{ agentId: string; text: string | null }> { return this.askHost.runDecider(task, input); }
  answerTaskDecision(task: Task, input: { requestId: string; header: string; answer: string }): Promise<void> { return this.questionHost.answerTaskDecision(task, input); }
  async notify(agentId: string, messageId: string, text: string, sourceAgentId?: string) {
    if (!await this.sendWhenIdle(agentId, { prompt: text, messageId, sourceAgentId, signal: new AbortController().signal, timeoutMs: 10 * 60_000 }))
      throw new ProvenPreSendRefusalError('Nucleus notice recipient did not become idle; nothing was sent');
  }
}

}
export type PaseoAdapter = InstanceType<ReturnType<typeof paseoAdapterClass>>;
