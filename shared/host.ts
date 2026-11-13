import { z } from "zod";
import type { NucleusProfile } from "./profiles";
import type { HostVocabulary } from "./profile-vocabulary";
import type { Profile, Task } from "./contracts";

/**
 * One agent application Nucleus drives (Paseo today, others later). The host
 * reports what it can run; Nucleus owns the profiles that choose from that
 * list, so a profile stays portable and only its availability is per host
 * (Tom, 2026-11-06/07, `docs/knowledge/vision.md`).
 *
 * The shape is Nucleus's own, not the Paseo adapter's types, so a second host
 * implements the same shape. This is the whole target surface of the Paseo
 * host split map (task 871, "Host contract"). A method joins a host's façade
 * (`core/host/host-facade.ts`) when a delegate can keep its call timing; until
 * then only the contract names it.
 *
 * Errors keep their classes. A proven pre-send refusal is `ProvenPreSendRefusalError`
 * (`core/recovery/task-reasons.ts`) or a `refused` result, and any other rejection from a
 * send is unknown delivery: nothing retries it, and an observation settles it.
 */
export interface Host {
  /**
   * Every provider the host reports, each provider's models with their
   * thinking options, and the modes and feature values each model offers.
   *
   * Feature values depend on the host's project context (Paseo resolves them
   * per working directory), so a host reports none when the caller supplies no
   * `cwd` and marks the read `featuresDeferred`: availability judges feature
   * values only against an authoritative answer, never against a deferred one
   * (nucleus#1139 review).
   */
  catalog(options?: HostCatalogOptions): Promise<HostCatalog>;
  /**
   * This host's translation table from Nucleus's profile vocabulary to its own
   * spellings (`shared/profile-vocabulary.ts`, Tom 2026-11-12). Routing
   * translates each canonical profile with it; the catalog stays in the host's
   * own spelling.
   */
  readonly vocabulary?: HostVocabulary;
  /** The host's own profile list, read once into Nucleus's store (Spec 052). Optional: a host without one has no method. */
  hostProfiles?(): Promise<NucleusProfile[]>;
  /** Transitional: the host's profile reads until the profile-store transition completes. */
  profiles(): Promise<Profile[]>;
  /** Synchronous reporting and recovery support; keep current getters until a change preserves their timing. */
  capabilities(): HostCapabilities;

  /** The workspaces the host holds for a task, matched by the task's identity. */
  findWorkspaces(task: Task): Promise<Workspace[]>;
  workspaceAvailable(id: WorkspaceId): Promise<boolean>;
  /** Optional host-specific registration ID syntax; core treats IDs as opaque strings. */
  workspaceIdAccepted?(id: unknown): boolean;
  /**
   * One registration's handle. The caller awaits `refresh()` itself and then reads
   * `current()` and `directory`, so the refresh is the first await and no turn is
   * added ahead of it. Null or absent `current()` means the host no longer lists it.
   */
  workspaceRef(id: WorkspaceId): HostWorkspaceRef;
  /** Every registration of one exact folder; an incomplete walk is `ok: false`, never an empty list. */
  workspaceCatalog(directory: string): Promise<HostWorkspaceCatalog>;
  /** The host project rooted at a repository. A failed or absent lookup is `{}`: the folder registers without a project, as today. */
  repositoryProject(projectRoot: string): Promise<HostProjectRef>;
  createWorkspace(spec: HostWorkspaceSpec): Promise<Workspace>;
  /** `uncertain` says a previous title write may have landed; the host reads it, never assumes it. */
  setWorkspaceTitle(id: WorkspaceId, title: string, requestId: RequestId, uncertain: boolean): Promise<void>;
  /** Whether the host no longer lists the registration. An absent record is the only positive answer. */
  workspaceArchived(id: WorkspaceId): Promise<boolean>;
  /** The workspace's terminal sessions; an unreadable inventory is `ok: false` with the refusal text the caller reports. */
  workspaceTerminals(id: WorkspaceId): Promise<HostTerminalInventory>;
  /** Every thread, archived included, in the listed workspaces, walked to its positive end; an incomplete walk is `ok: false`. */
  workspaceThreads(workspaceIds: readonly WorkspaceId[]): Promise<HostThreadInventory>;
  /** Every live thread the host lists, walked to its end; an incomplete walk rejects, never reads as an empty list. */
  activeThreads(): Promise<HostThread[]>;

  createAgent(spec: HostAgentSpec): Promise<AgentRef>;
  findAgents(labels: Record<string, string>): Promise<AgentRef[]>;
  originAgent(id: AgentId): Promise<OriginAgent | null>;
  /** One agent's native state; an unreadable agent is a refused read, never an idle one. */
  observe(id: AgentId): Promise<HostObservation>;
  /** `null` means the inventory could not be walked to its end; a missing identity is unknown, not inactive. */
  observationInventory(ids: readonly AgentId[]): Promise<ReadonlyMap<AgentId, HostObservation> | null>;
  listLiveAgents(): Promise<HostLiveAgent[]>;
  agentTimelinePage(id: AgentId, limit?: number): Promise<HostTimelinePage | null>;
  agentTimeline(id: AgentId, limit?: number): Promise<HostTimelineEntry[] | null>;
  stopAgentTurn(id: AgentId): Promise<void>;
  archiveAgent(id: AgentId): Promise<void>;
  /**
   * Permanently remove one thread (T3Code, nucleus#1155). Optional: a host that
   * cannot remove a thread archives it instead, so its closeout keeps the
   * archive behaviour it has today (Paseo).
   *
   * A host with this method keeps a task's support threads settled and visible
   * while the task is open and removes them at closeout, because nothing they
   * hold is the only copy: review text, verdicts, recovery reports and decisions
   * are already in Nucleus's records and on the pull request.
   *
   * An unknown outcome is never re-sent: the caller reads the thread back
   * (absent from a complete inventory, or `deletedAt`) before anything else.
   */
  deleteAgent?(id: AgentId): Promise<void>;
  /** Optional: a host without run-usage streams has no method, so usage stays unknown rather than zero. */
  subscribeRunUsage?(id: AgentId, handler: (event: RunUsageStreamEvent) => void): Promise<RunUsageStream>;

  /** A live retained-agent handle: reads and sends keep their original timing. */
  retainedAgentRef(id: AgentId): HostRetainedAgentRef;

  /** Exact text and a stable message ID; a successful send is not an authenticated answer. */
  sendMessage(id: AgentId, input: HostMessage): Promise<void>;
  /**
   * Queue a message behind the agent's current step. Unlike `sendWhenIdle` this
   * does not wait for idle, and unlike `interruptAndContinue` it does not
   * replace the live turn.
   */
  enqueueMessage(id: AgentId, input: HostMessage): Promise<void>;
  /**
   * A tell or relayed answer: steers into the live turn when the agent is
   * mid-turn, else sends as `sendMessage` does. Hosts without steering deliver
   * as `sendMessage`.
   */
  steerOrNotify(id: AgentId, input: HostMessage): Promise<void>;
  /**
   * A send guarded by Queue fences. The host checks the agent and workspace it
   * refreshes against `expectedWorkspaceId`, awaits `guard.allowed` where the
   * code awaits it, and calls `guard.stillAllowed` and `guard.beforeSend`
   * synchronously immediately before the native send. A proven refusal is
   * `{sent: false}`; an unknown delivery throws.
   */
  sendGuarded(id: AgentId, input: HostGuardedMessage, guard: HostSendGuard): Promise<HostGuardedSendResult>;
  /** Sends only when the agent is idle; the reply is text, never an answer authority. */
  sendWhenIdle(id: AgentId, input: HostAsk): Promise<string | null>;
  interruptAndContinue(id: AgentId, messageId: RequestId, text: string): Promise<void>;

  pendingQuestions(id: AgentId): Promise<NativeQuestion[]>;
  answeredQuestions(id: AgentId): Promise<AnsweredQuestion[]>;
  answerNativeQuestion(agent: AgentId, workspace: WorkspaceId, request: RequestId, answers: Record<string, string>): Promise<void>;
  /** Optional native permission response; an absent method grants no permission capability. */
  answerNativePermission?(agent: AgentId, workspace: WorkspaceId, request: RequestId, decision: HostPermissionDecision, intentId: RequestId): Promise<void>;
  /** Dismiss one pending native question; never used for tool or bash permissions. */
  dismissNativeQuestion(agent: AgentId, workspace: WorkspaceId, request: RequestId): Promise<void>;
  /** Raises a native question and returns its request ID; the caller owns the durable send intent. */
  raiseDecision(agent: AgentId, workspace: WorkspaceId, input: NativeDecisionInput): Promise<string>;
  answerDecision(agent: AgentId, workspace: WorkspaceId, input: NativeDecisionAnswer): Promise<void>;
}

export interface HostCatalogOptions {
  /** The working directory whose project configuration the host applies. */
  cwd?: string;
}

/** Plain strings in this step; step 4 qualifies them with the host. */
export type AgentId = string;
export type WorkspaceId = string;
export type RequestId = string;

/** Native approval choices, carried without inferring a host or a permission policy. */
export const hostPermissionDecisionSchema = z.enum(['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel']);
export type HostPermissionDecision = z.infer<typeof hostPermissionDecisionSchema>;

/** What a host reports it can do; `false` means not reported, which keeps the current fallback. */
export interface HostCapabilities {
  reportingViaMcp: boolean;
  supportsCoordinatorRecovery: boolean;
  nativeDecisions?: boolean;
  uiContributions?: boolean;
  lifecycleDispatch?: boolean;
  perThreadEnvironment?: boolean;
  /** One workspace archive retires the registration every task in the repository shares (T3Code projects). */
  repositorySharedWorkspaces?: boolean;
}

/** A workspace the host holds: its identity and the folder it lives in. */
export interface Workspace {
  id: WorkspaceId;
  directory: string;
}

/** Where a host's native workspace sits on disk: a Paseo-owned worktree or a main checkout. */
export interface HostPlacement {
  kind: string;
  isPaseoOwnedWorktree: boolean;
  mainRepoRoot: string | null;
}

/**
 * The registration handle a host returns: its refresh, the record that refresh
 * read, and the native archive. The archive hands back the daemon's own result;
 * core decides what it proves, and an error or a rejection stays unknown until
 * an observation settles it.
 */
export interface HostWorkspaceRef {
  readonly directory?: string | null;
  refresh(): Promise<unknown>;
  current(): HostWorkspaceRecord | null | undefined;
  archive(requestId: RequestId): Promise<HostNativeArchive>;
}

/** The fields of a refreshed registration that core reads. */
export interface HostWorkspaceRecord {
  readonly projectRootPath: string;
  readonly workspaceDirectory?: string | null;
  readonly projectId?: string | null;
  readonly worktreeSlug?: string | null;
  /** The placement facts the external archive proof reads; each is absent when the host reports none. */
  readonly workspaceKind?: string | null;
  readonly project?: { readonly checkout?: HostCheckout | null } | null;
  readonly gitRuntime?: { readonly isPaseoOwnedWorktree?: boolean } | null;
}

/** The checkout a registration reports, as the placement rule reads it. */
export interface HostCheckout {
  cwd?: string;
  isPaseoOwnedWorktree?: boolean;
  mainRepoRoot?: string | null;
}

export interface HostWorkspaceCatalogEntry {
  workspaceId: WorkspaceId;
  directory: string;
  /** The placement the listing reported, or null with the refusal cause. */
  placement: HostPlacement | null;
  reason?: string;
}

/** Complete or refused: `ok: false` means the registrations could not be established, so nothing may be read from it. */
export type HostWorkspaceCatalog =
  | { ok: true; entries: HostWorkspaceCatalogEntry[] }
  | { ok: false; reason: string };

/** A host project, as the host reports it; `projectId` is absent when the lookup found none. */
export interface HostProjectRef {
  projectId?: string;
  /** Canonical repository root, when the core knows it; hosts may provision this project. */
  workspaceRoot?: string;
}

/** The registration of one folder as a host workspace. Core supplies the folder, identity and project; the host supplies the native call. */
export interface HostWorkspaceSpec {
  title: string;
  requestId: RequestId;
  directory: string;
  project: HostProjectRef;
}

export interface HostNativeArchive {
  archivedAt: string | null;
  error: string | null;
}

/** `uncertain` means the native outcome is unknown and only an observation may settle it. */
export type HostArchiveResult =
  | { status: "archived"; native: HostNativeArchive }
  | { status: "uncertain"; reason: string; native?: HostNativeArchive }
  | { status: "failed"; reason: string };

export type HostTerminalInventory =
  | { ok: true; terminals: { id: string; name: string }[] }
  | { ok: false; reason: string };

/**
 * One thread a host lists, with the facts core reads to decide ownership and
 * idleness. Core applies those decisions; the host only reports what it sees.
 */
export interface HostThread {
  /** The native identity; an empty value is an unreadable thread, which core refuses. */
  id: AgentId;
  workspaceId: WorkspaceId | null;
  labels: Record<string, string>;
  /** The native status, or empty when the host reports none. */
  status: string;
  archived: boolean;
  activeTurn: boolean;
  /** The kind of each pending permission request, null where the request names none. */
  pendingPermissionKinds: (string | null)[];
}

/** Every thread in the listed workspaces, or the refusal text the caller reports. */
export type HostThreadInventory =
  | { ok: true; threads: HostThread[] }
  | { ok: false; reason: string };

/**
 * What a host needs to create one agent. Core builds every identity, prompt,
 * label and environment value (`server/agent-creation.ts`); the host supplies
 * the native configuration and the create. `attempt` is read by the host at
 * each create, after its guard, so a build refusal keeps its order.
 */
export interface HostAgentSpec {
  workspaceId: WorkspaceId;
  profile: Profile;
  title: string;
  /** Queue identity used by hosts that expose a task title in their own thread list. */
  taskNumber?: number | null;
  /** The reporting binding file the host's MCP configuration names; null when no MCP reporting is attached. */
  mcpBindingPath: string | null;
  /** Core's facts for one create: `mcp` attaches the binding, `retry` is the socket-only attempt after an unsupported MCP. */
  attempt(mcp: boolean, retry: boolean): HostAgentAttempt;
  /** A launch fence checked before the native create; a failed check is a `ProvenPreSendRefusalError`. */
  guard?: Omit<HostSendGuard, "beforeSend">;
}

export interface HostAgentAttempt {
  requestId: RequestId;
  prompt: string;
  labels: Record<string, string>;
  environment: Record<string, string>;
}

export interface AgentRef {
  id: AgentId;
  workspaceId: WorkspaceId | null;
}

export interface OriginAgent {
  id: AgentId;
  workspaceId: WorkspaceId | null;
  title: string;
  archived: boolean;
  /** The host reports the thread permanently removed, when it distinguishes that from archived (T3Code). */
  deleted?: boolean;
}

export interface HostLiveAgent {
  id: AgentId;
  title: string;
  workspaceId: WorkspaceId | null;
  /** Wire labels when the host listing carries them; used to classify planner candidates. */
  labels?: Record<string, string>;
}

/**
 * What the host reports about one agent. Every field the queue reads is here,
 * including unknown states: an empty string or absent field means not reported,
 * never a positive result.
 */
export interface HostObservation {
  id: AgentId;
  workspaceId: WorkspaceId | null;
  status: string;
  active: boolean;
  permissions: boolean;
  error: string;
  /** The host retired this thread (archived); its terminal status rides `status`. */
  archived?: boolean;
  model?: string;
  provider?: string;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  labels?: Record<string, string>;
  /** One pending request, summarized for actionable lifecycle wait reasons. */
  pendingRequest?: { id: RequestId; kind: string; firstLine: string | null };
  /** Kinds of all pending requests, for distinguishing questions from turn permissions. */
  pendingPermissionKinds?: string[];
  /** ID of the current turn, when one is live. */
  activeTurnId?: string | null;
  /** Agent-record activity stamp; empty means unknown, never stale. */
  updatedAt?: string;
  /** Start of the current active turn, when one is live. */
  turnStartedAt?: string | null;
  /** When the agent last received a user message, if the host reports it. */
  lastUserMessageAt?: string | null;
  /** Absolute MCP ticket path this session was started with, when the host reports it. */
  mcpBindingPath?: string | null;
}

export interface HostTimelineEntry {
  timestamp: string;
  turnId?: string;
  item: { type: string; status?: string; name?: string; detail?: { type?: string; command?: string } & Record<string, unknown> } & Record<string, unknown>;
}

export interface HostTimelineCursor {
  epoch: string;
  seq: number;
}

/** A bounded tail and the host's positive coverage evidence; omission is unknown. */
export interface HostTimelinePage {
  entries: HostTimelineEntry[];
  hasOlder?: boolean;
  gap?: boolean;
  hasNewer?: boolean;
  staleCursor?: boolean;
  reset?: boolean;
  epoch?: string;
  startCursor?: HostTimelineCursor | null;
  endCursor?: HostTimelineCursor | null;
  projection?: "projected" | "canonical";
}

export interface HostProviderUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  contextWindowUsedTokens?: number;
}

export interface RunUsageStreamEvent {
  agentId: AgentId;
  event: { type: string; turnId?: string; usage?: HostProviderUsage };
}

/** Callable to unsubscribe; `subscriptionId` is null once the host has released it. */
export type RunUsageStream = (() => void) & { readonly ready: Promise<void>; readonly subscriptionId: string | null };

/** Native retained identity fields consumed by core, without an SDK type. */
export interface HostRetainedAgentRef {
  readonly workspaceId: string | null;
  readonly archivedAt: unknown;
  readonly status: string | null;
  readonly activeTurn: unknown;
  readonly pendingPermissions: readonly unknown[] | null;
  readonly runtimeInfo: { provider?: string | null; model?: string | null; modeId?: string | null; thinkingOptionId?: string | null } | null;
  refresh(): Promise<unknown>;
  current(): { labels?: Record<string, string> | null; provider?: string | null; model?: string | null } | null;
  send(text: string, options: { messageId: string }): Promise<void>;
}

export interface HostMessage {
  messageId: RequestId;
  text: string;
  sourceAgentId?: AgentId;
}

/**
 * The fences a guarded send checks. The host invokes each at the point the
 * code requires; a guard grants no authority to the host.
 */
export interface HostSendGuard {
  allowed(): Promise<boolean>;
  stillAllowed(): boolean;
  beforeSend?(): void;
}

export interface HostGuardedMessage extends HostMessage {
  /** The workspace the task recorded; a host refuses a send to an agent in another one. */
  expectedWorkspaceId: WorkspaceId;
}

/** `sent: false` is a proven refusal with nothing delivered. */
export type HostGuardedSendResult = { sent: true } | { sent: false; reason: string };

export interface HostAsk extends HostMessage {
  signal: AbortSignal;
  timeoutMs: number;
}

export interface NativeQuestion {
  requestId: RequestId;
  questions: { header: string; question: string; options: string[] }[];
}

export interface AnsweredQuestion {
  requestId: RequestId;
  question: string;
  answers: Record<string, string>;
}

/**
 * A Nucleus-owned decision request; no Paseo permission object crosses it.
 * `onRequested` reports the native question's permission ID once the thread presents it (Spec 058, task 540).
 */
export interface NativeDecisionInput {
  id: string;
  question: string;
  options: string[];
  signal: AbortSignal;
  onRequested?: (request: { requestId: RequestId; header: string }) => void;
}

export interface NativeDecisionAnswer {
  requestId: RequestId;
  header: string;
  answer: string;
}

export const hostThinkingOptionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    isDefault: z.boolean().optional(),
  })
  .strict();
export type HostThinkingOption = z.infer<typeof hostThinkingOptionSchema>;

export const hostModeSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })
  .strict();
export type HostMode = z.infer<typeof hostModeSchema>;

export const hostFeatureToggleSchema = z
  .object({
    type: z.literal("toggle"),
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    value: z.boolean(),
  })
  .strict();
export const hostFeatureSelectSchema = z
  .object({
    type: z.literal("select"),
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    value: z.string().nullable(),
    options: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          description: z.string().optional(),
          isDefault: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export const hostFeatureSchema = z.discriminatedUnion("type", [
  hostFeatureToggleSchema,
  hostFeatureSelectSchema,
]);
export type HostFeature = z.infer<typeof hostFeatureSchema>;

export const hostModelSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    aliases: z.array(z.string()).default([]),
    thinkingOptions: z.array(hostThinkingOptionSchema).default([]),
    defaultThinkingOptionId: z.string().nullable().default(null),
    modes: z.array(hostModeSchema).default([]),
    features: z.array(hostFeatureSchema).default([]),
  })
  .strict();
export type HostModel = z.infer<typeof hostModelSchema>;

export const hostProviderSchema = z
  .object({
    /** The host's own provider key, before the Nucleus provider map normalises it. */
    key: z.string(),
    label: z.string().default(""),
    available: z.boolean(),
    /** Why the host reports the provider as unusable; empty when available. */
    problem: z.string().default(""),
    models: z.array(hostModelSchema).default([]),
  })
  .strict();
export type HostProvider = z.infer<typeof hostProviderSchema>;

export const hostCatalogSchema = z
  .object({ providers: z.array(hostProviderSchema),
    /**
     * This read carries no feature answer: the host resolves feature values per
     * project context and the caller supplied none. Availability must not judge
     * feature values against it — unknown, never negative (nucleus#1139 review).
     */
    featuresDeferred: z.boolean().optional() })
  .strict();
export type HostCatalog = z.infer<typeof hostCatalogSchema>;

/**
 * `host.catalog`'s answer: the host catalog Nucleus last stored for this host and
 * directory, with the time it was read from the host (nucleus#970).
 */
export const storedHostCatalogSchema = hostCatalogSchema
  .extend({ readAt: z.string() })
  .strict();
export type StoredHostCatalog = z.infer<typeof storedHostCatalogSchema>;
