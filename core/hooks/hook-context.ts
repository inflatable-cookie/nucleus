import type { executeHookProgram } from "../machine/process-exec";
import type { snapshotGit } from "../git/git-snapshot";
import type { HostRunScheduler } from "../host-runs/host-run-scheduler";
import { join } from "node:path";
import type { HookPin, HookRecord, HookEventName, InstructionArtifact, MergeCandidate } from "../../shared/hooks";

export interface HookEmissionResult { hold: boolean; attention: boolean; records: HookRecord[] }

export interface ProspectiveMergeRequest {
  prUrl?: string | null; prNumber?: number | null; head: string; review?: string | null; summary?: string;
}

/** One evaluation of the exact prospective merge result for a task's accepted head. */
export type ProspectiveMergeOutcome =
  | { kind: "none" }
  | { kind: "ok"; base: string; reviewedHead: string; records: HookRecord[] }
  | { kind: "conflict"; base: string; detail: string }
  | { kind: "refused"; base: string; records: HookRecord[] }
  | { kind: "hold"; detail: string; records: HookRecord[] };

export interface HookContext {
  event: HookEventName; baseCommit?: string; baseBranch?: string; summary?: string;
  instruction?: InstructionArtifact | null;
  /** The pinned Queue-owned prospective merge candidate, when this event observes one. */
  candidate?: MergeCandidate & { path: string };
  /** The retained task worktree a `task.pre_archive` gate or a `task.finished` stop observes in place. */
  worktree?: string;
  delivery?: { prUrl?: string | null; prNumber?: number | null; head?: string | null; review?: string | null; mergeCommit?: string | null; integrationCommit?: string | null; summary?: string };
}

export function hookHoldReason(result: HookEmissionResult): string {
  const record = result.records.at(-1);
  const detail = record?.error || record?.summary || "repository hook requires attention";
  return `Repository hook ${record?.hookId ?? ""} ${record?.event ?? ""} holds this transition: ${detail}`.replace(/\s+/g, " ").trim();
}

export function executablePath(root: string, pin: HookPin): string { return join(root, pin.path); }

export interface RepositoryHooksOptions {
  run?: typeof executeHookProgram;
  snapshot?: typeof snapshotGit;
  /** Queue data directory. Defaults to the directory that holds the store. */
  dataDir?: string;
  /** Queue build identity recorded on project-validation results. Tests inject a stable value. */
  queueBuild?: string;
  /**
   * Wake a task after a background execution settles (Spec 012). Project
   * validation runs off the delivery lanes; its completion enqueues the task's
   * next quantum instead of holding a lane slot for the whole program.
   */
  wakeTask?: (taskId: string) => void;
  /**
   * Settle the workspace-archive consequence after a `task.pre_archive` gate that had
   * held it now passes. The argument is the gate's retained worktree directory, which
   * the lifecycle maps to the owned workspace it belongs to, so a secondary or
   * closeout workspace never clears the backoff of the task's primary workspace.
   */
  retentionGateSettled?: (taskId: string, worktree: string | null) => void;
  /** Queue's host-run scheduler; tests inject a measured capacity and clock. */
  hostRuns?: HostRunScheduler;
  /** Contract 010 token key directory shared with the host-run endpoint. */
  hostRunStateDir?: string;
  /** Poll interval for the detached validation result record. */
  validationPollMs?: number;
  /** Detached supervisor entry point; tests may provide an isolated runner. */
  validationSupervisorEntry?: string;
}

export type ProjectValidationOutcome =
  | { kind: "none" } | { kind: "ok"; base: string }
  | { kind: "conflict"; detail: string } | { kind: "refused"; detail: string }
  | { kind: "hold"; detail: string }
  /** One run for this candidate is already executing in the background. */
  | { kind: "deferred" };

/** A required integration-base occurrence that only an operational base race holds. */
export interface HeldAutomaticReplay { record: HookRecord; ordinal: number | null }

/** The result of one automatic replay attempt for a bound hook and event. */
export type AutomaticReplayAttempt =
  | { status: "applied"; outcome: HookEmissionResult }
  | { status: "exhausted" }
  | { status: "not-applicable" };

/** Process-local observations are hints; durable records remain the authority after eviction. */
export class HookObservationMap<T> extends Map<string, T> {
  override set(key: string, value: T): this {
    this.delete(key);
    if (this.size >= 2048) this.delete(this.keys().next().value!);
    return super.set(key, value);
  }
}
