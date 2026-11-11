import type { OrphanWorkspace, WorkspaceCreationState, HostProcessFact, BuildOutputCleanupHooks, WorkspaceDiscard, WorktreeValidationScan, RunUsageSource, TimelineEntry, TimelinePage, VerifiedPr } from './types';
import type { Run, Profile, ReviewEntryInput, StashEntry, Task } from "../../shared/contracts";
import type { HostCatalog, HostCatalogOptions, NativeDecisionInput, HostPermissionDecision } from "../../shared/host";
import type { NucleusProfile } from "../../shared/profiles";

export interface OriginAgent {id:string;workspaceId:string|null;title:string;archived:boolean;}
/**
 * Spec 017: the catalog placement a preserved external workspace's archive
 * proof reads before it asks Paseo to archive the sidebar entry.
 */
export interface ExternalWorkspacePlacement { kind: string; isPaseoOwnedWorktree: boolean; mainRepoRoot: string | null; }
/**
 * Spec 017 worktree amendment (Tom, 2026-10-25): the exact clean, published
 * source a worktree placement must prove before Paseo's archive may remove its
 * folder. Queue never resets, cleans, stashes, rewrites or pushes to obtain it.
 */
export interface ExternalWorktreeSource {
  head: string; branch: string; directory: string; commonDir: string; remote: string;
  /** The advertised canonical-remote branch that contains `head`, or `merge:<branch>`. */
  publication: string;
  /** The disposable ignored runtime roots the existing cleanup policy already owns. */
  ignored: string[];
}
/** One catalog registration listed at exactly the preserved folder. */
export interface ExternalWorkspaceCatalogEntry {
  workspaceId: string; directory: string;
  /** The placement the listing reported, or null with the refusal cause. */
  placement: ExternalWorkspacePlacement | null; reason?: string;
}
/**
 * Every catalog registration for one exact folder. `ok: false` means the
 * inventory could not be established completely; nothing may be called.
 */
export type ExternalWorkspaceCatalog =
  | { ok: true; entries: ExternalWorkspaceCatalogEntry[] }
  | { ok: false; reason: string };
/** The recorded identity of the task that owns the preserved folder. */
export interface ExternalWorkspaceSourceExpectation {
  branch: string; baseBranch: string; repository: string | null; repoPath: string;
}
export interface ExternalWorkspaceArchiveInput {
  taskId: string;
  workspaceId: string;
  directory: string;
  /** Every thread identity this task may own in that workspace. */
  ownedAgentIds: ReadonlySet<string>;
  /** Stable native idempotency identity for this one catalog operation. */
  requestId: string;
  /** The task's recorded workspace identity the source proof binds. */
  expected: ExternalWorkspaceSourceExpectation;
  /** Every other catalog registration for this exact folder, which shares its backing. */
  samePathWorkspaceIds: readonly string[];
  /** The durable removal of this shared folder by an earlier authorized archive. */
  folderRemoval: { workspaceId: string; head: string } | null;
  /**
   * Called once, immediately before the native request. It re-reads the task
   * and persists the durable intent, including the exact source proof this
   * entry's removal permission rests on; `false` declines with nothing sent.
   */
  allowed(observed: ExternalWorkspacePlacement, participants: string[], source: ExternalWorktreeSource | null): boolean;
}
/**
 * The answer of one catalog-only archive attempt. `refused`, `declined` and
 * `failed` sent no request that Queue accepts; `uncertain` means the native
 * outcome is unknown and only an observation may settle it.
 */
export type ExternalWorkspaceArchiveOutcome =
  | { status: 'archived'; observed: ExternalWorkspacePlacement; participants: string[]; native: { archivedAt: string | null; error: string | null }; folderPresent: boolean }
  | { status: 'declined'; reason: string }
  | { status: 'refused'; reason: string; observed?: ExternalWorkspacePlacement; participants?: string[] }
  | { status: 'uncertain'; reason: string; observed?: ExternalWorkspacePlacement; participants?: string[]; native?: { archivedAt: string | null; error: string | null } }
  | { status: 'failed'; reason: string; observed?: ExternalWorkspacePlacement; participants?: string[]; native?: { archivedAt: string | null; error: string | null } };
export interface AgentObservation { id: string; workspaceId: string | null; status: string; active: boolean; permissions: boolean; error: string; model?: string; provider?: string; modeId?: string | null; thinkingOptionId?: string | null; labels?: Record<string, string>;
  /** Absolute MCP ticket path this session was started with, when the host reports it. */
  mcpBindingPath?: string | null;
  /** One pending request, summarized for actionable lifecycle wait reasons. */
  pendingRequest?: { id: string; kind: string; firstLine: string | null };
  /** Kinds of all pending requests, for distinguishing questions from turn permissions. */
  pendingPermissionKinds?: string[];
  /** ID of the current turn, when one is live. */
  activeTurnId?: string | null;
  /** Agent-record activity stamp, advancing with timeline activity; empty means unknown, never stale. */
  updatedAt?: string;
  /** Start of the current active turn, when one is live. */
  turnStartedAt?: string | null;
  /** When the agent last received a user message, if Paseo reports it. */
  lastUserMessageAt?: string | null; }
export interface Adapter extends RunUsageSource {
  /** Explicit host capabilities when the native adapter has more than the legacy flags. */
  capabilities?(): import('../../shared/host').HostCapabilities;
  /** Host-specific workspace registration identity validation. */
  workspaceIdAccepted?(id: unknown): boolean;
  originAgent?(id:string):Promise<OriginAgent|null>;
  supportsCoordinatorRecovery?: boolean;
  reportingFallback?(run:Run):string;
  reportingViaMcp?: boolean;
  /** Engine hook for per-step creation timings and the visible wait reason. */
  workspaceCreationProgress?: (taskId: string, step: string, status: "started" | "finished" | "skipped", elapsedMs?: number, outcome?: "ok" | "failed") => void;
  purgeReportingFiles?(taskId:string,runIds:string[]):void;
  runTemporaryDirectory?(runId: string, task?: Task): string;
  workspaceAvailable?(id:string):Promise<boolean>;
  profiles?(): Promise<Profile[]>;
  /** The host catalog: the first method of the `Host` interface in `shared/host.ts`. */
  catalog?(options?: HostCatalogOptions): Promise<HostCatalog>;
  /**
   * The host's own profile list, read once into Nucleus's store (Spec 052). A
   * host with its own profile system answers with it; a host without one has no
   * method, so nothing is imported from it.
   */
  hostProfiles?(): Promise<NucleusProfile[]>;
  validate(task: Task): Promise<string>;
  preflightWorkspaceStorage?(task: Task): Promise<void>;
  createReviewEntryWorkspace?(spec: {requestId:string;title:string;repoPath:string;prNumber:number}):Promise<{id:string}>;
  createWorkspace(task: Task, options?: { freshlyPopulated?: boolean }): Promise<{ id: string; directory: string }>;
  /** Queue-owned gitBulk populate; admission must not wrap this. */
  populateTaskWorktree?(task: Task): Promise<{ directory: string; populated: boolean; budgetMs: number; elapsedMs: number }>;
  inspectWorkspaceCreation?(task: Task, options?: { skipProcessScan?: boolean; skipRemoteCheck?: boolean; progress?: boolean }): Promise<WorkspaceCreationState>;
  /**
   * Re-create a lost task workspace. The default target is the accepted PR head;
   * `target: 'branch'` reads the queue branch on origin, which a worker
   * continuation resumes from.
   */
  recoverTaskWorkspace?(task: Task, options?: { target?: 'pr_head' | 'branch' }): Promise<{ id: string; directory: string }>;
  setTaskWorkspaceTitle?(task:Task,title:string,requestId:string,uncertain:boolean):Promise<void>;
  findWorkspaces(task: Task): Promise<{ id: string; directory: string }[]>;
  /** Read-only: a Queue-owned unpublished populate leftover or a locked-initializing Paseo leftover with a base-identical unpublished branch. */
  removeOrphanWorkspace?(task: Task, orphan: OrphanWorkspace): Promise<void>;
  /** One-minute load average and logical CPU count; creation defers while load exceeds CPUs. */
  hostLoad?(): { load: number; cpus: number };
  /**
   * Host-wide scan for worktree validation (QA or tests still running in a task
   * worktree). Host observations come through the adapter, as `hostLoad` does:
   * the real adapter reads the live process table, and an adapter without this
   * method observes none, so synthetic engines never depend on how loaded the
   * test host is (milestone 6257017a).
   */
  worktreeValidation?(directory: string, extraArgv: string[][]): WorktreeValidationScan;
  /** Complete host process table for proofs rooted in a Queue-launched provider. */
  hostProcessListing?(): Promise<HostProcessFact[] | null>;
  verifyResume?(task: Task): Promise<void | string>;
  verifyCheckpoint?(task: Task, head: string): Promise<void>;
  verifyReplacementSource?(task: Task, head: string): Promise<void>;
  /** Fresh, uncached check that the retained worker's registered worktree still belongs to this task. */
  preflightWorkerContinuation?(task: Task): Promise<{ available: true } | { available: false; reason: string }>;
  continueWorker?(task: Task, intentId: string, text: string, issueBinding?: () => { runId: string; token: string }): Promise<void>;
  /** Continue one retained resolution run under its existing reporting identity. */
  continueRun?(run: Run, messageId: string, text: string): Promise<void>;
  /** Deliver one idempotent task lifecycle notice to a planning thread. */
  notify?(agentId: string, messageId: string, text: string, sourceAgentId?: string): Promise<void>;
  /** One explicitly authorized reviewer delivery after fresh idle, identity and Queue-fence proofs. */
  continueReviewer?(task: Task, run: Run, messageId: string, text: string, allowed: () => Promise<boolean>, stillAllowed: () => boolean, beforeSend?: () => void): Promise<{ sent: true } | { sent: false; reason: string }>;
  verifyCleanQueueWorktree?(task: Task): Promise<void>;
  /** Exact clean planning-head proof for owner acceptance of a report-only task. */
  /** Read the shared stash list; recorded when a worker or revision run is created. */
  readStash?(directory: string): Promise<StashEntry[]>;
  verifyWorkspace(task: Task, directory: string): Promise<string>;
  createAgent(task: Task, token: string, prompt: string, legacyPrompt?: string): Promise<{ id: string; workspaceId: string | null }>;
  findAgents(task: Task): Promise<{ id: string; workspaceId: string | null }[]>;
  observe(agentId: string): Promise<AgentObservation>;
  /**
   * Audit A6: one complete labelled inventory of Queue-created threads, answering
   * the named identities wherever a list entry carries every field `observe`
   * reads. `null` means the list could not be walked to its positive end, and an
   * identity the map does not answer needs `observe`: a missing, partial or
   * unreadable inventory never reads as inactivity.
   */
  observationInventory?(agentIds: readonly string[]): Promise<ReadonlyMap<string, AgentObservation> | null>;
  /** Spec 042: live, unarchived threads for the owner picker and seed resolution; a bounded page walk. Labels classify planner vs task threads. */
  listLiveAgents?(): Promise<Array<{ id: string; title: string; workspaceId: string | null; labels?: Record<string, string> }>>;
  /** Interrupt the active turn and deliver one continuation; used by disposition drain. */
  interruptAndContinue?(agentId: string, messageId: string, text: string): Promise<void>;
  /**
   * Queue a message behind the agent's current step. Unlike `notify` this does
   * not wait for idle, and unlike `interruptAndContinue` it does not replace
   * the live turn.
   */
  enqueueMessage?(agentId: string, messageId: string, text: string, sourceAgentId?: string): Promise<void>;
  /** Stop the assigned agent's current turn without delivering a follow-up message. */
  stopAgentTurn?(agentId: string): Promise<void>;
  /** One newest page of the agent's timeline, or null when the read fails; a failed read is never evidence. */
  agentTimeline?(agentId: string, limit?: number): Promise<TimelineEntry[] | null>;
  /** One newest timeline page with its completeness fact, or null when the read fails. */
  agentTimelinePage?(agentId: string, limit?: number): Promise<TimelinePage | null>;
  /** Complete host-process proof for a finished-turn shell tool. Null means no run process or workspace process remains. */
  noLiveWorkspaceProcesses?(workspaceId: string, runIds: readonly string[]): Promise<string | null>;
  /**
   * Spec 058 (task 542): recently answered native questions on one agent, oldest
   * first. The existing permission-resolution surface owns the read: a failed
   * read is empty, never evidence, and a lost observation is recorded as
   * unknown by the caller and never resent.
   */
  answeredQuestions?(agentId: string): Promise<Array<{ requestId: string; question: string; answers: Record<string, string> }>>;
  pendingQuestions?(agentId: string): Promise<Array<{ requestId: string; questions: Array<{ header: string; question: string; options: string[] }> }>>;
  answerNativeQuestion?(agentId: string, workspaceId: string, requestId: string, answers: Record<string, string>): Promise<void>;
  /** One explicitly addressed native approval, retaining its stable durable send identity. */
  answerNativePermission?(agentId: string, workspaceId: string, requestId: string, decision: HostPermissionDecision, intentId: string): Promise<void>;
  /** Dismiss one pending native question through the host; never used for tool or bash permissions. */
  dismissNativeQuestion?(agentId: string, workspaceId: string, requestId: string): Promise<void>;
  archiveAgent(agentId: string): Promise<void>;
  /**
   * Spec 017: archive one merged review-entry task's Paseo sidebar entry while
   * preserving its external folder. The implementation must refuse before the
   * native call unless the source-traced placement proof shows Paseo can only
   * change its catalog, and must never claim the folder was archived.
   */
  archiveExternalWorkspace?(input: ExternalWorkspaceArchiveInput): Promise<ExternalWorkspaceArchiveOutcome>;
  /**
   * Spec 017 worktree amendment: every catalog registration listed at exactly
   * this preserved folder, so one entry's archive never assumes it is the only
   * one whose backing it might remove. A complete walk or an explicit refusal.
   */
  externalWorkspaceCatalog?(directory: string): Promise<ExternalWorkspaceCatalog>;
  archiveTaskWorkspace?(task:Task,id:string,directory:string,expectedHead:string,allowed:()=>boolean,uncertain:boolean,requirePublished?:boolean,attachedAgentIds?:ReadonlySet<string>,requireDirectory?:boolean,allowIdleForeignThreads?:boolean,buildOutputCleanup?:BuildOutputCleanupHooks,reviewRun?:Run,discard?:WorkspaceDiscard|null,primaryArchived?:()=>boolean):Promise<boolean|string[]>;
  taskWorkspaceArchived?(id:string):Promise<boolean>;
  verifyPr(task: Task, number: number): Promise<VerifiedPr>;
  verifyPrIdentity?(task: Task, number: number, options?: { allowDraft?: boolean }): Promise<VerifiedPr>;
  verifyInspectedRevisionHead?(task: Task, number: number, expectedHead: string): Promise<void>;
  verifyContinuedProgress?(task: Task, number: number, expectedHead: string, ancestors: readonly string[], options?: {requireClean?: boolean}): Promise<void>;
  findOpenBranchPr?(task: Task): Promise<{ number: number; url: string; head: string }[]>;
  /** Include drafts and PRs targeting any base; report-only completion refuses all open PRs for this branch. */
  findAnyOpenBranchPr?(task: Task): Promise<{ number: number; url: string }[]>;
  /**
   * Spec 058: ask a decision through the task's own native Paseo question. The
   * caller owns the durable send intent; an interrupted observation resolves as
   * unknown and is never permission to resend.
   */
  raiseTaskDecision?(task: Task, input: NativeDecisionInput): Promise<string>;
  /**
   * Send one question only when idle. Chat is never an answer; resolution waits for the command receipt.
   */
  askPlanner?(planner: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }): Promise<string | null>;
  /**
   * Spec 058 slice 17 (task 584): ask the task's retained reviewer one consult turn — a second
   * opinion on a blocked report, never a review round. Answers arrive through the command receipt.
   */
  createConsultReviewer?(task: Task, input: { profile: Profile; id: string }): Promise<{ id: string; workspaceId: string | null }>;
  askReviewer?(reviewer: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }): Promise<string | null>;
  /**
   * Spec 058 (task 540): start one short-lived decider agent in the task's workspace with the
   * given profile. Return its idle identity before delivery so the caller can register answer authority.
   */
  runDecider?(task: Task, input: { profile: Profile; signal: AbortSignal; timeoutMs: number; decisionId: string }): Promise<{ agentId: string; text: string | null }>;
  /** Spec 058 (task 540): answer the task thread's own native question through its permission id. */
  answerTaskDecision?(task: Task, input: { requestId: string; header: string; answer: string }): Promise<void>;
  verifyCancelledWorkspacePr?(task: Task): Promise<void>;
  inspectReviewEntry?(input:ReviewEntryInput,taskId?:string,originProof?:{origin:OriginAgent;state:AgentObservation}):Promise<{directory:string;originWorkspaceId:string;busyReason:string;busyTransient?:boolean}>;
  scratchNamespaceFor?(task: Task): string;
}
