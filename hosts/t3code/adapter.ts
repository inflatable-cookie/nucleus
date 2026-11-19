import { realpath, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type {
  Host,
  HostAgentSpec,
  HostWorkspaceSpec,
  HostMessage,
  HostGuardedMessage,
  HostSendGuard,
  HostAsk,
  HostWorkspaceRef,
  HostRetainedAgentRef,
  HostCatalog,
  NativeDecisionInput,
  NativeDecisionAnswer,
} from "../../shared/host";
import type { Task, Profile } from "../../shared/contracts";
import type { TaskAttention } from "../../shared/task-attention";
import { WIRE_LABEL_KEYS } from "../../shared/wire-labels";
import {
  ArchiveNotDeliveredError,
  HostSnapshotPendingError,
  ProvenPreSendRefusalError,
} from "../../core/host";
import { isHostOperationTimeout } from "../../core/host";
import { T3RpcClient, type T3ConnectionConfig } from "./rpc";
import {
  canonicalThinkingValue,
  isThinkingLevel,
  nearestThinkingLevel,
  type ProviderTranslation,
  type ThinkingLevel,
} from "../../shared/profile-vocabulary";
import { t3codeTranslation, t3codeVocabulary } from "./vocabulary";
import {
  descriptorSummary,
  modelDescriptors,
  providerModelShapes,
  providerReportsOptions,
  tableThinkingOptions,
  t3ModelThinking,
  type ConfigModel,
  type ConfigProvider,
  type Descriptor,
  type ModelThinking,
} from "./thinking";
import { T3StateFile, canonical, retiredRecord, restoredRecord } from "./state";
import {
  decode,
  config,
  optionDescriptor,
  T3CompatibilityError,
  runtimeModes,
  defaultRuntimeMode,
  type RuntimeMode,
} from "./contracts";
import {
  activeStatuses,
  T3Reads,
  type Projection,
  type ThreadReadKind,
} from "./reads";
import { identity, T3IntentLedger } from "./intents";
import { T3Presentation } from "./presentation";
import { T3Nesting } from "./nesting";
import { T3Inbox } from "./inbox";
import { T3DecisionCards } from "./decision-cards";
import { isSupportRole, labelRole } from "./one-row";
import type { AcpSessionSurface } from "../../shared/acp/surface";

export interface T3CodeConfig extends T3ConnectionConfig {
  statePath: string;
  probeThreadId?: string;
  /**
   * The service's ACP session surface, when this process serves one. It mints the
   * binding a task's parent thread runs on and releases that thread's held turn; a
   * host without it keeps top-level role threads (the fallback, nucleus#1305).
   */
  acp?: () => AcpSessionSurface | null;
  /**
   * How long one re-entry waits for the parent thread's run to appear. The default is
   * the product bound; a test drives a short one (nucleus#1305).
   */
  reentryTimeoutMs?: number;
  /** Opt-in path for a bounded capture of the existing config read. */
  modelCapturePath?: string;
}
const unsupported = (capability: string): never => {
  throw new ProvenPreSendRefusalError(`T3Code does not support ${capability}`);
};
/**
 * The nightly's own wording for the four runtime modes (installed bundle, client
 * `runtimeModes` table): `Supervised`, `Auto-accept edits`, `Auto`, `Full access`.
 * The catalog reports them so Nucleus's profile editor names the choice the way
 * T3 does.
 */
const runtimeModeLabels: Record<
  RuntimeMode,
  { label: string; description: string }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  auto: {
    label: "Auto",
    description:
      "Supported providers approve routine actions; others still ask.",
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
};
/**
 * The runtime modes one provider offers. The nightly omits `supportedRuntimeModes`
 * for a provider with no restriction, and then passes any of the four through;
 * a reported list restricts it, and a request outside it would silently run as
 * `approval-required`, so that list is what the catalog publishes.
 */
const providerRuntimeModes = (
  supported: readonly RuntimeMode[] | undefined,
): readonly RuntimeMode[] =>
  supported && supported.length ? supported : runtimeModes;
type OptionSelection = { id: string; value: string | boolean };
/** One model of `server.getConfig`'s provider snapshot (the shared thinking decision's own types). */
/**
 * The model's real option descriptors from `server.getConfig`, read at launch:
 * a value T3 does not report for that model is refused before send, never
 * dropped silently and never guessed to a nearest choice.
 */
/**
 * The canonical thinking level a translated profile asks for: its
 * `thinkingOptionId` when the host sends the level there, or the value the
 * table's carrier feature carries back to canonical (`translated: ["thinking"]`).
 * A level stored either way is the same fact, so a launch resolves both.
 */
const thinkingLevelFor = (
  profile: Profile,
  translation: ProviderTranslation | undefined,
): ThinkingLevel | null => {
  if (profile.thinkingOptionId)
    return isThinkingLevel(profile.thinkingOptionId)
      ? profile.thinkingOptionId
      : translation
        ? canonicalThinkingValue(translation, profile.thinkingOptionId)
        : null;
  const carrier = translation?.thinkingOption
    ? profile.featureValues?.[translation.thinkingOption]
    : undefined;
  return typeof carrier === "string" && translation
    ? canonicalThinkingValue(translation, carrier)
    : null;
};
/**
 * The refusal for a profile option the model does not report. A model whose
 * options are all missing (`descriptors` given) names what it really reports, so
 * the operator sees the real shape instead of the placeholder "reasoning option"
 * (nucleus#1375).
 */
const optionRefusal = (
  model: string,
  option: string,
  value?: string,
  descriptors?: readonly Descriptor[],
): string => {
  const reported = descriptors
    ? `; its option descriptors are ${descriptorSummary(descriptors)}`
    : "";
  return value === undefined
    ? `T3Code model ${model} has no "${option}" option${reported}`
    : `T3Code model ${model} has no ${option} "${value}"${reported}`;
};
/**
 * The manual fix names the repository path in full. The path comes from
 * Nucleus's own record, not from T3, so it is not secret and is never
 * truncated; only remote-derived fields are bounded.
 */
const createWireGuidance = (repositoryRoot: string) =>
  `T3Code cannot create a project for ${repositoryRoot}; add that folder as a project in T3Code, then restart the task`;

/**
 * The T3 host's composition: one connection, the reads that describe it, the
 * intent ledger every command is recorded in, and the presentation that decides
 * what the board shows.
 *
 * This file is the Host surface itself - catalog, workspaces, launch, messages,
 * closeout and native questions - and nothing else. Each mechanism it calls has
 * one owner: reads (./reads), delivery (./intents) and presentation
 * (./presentation).
 */
export class T3CodeHost implements Host {
  readonly vocabulary = t3codeVocabulary;
  readonly rpc: T3RpcClient;
  readonly state: T3StateFile;
  readonly reads: T3Reads;
  readonly intents: T3IntentLedger;
  readonly presentation: T3Presentation;
  readonly nesting: T3Nesting;
  readonly inbox: T3Inbox;
  readonly decisionCards: T3DecisionCards;
  hostId = "";
  version = "";
  private ready = false;
  private readonly probeThreadId?: string;
  private readonly modelCapturePath?: string;
  private readonly acp: () => AcpSessionSurface | null;
  constructor(options: T3CodeConfig) {
    this.acp = options.acp ?? (() => null);
    this.probeThreadId = options.probeThreadId;
    this.modelCapturePath = options.modelCapturePath ?? process.env.NUCLEUS_T3_MODEL_CAPTURE;
    this.rpc = new T3RpcClient(options);
    this.state = new T3StateFile(options.statePath);
    this.reads = new T3Reads({
      rpc: this.rpc,
      state: this.state,
      requireConnection: () => this.requireConnection(),
      close: () => this.close(),
    });
    this.intents = new T3IntentLedger({
      rpc: this.rpc,
      state: this.state,
      hostId: () => this.hostId,
      requireConnection: () => this.requireConnection(),
      forgetRead: (id) => this.reads.forget(id),
    });
    this.presentation = new T3Presentation({
      state: this.state,
      hostId: () => this.hostId,
      requireConnection: () => this.requireConnection(),
      reads: this.reads,
      intents: this.intents,
      parentThreadOf: (taskId) => this.nesting.parentOf(taskId)?.threadId,
    });
    this.decisionCards = new T3DecisionCards({ acp: this.acp, reads: this.reads,
      respond: async (threadId, workspaceId, requestId, response) => this.respondRuntimeRequest(threadId, workspaceId, requestId, response),
    });
    this.inbox = new T3Inbox({
      hostId: () => this.hostId, acp: this.acp, state: this.state, reads: this.reads, rpc: this.rpc, intents: this.intents,
      workspace: async directory => {
        const created = await this.createWorkspace({ title: "Nucleus", requestId: `inbox:${this.hostId}`, directory, project: { workspaceRoot: directory } });
        return { id: created.id, projectId: this.state.read().workspaces[created.id].projectId };
      },
    });
    this.nesting = new T3Nesting({
      rpc: this.rpc,
      state: this.state,
      reads: this.reads,
      intents: this.intents,
      presentation: this.presentation,
      hostId: () => this.hostId,
      requireConnection: () => this.requireConnection(),
      acp: this.acp,
      ...(options.reentryTimeoutMs === undefined
        ? {}
        : { reentryTimeoutMs: options.reentryTimeoutMs }),
      modelSelectionOptionsFor: (profile, provider, model) =>
        this.modelSelectionOptions(profile, provider, model),
      roleRuntimeMode: (provider, roleProfile) =>
        this.launchRuntimeMode(roleProfile, provider.supportedRuntimeModes),
    });
  }
  get connected() {
    return this.ready && this.rpc.connected;
  }
  get lastDisconnectReason() {
    return this.rpc.lastDisconnectReason;
  }
  get lastProtocolError() {
    return this.rpc.lastProtocolError;
  }
  get threadShapePending() {
    return this.reads.threadShapePending;
  }
  get compatibilityFailure() {
    return this.reads.compatibilityFailure;
  }
  /**
   * Whether this host is parenting role threads on the Nucleus ACP provider, or why
   * it is not, as `service.health`'s `t3code.nativeParenting` line (nucleus#1305).
   */
  get nativeParentingStatus(): string {
    return this.nesting.statusLine();
  }
  /**
   * Each provider instance's models with the real option descriptors (id, type,
   * role) the last `server.getConfig` read reported, as `service.health`'s
   * `t3code.modelShapes` line (nucleus#1375). It is a bounded summary of a read the
   * adapter already made — no call of its own — so a refusal names the shape the
   * snapshot really carried.
   */
  get modelShapes(): string {
    return this.modelShapeSummary;
  }
  private modelShapeSummary = "";
  /**
   * Keep the last read's model shapes, bounded: providers report at most a few
   * dozen models, and the line is a diagnostic, not a catalogue. Everything is
   * T3's own provider/model/option vocabulary — no endpoint, credential or
   * environment identity.
   */
  private async retainModelShapes(observed: z.infer<typeof config>): Promise<void> {
    const line = observed.providers
      .filter((provider) => provider.enabled && provider.models.length)
      .slice(0, 12)
      .map(providerModelShapes)
      .join(" | ");
    this.modelShapeSummary =
      line.length > 4_000 ? `${line.slice(0, 4_000)}…` : line;
    if (this.modelCapturePath) {
      // Only model entries from the already decoded read; never settings, credentials
      // or environment identity. Bound both the number of entries and output bytes.
      const piFixtureModels = new Set([
        "default",
        "opencode-go/deepseek-v4.1-flash",
        "opencode-go/muse-spark-1.3-contributor",
      ]);
      const providers = observed.providers
        .filter((provider) => ["codex", "pi", "claudeAgent"].includes(provider.instanceId))
        .slice(0, 3)
        .map(({ instanceId, status, models }) => ({
          instanceId, status,
          models: instanceId === "codex"
            ? models.filter((model) => ["gpt-6.1-terra", "gpt-6-luna"].includes(model.slug))
            : instanceId === "pi"
              ? [...models.filter((model) => piFixtureModels.has(model.slug)),
                  ...models.filter((model) => !piFixtureModels.has(model.slug))].slice(0, 16)
              : models.slice(0, 16),
        }));
      const capture = JSON.stringify({ providers }, null, 2);
      if (Buffer.byteLength(capture) > 256 * 1024)
        throw new Error("T3Code model capture exceeds 256 KiB");
      await writeFile(this.modelCapturePath, capture + "\n", { mode: 0o600 });
    }
  }
  capabilities() {
    return {
      reportingViaMcp: false,
      supportsCoordinatorRecovery: false,
      nativeDecisions: false,
      uiContributions: false,
      lifecycleDispatch: false,
      perThreadEnvironment: false,
    };
  }
  async connect(probeThreadId = this.probeThreadId): Promise<void> {
    this.ready = false;
    this.reads.resetShape();
    this.reads.resetObservation();
    try {
      await this.rpc.connect();
      const observed = decode(
        config,
        await this.rpc.call("server.getConfig", {}),
        "server.getConfig",
      );
      await this.retainModelShapes(observed);
      const hostId = `t3code:${observed.environment.environmentId}`;
      const previous = this.state.read();
      if (previous.hostId && previous.hostId !== hostId)
        throw new T3CompatibilityError("environment.environmentId changed");
      const shell = await this.reads.readShell();
      const probe =
        probeThreadId ?? [...shell.threads, ...shell.archivedThreads][0]?.id;
      this.reads.markShapePending(!probe);
      if (probe) await this.reads.readProjection(probe, "observation");
      this.state.update((state) => {
        state.hostId = hostId;
        state.lastPassedVersion = observed.environment.serverVersion;
      });
      // The nesting path needs the Nucleus ACP provider instance; record the answer
      // from this same read-only probe so the host status says it up front.
      try {
        this.nesting.recordProvider(observed);
      } catch {
        /* the status keeps whatever it had */
      }
      this.hostId = hostId;
      this.version = observed.environment.serverVersion;
      this.ready = true;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    this.ready = false;
    this.rpc.close();
  }
  /** The authenticated connection this durable identity proved, or a typed refusal. */
  private requireConnection() {
    if (!this.connected)
      throw new T3CompatibilityError(
        "authenticated host connection is unavailable",
      );
    if (this.state.read().hostId !== this.hostId)
      throw new T3CompatibilityError("durable host identity changed");
  }
  async profiles(): Promise<Profile[]> {
    return [];
  }
  /**
   * One host pass opens (nucleus#1328): the tasks this host still works on decide
   * which threads stay observed, and the pass's reads are shared across its
   * consumers. A thread whose task is over, or that T3 reports archived or removed,
   * leaves observation here: its live agent record moves to the retired index, which
   * is what an exact settle or lookup still reads. Nothing in T3 is touched.
   */
  async beginHostPass(tasks: readonly Task[]): Promise<void> {
    this.reads.beginPass(tasks);
    await this.reconcileObservation();
  }
  /** The pass closes: the next one reads the thread list afresh. */
  endHostPass() {
    this.reads.endPass();
  }
  /**
   * Move the records of threads this host no longer observes out of the live map.
   * Only the launch identity (workspace and labels) is kept, so an exact settle or
   * lookup still answers; the ledger, the settle markers and every recorded intent
   * stay exactly as recorded.
   *
   * The move is reversible: a thread T3 no longer reports archived (a person or a
   * planner re-attached it) returns to observation on the next pass with the record it
   * had. The retired record keeps every fact this host's own rows read from it — the
   * launch identity, the recorded parent link a nested child's one-row rule needs, and
   * the task's state title — so the round trip loses nothing (nucleus#1328 review).
   */
  async reconcileObservation(): Promise<void> {
    const state = this.state.read();
    const tracked = Object.keys(state.agents),
      retiredIds = Object.keys(state.retiredAgents ?? {});
    if (!tracked.length && !retiredIds.length) return;
    const retire: string[] = [],
      restore: string[] = [];
    for (const id of tracked)
      if (!(await this.reads.isObserved(id))) retire.push(id);
    for (const id of retiredIds) {
      if (state.retiredAgents?.[id]?.deletedAt) continue;
      if (await this.reads.isObserved(id)) restore.push(id);
    }
    if (!retire.length && !restore.length) return;
    this.state.update((next) => {
      next.retiredAgents ??= {};
      for (const id of retire) {
        const record = next.agents[id];
        if (!record) continue;
        next.retiredAgents[id] = retiredRecord(record);
        delete next.agents[id];
      }
      for (const id of restore) {
        const record = next.retiredAgents?.[id];
        if (!record || next.agents[id]) continue;
        next.agents[id] = restoredRecord(id, record);
        delete next.retiredAgents[id];
      }
    });
  }
  async observationInventory(ids: readonly string[]) {
    try {
      // A thread that left observation is not read: the pass's identity list never
      // turns a finished thread back into a full snapshot (nucleus#1328). The whole
      // list is walked either way, so a shorter map is still a complete answer.
      const observed: string[] = [];
      for (const id of ids)
        if (await this.reads.isObserved(id)) observed.push(id);
      return new Map(
        await Promise.all(
          observed.map(
            async (id) => [id, await this.reads.observe(id)] as const,
          ),
        ),
      );
    } catch (error) {
      if (isHostOperationTimeout(error)) throw error;
      return null;
    }
  }
  async activeThreads() {
    return await this.reads.activeThreads();
  }
  async findAgents(labels: Record<string, string>) {
    return await this.reads.findAgents(labels);
  }
  /** The retention pass's archived inventory; see `T3Reads.archivedThreads`. */
  async archivedThreads() {
    return await this.reads.archivedThreads();
  }
  /** One thread's fresh archive fact; see `T3Reads.threadArchiveState`. */
  async threadArchiveState(id: string) {
    return await this.reads.threadArchiveState(id);
  }
  async listLiveAgents() {
    return await this.reads.listLiveAgents();
  }
  async observe(id: string) {
    return await this.reads.observe(id);
  }
  async originAgent(id: string) {
    this.requireConnection();
    const { threads } = await this.reads.inventory();
    const found = threads.find((t) => t.id === id);
    if (!found) {
      this.presentation.retireDeletedPresentationIntents(id);
      return null;
    }
    // A deleted thread may no longer have a readable projection. The complete
    // shell inventory's tombstone is already positive proof of the deletion.
    // An archived thread, or one whose task is over, has left observation: its
    // list row and recorded identity answer this read with no snapshot at all.
    if (found.deletedAt || found.archivedAt || !this.reads.observes(id)) {
      if (found.deletedAt)
        this.presentation.retireDeletedPresentationIntents(id);
      return {
        id,
        workspaceId:
          this.reads.workspaceFor(found) ??
          (
            this.state.read().agents[id] ??
            this.state.read().retiredAgents?.[id]
          )?.workspaceId ??
          `t3-project:${found.projectId}`,
        title: found.title,
        archived: !!found.archivedAt,
        deleted: !!found.deletedAt,
      };
    }
    const p = await this.reads.readProjection(id, "observation");
    if (p.thread.deletedAt)
      this.presentation.retireDeletedPresentationIntents(id);
    return {
      id,
      workspaceId:
        this.reads.workspaceFor(p.thread) ?? `t3-project:${p.thread.projectId}`,
      title: p.thread.title,
      archived: !!p.thread.archivedAt,
      deleted: !!p.thread.deletedAt,
    };
  }
  /** One synchronized thread snapshot: the reads module owns the decode, the host owns this entry to it. */
  readProjection(threadId: string, kind?: ThreadReadKind) {
    return this.reads.readProjection(threadId, kind);
  }
  async agentTimelinePage(id: string, limit = 100) {
    return await this.reads.agentTimelinePage(id, limit);
  }
  async agentTimeline(id: string, limit?: number) {
    return await this.reads.agentTimeline(id, limit);
  }
  async pendingQuestions(id: string) {
    return await this.reads.pendingQuestions(id);
  }
  async answeredQuestions(id: string) {
    return await this.reads.answeredQuestions(id);
  }
  async setTaskWorkspaceTitle(
    task: Task,
    title: string,
    requestId: string,
    uncertain: boolean,
  ): Promise<void> {
    await this.presentation.setTaskWorkspaceTitle(
      task,
      title,
      requestId,
      uncertain,
    );
  }
  /**
   * The task's one row, from the attention projection the board and `task.next`
   * read (nucleus#1366). Nucleus never settles a task thread: a waiting task is
   * snoozed and a task that needs a person is shown again, while an operator's own
   * settle is left alone.
   */
  async reconcileTaskRow(
    taskId: string,
    attention: TaskAttention,
  ): Promise<void> {
    if (!this.connected) return;
    const pending = this.acp()?.pendingDecisionKey?.(taskId);
    await this.presentation.reconcileTaskRow(taskId, pending ? { state: "attention", cause: "Decision needs an operator" } : attention);
  }
  /** The ordinary host sweep's nesting pass: dispose owed wakes, hold or release the parent's turn, archive a finished task's parent. */
  async reconcileThreadTitles(tasks: readonly Task[]): Promise<void> {
    if (!this.connected) return;
    try {
      await this.inbox.reconcile();
      const state = this.state.read();
      if (state.inbox) await this.decisionCards.reconcile(state.inbox.threadId, state.inbox.workspaceId);
      for (const parent of Object.values(state.parents ?? {})) {
        if (!parent.archivedAt) await this.decisionCards.reconcile(parent.threadId, parent.workspaceId);
      }
      await this.nesting.reconcile(tasks);
    } catch (error) {
      if (isHostOperationTimeout(error))
        throw error; /* retry other faults next pass */
    }
  }

  async catalog(): Promise<HostCatalog> {
    this.requireConnection();
    const value = decode(
      config,
      await this.rpc.call("server.getConfig", {}),
      "server.getConfig",
    );
    await this.retainModelShapes(value);
    return {
      providers: value.providers.map((p) => ({
        key: p.instanceId,
        label: p.displayName ?? p.instanceId,
        available: p.enabled && p.status === "ready",
        problem:
          p.enabled && p.status === "ready"
            ? ""
            : "T3Code provider is unavailable",
        models: p.models.map((m) => {
          const translation = t3codeTranslation(p.instanceId);
          // One decision, shared with the launch fence: the same model entry says
          // which option carries the level (or that the snapshot cannot answer
          // yet). Selection publishes exactly what the fence will send.
          const thinking = t3ModelThinking(p, m, translation);
          // A carrier the table names for the provider (`thinking` for Pi, `effort`
          // for Claude and FX) stays a catalog feature the way it always was; only
          // a generic reasoning select is published as the model's thinking options.
          const reasoning =
            thinking.state === "carrier" &&
            thinking.carrier.id !== translation?.thinkingOption
              ? thinking.carrier
              : undefined;
          const descriptors = modelDescriptors(m);
          const feature = (descriptor: z.infer<typeof optionDescriptor>) =>
            descriptor.type === "boolean"
              ? {
                  type: "toggle" as const,
                  id: descriptor.id,
                  label: descriptor.label,
                  ...(descriptor.description
                    ? { description: descriptor.description }
                    : {}),
                  value: descriptor.currentValue ?? false,
                }
              : {
                  type: "select" as const,
                  id: descriptor.id,
                  label: descriptor.label,
                  ...(descriptor.description
                    ? { description: descriptor.description }
                    : {}),
                  value: descriptor.currentValue ?? null,
                  options: descriptor.options.map((c) => ({
                    id: c.id,
                    label: c.label,
                    ...(c.description ? { description: c.description } : {}),
                    ...(c.isDefault === undefined
                      ? {}
                      : { isDefault: c.isDefault }),
                  })),
                };
          return {
            id: m.slug,
            label: m.name,
            aliases: m.aliases ?? [],
            // A settled carrier publishes its own choices; a snapshot that cannot
            // answer yet publishes the table's levels (for a provider whose level
            // rides the generic reasoning select) and says it is unsettled, so
            // selection keeps the profile the fence will wait for.
            thinkingOptions: reasoning
              ? reasoning.options.map((c) => ({
                  id: c.id,
                  label: c.label,
                  ...(c.isDefault === undefined
                    ? {}
                    : { isDefault: c.isDefault }),
                }))
              : thinking.state === "unsettled" && !translation?.thinkingOption
                ? tableThinkingOptions(translation)
                : [],
            ...(thinking.state === "unsettled" ? { unsettled: true } : {}),
            defaultThinkingOptionId:
              reasoning?.options.find((c) => c.isDefault)?.id ??
              (reasoning?.currentValue &&
              reasoning.options.some((c) => c.id === reasoning.currentValue)
                ? reasoning.currentValue
                : null),
            modes: providerRuntimeModes(p.supportedRuntimeModes).map((id) => ({
              id,
              ...runtimeModeLabels[id],
            })),
            features: descriptors.filter((d) => d !== reasoning).map(feature),
          };
        }),
      })),
    };
  }
  async createWorkspace(spec: HostWorkspaceSpec) {
    this.requireConnection();
    const directory = await realpath(spec.directory);
    const repositoryRoot = spec.project.workspaceRoot
      ? await realpath(spec.project.workspaceRoot)
      : undefined;
    const inventory = await this.reads.inventory();
    let selected = repositoryRoot
      ? inventory.projects.find((p) => p.workspaceRoot === repositoryRoot)
      : inventory.projects.find((p) =>
          spec.project.projectId
            ? p.id === spec.project.projectId
            : p.workspaceRoot === directory,
        );
    // An archived project keeps its repository root: the nightly refuses a second
    // registration for it. Reopening the same registration is the native path.
    if (selected?.archivedAt != null) {
      const reopenId = identity(
        "project-open",
        canonical([this.hostId, selected.id]),
      );
      await this.intents.effect(reopenId, "projects.mutate", {
        type: "project.update",
        commandId: reopenId,
        projectId: selected.id,
        archived: false,
      });
      selected = { ...selected, archivedAt: null };
    }
    if (!selected && repositoryRoot) {
      const projectId = identity(
        "project",
        canonical([this.hostId, repositoryRoot]),
      );
      const commandId = identity(
        "project-create",
        canonical([this.hostId, repositoryRoot]),
      );
      const created = await this.intents.effect(
        commandId,
        "projects.mutate",
        {
          type: "project.create",
          commandId,
          projectId,
          title: basename(repositoryRoot),
          workspaceRoot: repositoryRoot,
        },
        undefined,
        undefined,
        {
          resendUnknownAfterRead: true,
          unsupportedMethodGuidance: createWireGuidance(repositoryRoot),
        },
      );
      decode(
        z
          .object({
            id: z.literal(projectId),
            title: z.string(),
            workspaceRoot: z.string(),
          })
          .passthrough(),
        created,
        "projects.mutate",
      );
      selected = {
        id: projectId,
        title: basename(repositoryRoot),
        workspaceRoot: repositoryRoot,
      };
    }
    if (!selected)
      throw new ProvenPreSendRefusalError(
        createWireGuidance(repositoryRoot ?? directory),
      );
    const id = identity("worktree", canonical([selected.id, directory]));
    this.state.update((state) => {
      const old = state.workspaces[id];
      if (old && (old.directory !== directory || old.projectId !== selected.id))
        throw new ProvenPreSendRefusalError(
          "T3Code workspace identity conflict",
        );
      state.workspaces[id] = {
        id,
        directory,
        projectId: selected.id,
        title: spec.title,
      };
    });
    return { id, directory };
  }

  async repositoryProject(root: string) {
    const workspaceRoot = await realpath(root);
    return {
      projectId: (await this.reads.inventory()).projects.find(
        (p) => p.workspaceRoot === workspaceRoot,
      )?.id,
      workspaceRoot,
    };
  }

  async findWorkspaces(task: Task) {
    return Object.values(this.state.read().workspaces)
      .filter((w) => !w.archivedAt && w.directory === task.directory)
      .map((w) => ({ id: w.id, directory: w.directory }));
  }

  async workspaceAvailable(id: string) {
    const w = this.state.read().workspaces[id];
    return (
      !!w &&
      !w.archivedAt &&
      (await this.reads.inventory()).projects.some(
        (p) => p.id === w.projectId && p.archivedAt == null,
      )
    );
  }

  workspaceIdAccepted(id: unknown) {
    return typeof id === "string" && /^nucleus-worktree-[a-f0-9]{40}$/.test(id);
  }

  workspaceRef(id: string): HostWorkspaceRef {
    const host = this;
    let available = false;
    return {
      get directory() {
        return host.state.read().workspaces[id]?.directory;
      },
      async refresh() {
        available = await host.workspaceAvailable(id);
        return available;
      },
      current() {
        const w = host.state.read().workspaces[id];
        return available && w
          ? {
              projectRootPath: w.directory,
              workspaceDirectory: w.directory,
              projectId: w.projectId,
              workspaceKind: "external",
            }
          : null;
      },
      /** A task archive marks only Nucleus's worktree handle; the record stays to map archived threads. */
      async archive(requestId: string) {
        void requestId;
        const archivedAt = host.state.update((state) => {
          const workspace = state.workspaces[id];
          if (!workspace) return new Date().toISOString();
          workspace.archivedAt ??= new Date().toISOString();
          return workspace.archivedAt;
        });
        return { archivedAt, error: null };
      },
    };
  }

  async workspaceCatalog(_directory: string) {
    return {
      ok: false as const,
      reason:
        "T3Code does not expose a native workspace registration inventory",
    };
  }

  async setWorkspaceTitle(
    _id: string,
    _title: string,
    _request: string,
    _uncertain: boolean,
  ): Promise<void> {
    unsupported("native workspace titles");
  }

  /** The stored task marker retires this handle; native project archive also counts as absent. */
  async workspaceArchived(id: string): Promise<boolean> {
    const workspace = this.state.read().workspaces[id];
    if (!workspace || workspace.archivedAt) return true;
    const found = (await this.reads.inventory()).projects.find(
      (p) => p.id === workspace.projectId,
    );
    return !found || found.archivedAt != null;
  }

  async workspaceTerminals(_id: string) {
    return {
      ok: false as const,
      reason: "T3Code does not expose a workspace terminal inventory",
    };
  }

  async workspaceThreads(ids: readonly string[]) {
    return {
      ok: true as const,
      threads: (await this.reads.activeAndArchivedThreads()).filter(
        (t) => !!t.workspaceId && ids.includes(t.workspaceId),
      ),
    };
  }

  /**
   * One role thread, always the task parent thread's native child (nucleus#1305;
   * nucleus#1366). There is no top-level fallback: a role a child cannot be created
   * for refuses before the send with the reason and the fix, so the task waits
   * visibly on the board — "T3 provider not ready: run `nucleus t3 install`" — or
   * the operator moves it to another host. Nothing is launched that the task's one
   * row would then have to settle.
   */
  async createAgent(spec: HostAgentSpec) {
    this.requireConnection();
    if (spec.mcpBindingPath) unsupported("per-thread MCP reporting");
    if (spec.guard && !(await spec.guard.allowed()))
      throw new ProvenPreSendRefusalError("T3Code launch guard refused");
    const attempt = spec.attempt(false, false),
      workspace = this.state.read().workspaces[spec.workspaceId];
    if (!workspace || workspace.archivedAt)
      throw new ProvenPreSendRefusalError("T3Code workspace is not registered");
    if (Object.keys(attempt.environment).length)
      unsupported("per-thread launch environment");
    // One config read answers every launch fact: the role's model, the runtime mode
    // the provider offers and the parent provider's own existence.
    const observed = decode(
      config,
      await this.rpc.call("server.getConfig", {}),
      "server.getConfig",
    );
    await this.retainModelShapes(observed);
    const provider = observed.providers.find(
      (p) => p.instanceId === spec.profile.provider,
    );
    // Validate against the role provider before creating or re-entering a parent.
    this.modelSelectionOptions(
      spec.profile,
      provider,
      provider?.models.find((m) => m.slug === spec.profile.model),
    );
    if (!provider)
      throw new ProvenPreSendRefusalError(`T3Code provider ${spec.profile.provider} is unavailable`);
    this.launchRuntimeMode(spec.profile, provider.supportedRuntimeModes);
    const title = this.presentation.numberedThreadTitle(
      spec.taskNumber,
      attempt.labels[WIRE_LABEL_KEYS.role],
      spec.title,
    );
    const nested = await this.nesting.create({
      spec,
      attempt,
      profile: spec.profile,
      roleProvider: provider,
      roleModel: provider.models.find((m) => m.slug === spec.profile.model),
      observed,
      workspace: {
        id: spec.workspaceId,
        projectId: workspace.projectId,
        directory: workspace.directory,
      },
      title,
    });
    // A nested create either returns the child or refuses before the send; it never
    // returns "nothing sent, launch a top-level thread instead" (nucleus#1366).
    if (!nested.ok) throw new ProvenPreSendRefusalError(nested.reason);
    // The role's current thread, so a displaced one stops naming the row's step.
    const taskId = attempt.labels[WIRE_LABEL_KEYS.task];
    const role = labelRole(attempt.labels);
    if (taskId && isSupportRole(role))
      this.presentation.noteRoleThread(taskId, role!, nested.id);
    if (this.reads.threadShapePending)
      await this.reads
        .readProjection(nested.id, "observation")
        .catch(() => undefined);
    return { id: nested.id, workspaceId: spec.workspaceId };
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
  launchRuntimeMode(
    profile: Profile,
    supported: readonly RuntimeMode[] | undefined,
  ): RuntimeMode {
    const requested =
      !profile.modeId || profile.modeId === "default"
        ? defaultRuntimeMode
        : profile.modeId;
    if (!(runtimeModes as readonly string[]).includes(requested))
      throw new ProvenPreSendRefusalError(
        `T3Code has no runtime mode ${requested}; its modes are ${runtimeModes.join(", ")}`,
      );
    const offered = providerRuntimeModes(supported);
    if (!offered.includes(requested as RuntimeMode))
      throw new ProvenPreSendRefusalError(
        `T3Code provider ${profile.provider} does not offer runtime mode ${requested}; it offers ${offered.join(", ")}`,
      );
    return requested as RuntimeMode;
  }
  /**
   * The profile's thinking level and reported feature values as the nightly's
   * `ProviderOptionSelection[]` for this exact model, from the `server.getConfig`
   * read the launch already made.
   *
   * The canonical thinking level reaches the model's thinking carrier whichever
   * way the host carries it (Tom, 2026-11-12): the reasoning select T3 reports
   * under its own ids (Codex, Grok, Muse, Kiro), or the option this adapter's
   * table names for the provider (`thinking` for Pi, `effort` for Claude and FX).
   * A level stored as `thinkingOptionId` and a level a translated feature carries
   * (`translated: ["thinking"]`) are the same fact, so both resolve here.
   *
   * This is the pre-send fence, and it decides with `t3ModelThinking` — the same
   * function `catalog()` publishes from, over the same model entry — so a profile
   * selection kept is never refused here. A canonical level this model does not
   * report is settled to the nearest level its carrier offers by the vocabulary's
   * own rule, so a catalog that dropped a level costs the level, never the launch.
   * A settled model that reports no carrier is refused before send, naming the
   * option and the model's real descriptors. A snapshot that cannot answer yet
   * (the provider is probing, or it reports no model options at all) is a host
   * wait, not a refusal: the next pass reads again.
   */
  modelSelectionOptions(
    profile: Profile,
    provider: ConfigProvider | undefined,
    model: ConfigModel | undefined,
  ): OptionSelection[] {
    const translation = t3codeTranslation(profile.provider);
    const features = Object.entries(profile.featureValues ?? {});
    const requested = thinkingLevelFor(profile, translation);
    if (!provider || !model) {
      if (provider && (provider.status !== "ready" || !providerReportsOptions(provider)))
        throw new HostSnapshotPendingError(
          `T3Code reports no ${profile.provider} model ${profile.model} yet`,
        );
      throw new ProvenPreSendRefusalError(
        `T3Code provider ${profile.provider} does not report model ${profile.model}`,
      );
    }
    if (!requested && !features.length) return [];
    const thinking = t3ModelThinking(provider, model, translation);
    if (thinking.state === "unsettled")
      throw new HostSnapshotPendingError(thinking.detail);
    const descriptors = modelDescriptors(model);
    const options: OptionSelection[] = [];
    const consumed = new Set<string>();
    if (requested) {
      const { level, descriptor } = this.thinkingSelection(
        profile,
        requested,
        translation,
        thinking,
      );
      if (translation?.thinkingOption) consumed.add(translation.thinkingOption);
      options.push({ id: descriptor, value: level });
    }
    for (const [option, feature] of features) {
      if (consumed.has(option)) continue;
      const descriptor = descriptors.find((d) => d.id === option);
      if (!descriptor)
        throw new ProvenPreSendRefusalError(
          optionRefusal(profile.model, option, undefined, descriptors),
        );
      const shown =
        typeof feature === "string" ? feature : JSON.stringify(feature);
      if (descriptor.type === "boolean") {
        if (typeof feature !== "boolean")
          throw new ProvenPreSendRefusalError(
            optionRefusal(profile.model, option, shown),
          );
        options.push({ id: option, value: feature });
      } else if (
        typeof feature !== "string" ||
        !descriptor.options.some((choice) => choice.id === feature)
      )
        throw new ProvenPreSendRefusalError(
          optionRefusal(profile.model, option, shown),
        );
      else options.push({ id: option, value: feature });
    }
    return options;
  }

  /**
   * The descriptor and native value one canonical thinking level rides on this
   * model: the carrier `t3ModelThinking` found, which is the table's option when
   * the model reports it and T3's own reasoning select otherwise. The value is
   * the exact level the carrier offers, or the nearest one the vocabulary rule
   * settles on; a settled carrier that offers no canonical level at all is
   * refused naming the carrier and the level.
   */
  private thinkingSelection(
    profile: Profile,
    requested: ThinkingLevel,
    translation: ProviderTranslation | undefined,
    thinking: ModelThinking,
  ): { descriptor: string; level: string } {
    const carrierName = translation?.thinkingOption ?? "reasoning option";
    if (thinking.state === "absent")
      throw new ProvenPreSendRefusalError(
        optionRefusal(
          profile.model,
          carrierName,
          undefined,
          thinking.descriptors,
        ),
      );
    if (thinking.state === "unsettled")
      throw new HostSnapshotPendingError(thinking.detail);
    const { carrier, offered } = thinking;
    const nearest = nearestThinkingLevel(
      offered.map((option) => option.level),
      requested,
    );
    const chosen = nearest
      ? offered.find((option) => option.level === nearest)
      : undefined;
    if (!chosen)
      throw new ProvenPreSendRefusalError(
        optionRefusal(profile.model, carrier.id, requested),
      );
    return { descriptor: carrier.id, level: chosen.value };
  }

  async sendMessage(id: string, input: HostMessage) {
    await this.presentation.unsettleBeforeMessage(id, input.messageId);
    await this.intents.effect(
      input.messageId,
      "orchestration.dispatchCommand",
      {
        type: "message.dispatch",
        commandId: input.messageId,
        threadId: id,
        messageId: identity("message", input.messageId),
        text: input.text,
        attachments: [],
        createdBy: "user",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      },
    );
    // A follow-up to a nested child starts a new delegated task whose completion wake
    // T3 does not dispose; the send already succeeded, so this never fails it.
    await this.nesting
      .afterFollowUp(id, input.messageId)
      .catch(() => undefined);
  }
  async enqueueMessage(id: string, input: HostMessage): Promise<void> {
    await this.sendMessage(id, input);
  }

  async sendGuarded(
    id: string,
    input: HostGuardedMessage,
    guard: HostSendGuard,
  ) {
    // A thread this host no longer observes refuses here, as a guarded send refuses:
    // the retained-thread fence is a pre-send decision, never a thrown read
    // (nucleus#1328 review).
    if (!(await this.reads.isObserved(id)))
      return {
        sent: false as const,
        reason: "T3Code retained-thread guard refused",
      };
    const observed = await this.reads.observe(id);
    if (
      observed.workspaceId !== input.expectedWorkspaceId ||
      observed.active ||
      observed.permissions ||
      observed.archived ||
      observed.status === "gone" ||
      !(await guard.allowed())
    )
      return {
        sent: false as const,
        reason: "T3Code retained-thread guard refused",
      };
    await this.presentation.unsettleBeforeMessage(id, input.messageId);
    await this.intents.effect(
      input.messageId,
      "orchestration.dispatchCommand",
      {
        type: "message.dispatch",
        commandId: input.messageId,
        threadId: id,
        messageId: identity("message", input.messageId),
        text: input.text,
        attachments: [],
        createdBy: "user",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      },
      () => {
        if (!guard.stillAllowed())
          throw new ProvenPreSendRefusalError("T3Code send guard changed");
        guard.beforeSend?.();
      },
    );
    await this.nesting
      .afterFollowUp(id, input.messageId)
      .catch(() => undefined);
    return { sent: true as const };
  }

  async sendWhenIdle(_id: string, _input: HostAsk): Promise<string | null> {
    return unsupported("in-thread Nucleus questions");
  }

  /**
   * One atomic interrupt and continue: the nightly's `steer_active` dispatch
   * mode injects the message into the thread's live run. The run id is read
   * immediately before the send; with no active run there is nothing to steer
   * and the refusal is proven before the socket write.
   */
  async interruptAndContinue(
    id: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const runId = await this.reads.activeRunId(id);
    if (!runId)
      throw new ProvenPreSendRefusalError(
        "T3Code thread has no active run to steer",
      );
    await this.presentation.unsettleBeforeMessage(id, messageId);
    await this.intents.effect(messageId, "orchestration.dispatchCommand", {
      type: "message.dispatch",
      commandId: messageId,
      threadId: id,
      messageId: identity("message", messageId),
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "server",
      dispatchMode: { type: "steer_active", targetRunId: runId },
    });
  }
  /**
   * A message to a participant (Tom, 2026-11-13): steers into the thread's live
   * run with `steer_active`, the run read immediately before the send. With no
   * live run it is the ordinary queued send, as `notify` always was.
   *
   * A steer the adapter proves was not sent (a local fence or a not-sent
   * transport failure) falls back to the queued send once, under its own
   * command identity. Any other steer failure is unknown delivery: a remote
   * refusal cannot prove it stayed unsent (planner ruling, 2026-11-11), so it
   * is never resent.
   */
  async steerOrNotify(id: string, input: HostMessage): Promise<void> {
    const { messageId, text } = input;
    const runId = await this.reads.activeRunId(id);
    if (!runId) return this.sendMessage(id, input);
    try {
      await this.presentation.unsettleBeforeMessage(id, messageId);
      await this.intents.effect(
        identity("steer", messageId),
        "orchestration.dispatchCommand",
        {
          type: "message.dispatch",
          commandId: identity("steer", messageId),
          threadId: id,
          messageId: identity("message", messageId),
          text,
          attachments: [],
          createdBy: "user",
          creationSource: "server",
          dispatchMode: { type: "steer_active", targetRunId: runId },
        },
      );
    } catch (error) {
      if (!(error instanceof ProvenPreSendRefusalError)) throw error;
      return this.sendMessage(id, input);
    }
  }

  /**
   * One explicit stop of this thread's live runs. A thread that has left observation
   * still answers with the run T3's own thread list names, so an operator or a stalled
   * turn stop keeps working; with nothing live there is nothing to send
   * (nucleus#1328 review).
   */
  async stopAgentTurn(id: string) {
    const runs = await this.reads.activeRunIds(id);
    if (!runs.length) return;
    const key = identity("stop", canonical([id, runs]));
    await this.intents.effect(key, "orchestration.dispatchCommand", {
      type: "thread.stop",
      commandId: key,
      threadId: id,
    });
  }

  async archiveAgent(id: string) {
    const key = identity("archive", id);
    await this.intents.effect(key, "orchestration.dispatchCommand", {
      type: "thread.archive",
      commandId: key,
      threadId: id,
    });
  }

  /**
   * Remove one thread permanently at closeout (nucleus#1155). The Nightly's
   * `thread.delete` cancels any active run and any pending request, and its
   * command receipt makes the same command id under the same identity a replay
   * rather than a second removal.
   *
   * `onlyIfUnused` is deliberately not sent: it makes the Nightly answer success
   * without changing a thread that has runs or messages — every thread Nucleus
   * created does — so it would report a removal that never happened.
   *
   * An unknown outcome is never re-sent: the terminal lane reads the thread back
   * (absent from a complete inventory, or `deletedAt`) before anything else.
   */
  async deleteAgent(id: string) {
    const key = identity("delete", id);
    try {
      await this.intents.effect(
        key,
        "orchestration.dispatchCommand",
        { type: "thread.delete", commandId: key, threadId: id },
        undefined,
        undefined,
        { retryRefusedBeforeSend: true },
      );
      this.presentation.retireDeletedPresentationIntents();
    } catch (error) {
      // A local not-sent result leaves the terminal effect ready for the next
      // sweep. Unknown outcomes retain their intent and remain observation-only.
      if (error instanceof ProvenPreSendRefusalError)
        throw new ArchiveNotDeliveredError(error);
      throw error;
    }
  }
  async respondRuntimeRequest(
    agent: string,
    workspace: string,
    requestId: string,
    response: {
      decision?:
        | "accept"
        | "acceptForSession"
        | "acceptAlways"
        | "decline"
        | "cancel";
      answers?: Record<string, unknown>;
    },
    intentId = identity("response", canonical([agent, requestId])),
  ) {
    await this.runtimeResponse(
      agent,
      workspace,
      requestId,
      "runtime-request.respond",
      response,
      intentId,
    );
  }

  async runtimeResponse(
    agent: string,
    workspace: string,
    requestId: string,
    type: "runtime-request.respond" | "thread.user-input.dismiss",
    response: {
      decision?:
        | "accept"
        | "acceptForSession"
        | "acceptAlways"
        | "decline"
        | "cancel";
      answers?: Record<string, unknown>;
    },
    intentId: string,
    mapAnswers?: (projection: Projection) => Record<string, unknown>,
  ) {
    response = JSON.parse(canonical(response));
    const payload = {
      type,
      commandId: intentId,
      threadId: agent,
      requestId,
      ...response,
    };
    await this.intents.effect(
      intentId,
      "orchestration.dispatchCommand",
      payload,
      undefined,
      {
        binding: {
          agentId: agent,
          workspaceId: workspace,
          requestId,
          input: canonical({ type, response }),
        },
        prepare: async () => {
          const { request, projection: p } = await this.reads.runtimeRequest(
            agent,
            workspace,
            requestId,
            mapAnswers ? "transcript" : "observation",
          );
          if (type === "thread.user-input.dismiss") {
            if (request.kind !== "user_input")
              throw new ProvenPreSendRefusalError(
                "T3Code request is not a question",
              );
            return payload;
          }
          if (
            request.kind !== "user_input" &&
            ![
              "command",
              "file-read",
              "file-change",
              "mcp-elicitation",
              "permission",
            ].includes(request.kind)
          )
            throw new ProvenPreSendRefusalError(
              "T3Code runtime request kind is unsupported",
            );
          if (
            request.kind === "user_input"
              ? response.answers
                ? !!response.decision
                : response.decision !== "cancel" && response.decision !== "decline"
              : !response.decision || !!response.answers
          )
            throw new ProvenPreSendRefusalError(
              "T3Code response does not match request kind",
            );
          return mapAnswers ? { ...payload, answers: mapAnswers(p) } : payload;
        },
      },
    );
  }

  async answerNativeQuestion(
    agent: string,
    workspace: string,
    requestId: string,
    answers: Record<string, string>,
  ) {
    answers = { ...answers };
    await this.runtimeResponse(
      agent,
      workspace,
      requestId,
      "runtime-request.respond",
      { answers },
      identity("response", canonical([agent, requestId])),
      (p) => {
        const questions = p.turnItems.find(
          (t) => t.type === "user_input_request" && t.requestId === requestId,
        )?.questions;
        if (!questions)
          throw new T3CompatibilityError("runtimeRequest.questions");
        const mapped: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(answers)) {
          const matches = questions.filter(
            (q) => q.id === key || q.header === key,
          );
          if (matches.length !== 1 || mapped[matches[0].id] !== undefined)
            throw new ProvenPreSendRefusalError(
              "T3Code answer question identity is ambiguous",
            );
          mapped[matches[0].id] = [value];
        }
        if (!Object.keys(mapped).length)
          throw new ProvenPreSendRefusalError(
            "T3Code question answer is empty",
          );
        return mapped;
      },
    );
  }

  async dismissNativeQuestion(
    agent: string,
    workspace: string,
    requestId: string,
  ) {
    await this.runtimeResponse(
      agent,
      workspace,
      requestId,
      "thread.user-input.dismiss",
      {},
      identity("dismiss", canonical([agent, requestId])),
    );
  }

  async raiseDecision(
    _agent: string,
    _workspace: string,
    _input: NativeDecisionInput,
  ): Promise<string> {
    return unsupported("in-thread Nucleus decisions");
  }
  async answerDecision(
    _agent: string,
    _workspace: string,
    _input: NativeDecisionAnswer,
  ): Promise<void> {
    unsupported("in-thread Nucleus decisions");
  }

  retainedAgentRef(id: string): HostRetainedAgentRef {
    const host = this;
    let observed: Awaited<ReturnType<T3CodeHost["observe"]>> | null = null;
    return {
      get workspaceId() {
        return observed?.workspaceId ?? null;
      },
      get archivedAt() {
        return observed?.archived || observed?.status === "archived"
          ? true
          : null;
      },
      get status() {
        return observed?.status ?? null;
      },
      get activeTurn() {
        return observed?.active ? { turnId: observed.activeTurnId } : null;
      },
      get pendingPermissions() {
        return observed ? (observed.pendingPermissionKinds ?? null) : null;
      },
      get runtimeInfo() {
        return observed
          ? { provider: observed.provider, model: observed.model }
          : null;
      },
      async refresh() {
        observed = await host.observe(id);
        return observed;
      },
      current() {
        return observed;
      },
      async send(text, options) {
        await host.sendMessage(id, { text, messageId: options.messageId });
      },
    };
  }
}
