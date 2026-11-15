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

import type { HostProcessFact, TimelineEntry, TimelinePage, WorktreeValidationScan } from '../types';

/** What the host reports about its threads and the processes behind them: one thread observation, an inventory of them, live agents, timeline pages, the host process table and a worktree validation scan. */
export interface HostObservation {
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
  /** One newest page of the agent's timeline, or null when the read fails; a failed read is never evidence. */
  agentTimeline?(agentId: string, limit?: number): Promise<TimelineEntry[] | null>;
  /** One newest timeline page with its completeness fact, or null when the read fails. */
  agentTimelinePage?(agentId: string, limit?: number): Promise<TimelinePage | null>;
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
  /** Complete host-process proof for a finished-turn shell tool. Null means no run process or workspace process remains. */
  noLiveWorkspaceProcesses?(workspaceId: string, runIds: readonly string[]): Promise<string | null>;
}
