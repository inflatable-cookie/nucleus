/**
 * The declarations milestone QA's owners share: one admitted run's launch
 * parameters, one runner's options, and a resolved repository. Pure types, so
 * each owner imports the shape without importing the runner.
 */
import type { ProjectQaStage } from '../../shared/contracts';
import type { executeHookProgram } from '../hooks/hooks';
import type { HostRunScheduler } from '../host-runs/host-run-scheduler';
import type { RunScratchPlacement } from '../workspaces/run-scratch';

export interface ResolvedRepository {
  key: string;
  origin: string | null;
  path: string;
  checkoutPath: string;
}

/** One claimed run's launch parameters, before any step has started. */
export interface ProjectQaLaunch extends ResolvedRepository {
  baseBranch: string;
  base: string;
  argv: string[];
  /** #121: the ordered stages the supervisor executes; one "qa" stage for a single-argv setting. */
  stages: ProjectQaStage[];
  timeoutMs: number;
  runClass: "heavy" | "light";
  maxOutputBytes: number;
  terminationGraceMs: number;
  id: string;
  caller: string;
  /** The run's random identity, carried in the supervisor's argv and files. */
  identityToken: string;
  startedAtMs: number;
  startedAt: string;
  epoch: number;
}

export interface ProjectQaOptions {
  dataDir?: string;
  /** Private fixture placement; not a service setting. */
  testPlacement?: { dataDir: string; retainedDataDirs?: string[]; admit: (path: string) => void };
  /** Private fixture run-scratch placement; production uses the configured work root. */
  runScratch?: RunScratchPlacement;
  /**
   * The writer lease identity (`processOwner.owner`) of the runtime that owns
   * this store. Requests record it as their owner, so a preparing request is
   * provably a predecessor's only when this runner holds the lease and the
   * request names another owner. Without it the runner never settles another
   * owner's preparation.
   */
  ownerInstance?: string;
  hostRunStateDir?: string;
  /** Queue's host-run scheduler; tests inject a measured capacity and clock. */
  hostRuns?: HostRunScheduler;
  worktreeHookRun?: typeof executeHookProgram;
  /** Full-output step log writer; tests inject a failing writer. */
  logWrite?: (path: string, buffer: Buffer) => { bytes: number | null; error: string | null };
  fetchTimeoutMs?: number;
  /** Supervision poll cadence; tests shorten it. */
  supervisionPollMs?: number;
  /** Process identity probe override for escaped-descendant sweep tests. */
  escapeeLiveness?: (pid: number, startIdentity: string) => "alive" | "dead" | "unknown";
  /** Detached supervisor entry override; tests and fixtures only. */
  supervisorEntry?: string;
  notify?: (agentId: string, messageId: string, text: string) => Promise<void>;
  responsibleThread?: (project: import("../../shared/contracts").Project) => Promise<string | null>;
}
