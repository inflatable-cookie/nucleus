import type {
  BuildOutputObservation,
  Task,
  TaskNext,
  TaskNextReviewOutcome,
  TaskNextVerb,
  TaskRegistrationBinding,
} from "../../shared/contracts";
import type { HostWorkspacePlacement } from "../../shared/host";
import type { AgentObservation } from "./index";

/**
 * Spec 058 slice 4: any thread registers itself as a responsible task.
 *
 * The caller is the authenticated calling thread, never a typed name: the
 * input carries no agent, workspace or branch field, and the worktree binding
 * is derived from a live Paseo observation of the caller. Registration opts
 * into the responsible lifecycle only; no planner, owner or coordinator role
 * is created. Afterwards the task follows the same lifecycle as a planned
 * task: the worker reports on its bound run, one retained reviewer reviews,
 * and merge, closeout, usage and operator questions run as usual.
 */
export interface RegistrationAdapter {
  hostId: string;
  /**
   * Create the authenticated callback ticket for the existing registering
   * thread and answer its reporting binding: this thread was not launched by
   * Nucleus, so the response is where it first learns its run and ticket.
   */
  prepareRegistration?(
    task: Task,
    token: string,
  ): TaskRegistrationBinding | void;
  observe(agentId: string): Promise<AgentObservation>;
  /**
   * Prove the calling thread is live and resolve the worktree it is already
   * in: its workspace id, directory and the integration checkout path that
   * workspace belongs to. Throws with the reason when the caller cannot be
   * identified reliably.
   */
  inspectRegistration(callerAgentId: string): Promise<{
    workspaceId: string;
    directory: string;
    repoPath: string;
    observation: AgentObservation;
  }>;
}

export interface OrphanWorkspace {
  directory: string | null;
  branch: string;
  head: string;
  lockReason: string;
  /** Host-neutral provenance of the leftover checkout or branch. */
  provenance?: "queue_owned" | "host_initializing" | "branch_only";
  /** Human-readable host label when `provenance === "host_initializing"`. */
  hostLabel?: string;
}

/** Host-supplied rule for recognizing an interrupted host-owned worktree initialization lock. */
export interface HostInitLockRule {
  readonly hostLabel: string;
  readonly expectedReason?: string;
  matches(lockReason: string): boolean;
}

export type WorkspaceCreationState =
  | { kind: "found_done"; directory: string }
  | { kind: "proof_head_mismatch"; directory: string; head: string }
  | { kind: "absent" }
  | { kind: "still_running"; evidence: string }
  | { kind: "unknown"; evidence: string }
  | { kind: "partial"; orphan: OrphanWorkspace; evidence: string }
  | { kind: "conflicting"; evidence: string };

export type HostProcessTable = HostProcessFact[] & {
  /** False if the scan could not establish cwd coverage. */
  cwdComplete?: boolean;
};

export interface HostProcessFact {
  pid: number;
  /** Process parent, when available from the host process table. */
  ppid?: number | null;
  /**
   * Process state from the same read that produced this fact (the `ps` state
   * column, or the `/proc` stat letter). `Z` marks a zombie, which holds no
   * tools and is never judged. Null when the read could not report it.
   */
  state?: string | null;
  pgid: number;
  uid: number;
  startIdentity: string;
  command: string;
  cwd: string | null;
  /** BB session identity read from that process's environment; null means unreadable. */
  bbThreadId?: string | null;
  /** The executable resolves to the installed Cua Driver, not a workspace copy. */
  trustedCuaExecutable?: boolean;
  /**
   * The host adapter that read this table marks a process as its own runtime: the
   * host's daemon, the processes under it and its process group. Shared cleanup
   * never selects a marked process or signals its group; it reports the skip.
   * Core never decides this from a command name.
   */
  protectedRuntime?: boolean;
}

/**
 * What one cleanup observed, with the sentence it reports. The record keeps both:
 * `observations` is the fact a reader decides on, `detail` is the text a human reads.
 */
export type BuildOutputCleanupResult = {
  detail: string;
  removed: boolean;
  safe: boolean;
  /** What this cleanup observed; the record's state alone never says it. */
  observations: BuildOutputObservation[];
};

export interface BuildOutputCleanupHooks {
  begin(): "run" | "complete" | false;
  observed(result: BuildOutputCleanupResult): void;
  uncertain(reason: string): void;
}

/**
 * The owner's durable discard decision, bound to one task workspace and its
 * directory. The archive reads it on every pass, so a lost reply or a replay
 * keeps the original authorization; nothing else ever reuses it.
 */
export interface WorkspaceDiscard {
  workspaceId: string;
  directory: string;
  caller: string;
  authority: "project_owner" | "operator" | "relayed_note";
  note: string | null;
  reason: string;
  at: string;
}

export type WorktreeValidationScan =
  | { state: "alive"; command: string; pid: number }
  | { state: "absent" }
  | { state: "unverified"; reason: string };

/**
 * What a host scan for one identity token found: the pid carrying it, proof
 * that no live process carries it, or a scan this host could not complete.
 */
export type ProcessSearch =
  | { state: "found"; pid: number }
  | { state: "absent" }
  | { state: "unknown" };

/** Token counts a provider reports on a turn; any field may be absent. */
export interface ProviderUsageReport {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  contextWindowUsedTokens?: number;
}

/** One item from an agent's timeline stream: a turn event, or a marker that the stream restarted or was replaced. */
export interface RunUsageStreamEvent {
  agentId: string;
  event: { type: string; turnId?: string; usage?: ProviderUsageReport };
}

/** A live stream handle: callable to unsubscribe, `subscriptionId` is null once the daemon released it. */
export type RunUsageStream = (() => void) & {
  readonly ready: Promise<void>;
  readonly subscriptionId: string | null;
};

/** The one Paseo call the tracker needs; absent on an adapter with no stream, which leaves runs partial. */
export interface RunUsageSource {
  subscribeRunUsage?(
    agentId: string,
    handler: (event: RunUsageStreamEvent) => void,
  ): Promise<RunUsageStream>;
}

export type LiveRunLabelColor = "amber" | "violet";

export interface LiveRunLabel {
  name: string;
  color: LiveRunLabelColor;
}

/** The daemon-side placement of one workspace, as the operator's sidebar sees it. */
export interface LiveRunPresenceWorkspace {
  id: string;
  directory: string | null;
  labels: readonly string[];
  /** Paseo's inventory marks workspaces being archived with a timestamp. */
  archivingAt?: string | null;
}

/** The daemon surface the projection uses, and nothing else. */
export interface RunPresenceDaemon {
  workspaces(): Promise<LiveRunPresenceWorkspace[]>;
  listTerminals(
    workspaceId: string,
  ): Promise<Array<{ id: string; name: string }>>;
  createTerminal(input: RunPresenceTerminal): Promise<{ id: string }>;
  /** Create or recolour the label definition, so an assignment always has one. */
  ensureWorkspaceLabel(label: LiveRunLabel): Promise<void>;
  assignWorkspaceLabel(input: {
    workspaceId: string;
    label: LiveRunLabel;
    assigned: boolean;
    requestId: string;
  }): Promise<void>;
}

export interface RunPresenceTerminal {
  workspaceId: string;
  cwd: string;
  name: string;
  command: string;
  args: string[];
  requestId: string;
}

/** An observation for the replacement reader, never a control or a proof. */
export type OwnerReviewContext = {
  state: "compatible" | "historical" | "unknown";
  detail: string;
  source?: {
    operationId: string;
    caller: string;
    runId: string;
    head: string;
    briefVersion: number;
    briefDigest: string;
    text: string;
  };
};

export interface RecoveryDispatchSnapshot {
  why: { cause: string | null; target: string; recoveryRunId: string };
  phase: string;
  reason: string | null;
  stop: {
    kind: string;
    reason: string;
    owner: string | null;
    evidence: string | null;
    detail: string | null;
  } | null;
  /**
   * The participant actually holding the task: the recorded current run, the
   * task's own worker binding, or a run that has neither reported nor been
   * released. A finished or released run is history and is never presented as
   * an active participant (Queue #477).
   */
  activeRun:
    | (NonNullable<TaskNext["activeRun"]> & { workspaceId: string | null })
    | null;
  holds: TaskNext["holds"];
  /**
   * The current review outcome, its exact source and the decision still
   * outstanding, from the same derivation `next` reports. It is observation:
   * the accepted verdict, a report that was never applied, the live reader and
   * the author revision allowance stay distinct.
   */
  outcome: TaskNextReviewOutcome;
  /** The retained reviewer's newest checkpoint: its coverage is what a continuation keeps, separately from any verdict. */
  checkpoint: {
    runId: string;
    workspaceId: string | null;
    ordinal: number;
    head: string;
    covered: string[];
    remaining: string[];
    notes: string | null;
  } | null;
  /**
   * The author's latest recorded result: recorded fact, never a verdict, and
   * named apart from the accepted review. A result recorded after the newest
   * applied verdict at the current head is what the outstanding review covers.
   */
  authorResult: TaskNextReviewOutcome["authorResult"];
  /**
   * Spec 050: the worker retirement count, the ordinary ceiling and the one
   * extra-replacement authorization, from the same `next` derivation — so a
   * coordinator reads the real count and state, and still cannot grant one.
   */
  replacement?: TaskNext["replacement"];
  verbs: Array<
    Pick<TaskNextVerb, "verb" | "available"> & {
      args?: Record<string, unknown>;
      fill?: string[];
      refusal?: string;
      note?: string;
    }
  >;
  explicitCommands?: Array<{
    action: string;
    args: Record<string, unknown>;
    fill?: string[];
    note?: string;
    /** The warning IDs the command will name (papercut ee6e634c). */
    warnings?: string[];
  }>;
}

/** Structural slice of a Paseo timeline entry; shell detail is normalized by Paseo across providers. */
export interface TimelineEntry {
  timestamp: string;
  turnId?: string;
  item: {
    type: string;
    status?: string;
    name?: string;
    detail?: { type?: string; command?: string } & Record<string, unknown>;
  } & Record<string, unknown>;
}

/** A bounded tail and the provider's positive coverage evidence; omission is unknown. */
export interface TimelineCursor {
  epoch: string;
  seq: number;
}

export interface TimelinePage {
  entries: TimelineEntry[];
  hasOlder?: boolean;
  gap?: boolean;
  hasNewer?: boolean;
  staleCursor?: boolean;
  reset?: boolean;
  epoch?: string;
  startCursor?: TimelineCursor | null;
  endCursor?: TimelineCursor | null;
  projection?: "projected" | "canonical" | "bounded";
  pendingBackgroundTasks?: string[];
}

/**
 * Queue's callback facts for one agent launch: the ticket and MCP binding files
 * its helper reads, the callback environment, the scratch placement and the
 * launch admission env. The owner builds one per call (`() => CreationOwner`),
 * so each read sees the adapter's current values.
 */
export interface CreationOwner {
  readonly socketPath: string;
  readonly helperPath: string;
  /** The host attaches MCP reporting, so a binding file is written before the create. */
  readonly reportingViaMcp: boolean;
  readonly admissionLaunchEnv: Record<string, string>;
  /**
   * When false the host cannot inject per-thread environment, so the launch
   * attempt carries an empty environment and the prompt names the helper and ticket.
   */
  readonly perThreadEnvironment?: boolean;
  /** Some hosts cannot inject TMPDIR but still require Nucleus to create the recorded run scratch before launch. */
  readonly prepareRunScratch?: boolean;
  scratchPlacement(task: Task): RunScratchPlacement;
}

/**
 * Where a launch's own temp directory lives, and how Queue proves that location
 * before and after creating it. Production uses `checkoutRunScratchPlacement`; a
 * private fixture passes its own mount, never a different policy.
 */
export interface RunScratchPlacement {
  /** The volume this placement proves before it creates or removes a leaf. */
  mount: string;
  root: string;
  create: (directory: string) => void;
  createAtRoot?: (root: string, directory: string) => void;
  remove: (directory: string) => boolean;
  withNamespace?: (namespace: string) => RunScratchPlacement;
}

/**
 * The worktree registration core asks for. Core decides the identity and the
 * source — the branch it must start from and the branch and slug it names — and
 * a host translates these facts into its own registration call.
 */
export interface HostWorktreeWorkspaceSpec {
  title: string;
  requestId: string;
  source: {
    kind: "worktree";
    cwd: string;
    action: "branch-off";
    baseBranch: string;
    branchName: string;
    worktreeSlug: string;
  };
}

/**
 * A verified PR. `repository` is the canonical repository the check queried;
 * `headRepository` is the repository the PR's head branch lives in (null when
 * that fork was deleted) and `crossRepository` GitHub's own cross-repository
 * flag where the lookup reports it. Only the PR-binding sites read them.
 */
export type VerifiedPr = {
  url: string;
  head: string;
  repository?: string;
  headRepository?: string | null;
  crossRepository?: boolean;
};

export type ReviewerSetting = { login: string };

/**
 * The pre-call source gate for a catalog-only archive (Spec 017), expressed in
 * host-neutral placement and provenance facts normalized at the host adapter
 * boundary. Missing, owned, worktree (unless opted in after source proof), or
 * inconsistent placement facts are refused before any archive call.
 */
export type ExternalWorkspaceCatalogView =
  | {
      workspaceDirectory?: string | null;
      placement?: HostWorkspacePlacement | null;
    }
  | null
  | undefined;
