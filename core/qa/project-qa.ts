import { writeAtomicOwnedFile } from "../machine/owned-file.mjs";
import { projectQaNotice } from "./project-qa-notice";
import { ProjectQaInspection, projectQaRunReads, type SupervisorInspection } from "./project-qa-inspection";
import { projectQaEscapees } from "./project-qa-escapees";
import { projectQaFilePruning } from "./project-qa-supervision-files";

import { runtimeNodeArgs } from "../../shared/runtime.mjs";
/**
 * Milestone QA runs (task 104): a repository's full QA on current `main` on request.
 *
 * Full QA no longer runs per task. The operator or a planner asks Queue to run a
 * repository's full QA on the current integration head at a milestone and sees the
 * result on the board. Per-task validation commands stay off by default (null);
 * this action runs the repository's `qa` setting, falling back to `effigy qa`.
 *
 * Each run happens in a Queue-owned linked worktree of the repository's
 * registered checkout, exactly as a Paseo task worktree is: its `.git`
 * resolves to the registered repository's common directory, so repository
 * setup that derives its primary checkout from the worktree's Git pointer sees
 * the same primary a task worktree sees. Live Queue places new worktrees on
 * the checkout volume; private stores keep them under their data directory. The registered
 * working tree is neither switched nor written.
 * Queue prepares the relative sibling layout before setup. It runs the
 * repository's Paseo worktree setup and teardown without using task worktrees.
 * Queue schedules each run against its host budget; launched commands still
 * take one Effigy lease, and the host-run journal records class, capacity,
 * process identity, duration and settlement.
 * They grant no merge authority and gate no task.
 *
 * Since task 114 the pipeline itself runs in a detached supervisor process
 * (`project-qa-supervisor.ts`) that outlives the service, so a Queue roll mid-run
 * neither loses the run nor the steps it had recorded. This module owns the
 * store: it claims the run, resolves the sibling links from Queue's own records,
 * writes the run's plan, spawns the supervisor, and re-attaches to a supervisor a
 * previous service started before settling the durable record.
 */
import { qaFenceRefusal } from "./qa-fence";
import { assertCheckoutAvailable, liveCheckoutDataDir } from "../workspaces/checkout-volume";
import { getWorkRoot } from "../workspaces/work-root.mjs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES,
  PROJECT_QA_LOG_WRITE_ERRORS_MAX,
  VALIDATION_TIMEOUT_MAX_MS,
  projectQaRunSchema,
  projectQaRequestSchema,
  projectQaRunInputSchema,
  type ProjectQaRunInput,
  type ProjectQaRequest,
  boundCpuCoverage,
  hostRunSettlementSchema,
  type HostRunEscapedDescendant,
  type HostRunInternalRecord,
  type HostRunResult,
  type HostRunSettlement,
  type ProjectQaLogWriteError,
  type ProjectQaRun,
  type ProjectQaStage,
  type ProjectQaStep,
  type ProjectQaStepName,
} from "../../shared/contracts";
import { HostRunScheduler, classifyHostRun, selectorForArgv } from "../host-runs/host-run-scheduler";
import type { HostRunHandler } from "../host-runs/host-run-scheduler";
import { Store, digest, now, HISTORY_RETENTION_MS } from "../store/store";
import { qaCallerIdentity as canonicalQaCallerIdentity } from "./qa-caller";
import { repositoryOrigin } from "../planning/lanes";
import { currentServiceBuildId } from "../../shared/service/build";
import { executeHookProgram, gitRaw, isolationDataDirFor, minimalHookEnvironment } from "../hooks/hooks";
import {
  checkoutRunScratchPlacement,
  removeRecordedRunScratchDirectory,
  runTemporaryEnvironment,
  withRunTemporaryDirectory,
  type RunScratchPlacement,
} from "../workspaces/run-scratch";
import { withSpawnSlot } from "../dispatch/spawn-gate";
import { queueGitFetch } from "../git/git-fetch";
import { missingSiblingCheckout, siblingMembers, siblingNameFor } from "../workspaces/siblings";
import { dependencyLinkPaths, gitText, resolveSiblingSource, worktreeSiblingSpecs, type ConfiguredCheckout } from "../workspaces/worktree-links";
import { findGitWorktreeAdd, findProcessByCommandToken } from "../machine/process-identity";
import { parseWorktreeList, repoCommonDir } from "../workspaces/workspace-allocation";
import { processGroupEmpty, processStartIdentityLiveness } from "../machine/process-group";
import {
  QA_SUPERVISION_PLAN_SCHEMA,
  QA_SUPERVISION_SCHEMA_VERSION,
  executionOutput,
  qaStepRecord,
  qaExecutionFailed,
  mergeQaEscapees,
  parseProjectQaWorktreeHooks,
  projectQaWorktreeHooks,
  qaRunRootPath,
  qaStepLogPaths,
  qaSupervisionPaths,
  qaSupervisionPlanSchema,
  readQaSupervision,
  readQaSupervisionPlan,
  readHostRunResult,
  readQaCancelRequest,
  removeQaSupervisionFiles,
  removeQaWorkspace,
  supervisorLiveness,
  qaSupervisionCpuCoverage,
  readQaCpuCoverage,
  writeQaStepLog,
  writeQaSupervisionPlan,
  writeQaCancelRequest,
  type ProjectQaWorktreeHooks,
  type QaPipelineOutcome,
  type QaSupervisionPlan,
  type QaSupervisionState,
} from "./project-qa-supervisor";
import { tailWithTruncationMarker } from "../machine/output-retention";

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" };

/** Default milestone QA command when the repository sets no `qa` command. Per-task validation stays null by default. */
export const DEFAULT_PROJECT_QA_ARGV = ["effigy", "qa"];
export const DEFAULT_PROJECT_QA_TIMEOUT_MS = VALIDATION_TIMEOUT_MAX_MS;
export const DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES = PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES;
/**
 * #121: the host-run envelope for one milestone run. Setup and teardown each get
 * the hook timeout bound, so the envelope covers both around every stage's own
 * window; no step can consume another's launch-relative timeout budget.
 */
export const projectQaEnvelopeMs = (stages: ReadonlyArray<{ timeoutMs: number }>): number =>
  stages.reduce((sum, stage) => sum + stage.timeoutMs, 0) + 2 * DEFAULT_PROJECT_QA_TIMEOUT_MS;
/** Bounded tail kept on the run record. */
export const PROJECT_QA_TAIL_BYTES = 2000;
/** A supervision file is polled at this cadence while the service waits for the supervisor. */
const SUPERVISION_POLL_MS = 500;

/** Merge log-write failures, newest-last and bounded, so a retry never drops an earlier diagnostic. */
const mergeLogWriteErrors = (existing: ReadonlyArray<ProjectQaLogWriteError> | undefined,
  added: ReadonlyArray<ProjectQaLogWriteError> | undefined): ProjectQaLogWriteError[] =>
  [...(existing ?? []), ...(added ?? [])].slice(-PROJECT_QA_LOG_WRITE_ERRORS_MAX);

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
  queueBuild?: string;
  /** Queue's host-run scheduler; tests inject a measured capacity and clock. */
  hostRuns?: HostRunScheduler;
  worktreeHookRun?: typeof executeHookProgram;
  /** Full-output step log writer; tests inject a failing writer. */
  logWrite?: (path: string, buffer: Buffer) => { bytes: number | null; error: string | null };
  fetchTimeoutMs?: number;
  /** Supervision poll cadence; tests shorten it. */
  supervisionPollMs?: number;
  /** Detached supervisor entry override; tests and fixtures only. */
  supervisorEntry?: string;
  notify?: (agentId: string, messageId: string, text: string) => Promise<void>;
}

interface ResolvedRepository {
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

const sleep = (ms: number) => new Promise<void>(resolvePromise => { setTimeout(resolvePromise, ms); });

/**
 * In-flight runs this process owns: the launch pipeline for a run that has not
 * been handed to a detached supervisor, or the attach watcher for one that has.
 * The durable supervision file is the cross-process fence; this map only stops
 * one process reconciling away a run it is itself driving.
 */
const qaGates = new Map<string, Promise<unknown>>();
/** Attached watchers by run id, so concurrent reads share one. */
const qaAttachments = new Map<string, Promise<void>>();
const qaRecoveries = new Map<string, Promise<void>>();

const QA_REQUEST_OWNER_INSTANCE = randomUUID();
/** Every interrupted-preparation settlement starts with this; the scheduler reads it as a lifecycle refusal. */
export const QA_INTERRUPTED_PREPARATION_PREFIX = "QA request preparation was interrupted";

export class ProjectQaRunner {
  readonly hostRuns: HostRunScheduler;
  private lastCheckoutRetentionAt = 0;
  constructor(readonly store: Store, readonly options: ProjectQaOptions = {}) { this.hostRuns = options.hostRuns ?? HostRunScheduler.forStore(store); }

  private queueBuild(): string { return this.options.queueBuild ?? currentServiceBuildId(); }
  /** The owner identity this runner writes on its requests: the writer lease when the runtime supplies it. */
  get ownerInstance(): string { return this.options.ownerInstance ?? QA_REQUEST_OWNER_INSTANCE; }

  /**
   * Settle requests a predecessor writer left preparing. The single-writer
   * lease (`processOwner`, taken only when the previous owner's process is
   * gone) proves a request owned by anyone other than the current lease holder
   * can no longer reach its admission claim on this store; the claim
   * transaction sets `admitted` together with the run, so a request still
   * `preparing` claimed no QA run and submitted no host run. Only runs while
   * this runner holds the lease; never touches its own preparations, admitted
   * or refused requests, or a record whose owner binding does not decode.
   */
  settleInterruptedPreparations(): number {
    return this.store.transaction(() => {
      const lease = this.store.getMeta<{ owner?: unknown }>("processOwner");
      if (!lease || lease.owner !== this.ownerInstance || !this.options.ownerInstance) return 0;
      let settled = 0;
      for (const row of this.store.db.prepare(`SELECT key, value FROM meta WHERE key GLOB 'projectQaRequest:*'
        AND CASE WHEN json_valid(value) THEN json_extract(value,'$.state')='preparing' ELSE 0 END ORDER BY key`).all()) {
        let decoded: unknown;
        try { decoded = JSON.parse(String(row.value)); } catch { continue; }
        const parsed = projectQaRequestSchema.safeParse(decoded);
        if (!parsed.success || parsed.data.state !== "preparing" || parsed.data.ownerInstance === this.ownerInstance) continue;
        const request = parsed.data;
        this.store.setMeta(String(row.key), { ...request, state: "refused", settledAt: now(),
          diagnostic: `${QA_INTERRUPTED_PREPARATION_PREFIX}: its owner ${request.ownerInstance} (pid ${request.ownerPid}) is a predecessor of the current writer lease ${this.ownerInstance}, and it ended before an admission claim, so this request claimed no QA run and submitted no host run. Retry with a new request ID` });
        settled++;
      }
      return settled;
    });
  }
  private isolationDataDir(): string {
    const dir = this.options.dataDir ?? isolationDataDirFor(this.store);
    try { return realpathSync(dir); } catch { return resolve(dir); }
  }
  protected hostRunStateDir(): string {
    return this.options.hostRunStateDir ?? join(this.isolationDataDir(), "host-run");
  }
  private qaPlacement() {
    if (this.options.testPlacement) return this.options.testPlacement;
    const dataDir = liveCheckoutDataDir(this.isolationDataDir());
    return dataDir ? { dataDir, admit: (path: string) => assertCheckoutAvailable({ target: path }) } : null;
  }
  protected checkoutForRun(run: ProjectQaRun): string {
    return run.checkoutPath ?? this.qaCheckoutPath(run.key, run.id);
  }
  protected admitCheckout(run: ProjectQaRun): void {
    if (!run.checkoutPath) return;
    const placement = this.qaPlacement();
    const roots = placement ? (this.options.testPlacement ? [placement.dataDir, ...(this.options.testPlacement.retainedDataDirs ?? [])] : [join(getWorkRoot(), "queue")]) : [];
    const expected = roots.some(root => run.checkoutPath === join(root, "project-qa", digest(run.submittedKey ?? run.key).slice(0, 24), run.id));
    if (!placement || !expected) throw new Error("Project QA checkout allocation identity changed");
    placement.admit(run.checkoutPath);
  }
  /**
   * Where this QA run's temp leaf lives. Live service uses the configured work
   * root; a fixture injects its own mount; a protected store without either keeps
   * the inherited environment so an already-launched run is untouched.
   */
  private scratchPlacement(run?: ProjectQaRun): RunScratchPlacement | null {
    const namespace = run
      ? this.store.scratchNamespaceFor({ repoPath: run.repository.path, repository: run.repository.origin })
      : undefined;
    if (this.options.runScratch) return namespace ? this.options.runScratch.withNamespace?.(namespace) ?? this.options.runScratch : this.options.runScratch;
    if (liveCheckoutDataDir(this.isolationDataDir())) return checkoutRunScratchPlacement({ namespace });
    return null;
  }
  /** Create or re-prove this run's scratch leaf and record it. A run already in flight keeps its recorded path. */
  protected ensureRunScratch(run: ProjectQaRun): string | undefined {
    const placement = this.scratchPlacement(run);
    if (!placement) return run.temporaryDirectory;
    const directory = runTemporaryEnvironment(run.id, placement, run.temporaryDirectory).TMPDIR;
    const current = this.store.qaRun(run.id) ?? run;
    if (current.temporaryDirectory !== directory) this.store.putQaRun({ ...current, temporaryDirectory: directory });
    return directory;
  }
  /** Remove the recorded leaf once the run has settled and its checkout is gone. */
  protected releaseRunScratch(run: ProjectQaRun, checkoutRetained: boolean): void {
    if (checkoutRetained || !run.temporaryDirectory) return;
    try {
      const placement = this.scratchPlacement(run);
      if (placement) placement.remove(run.temporaryDirectory);
      else removeRecordedRunScratchDirectory(run.temporaryDirectory);
    } catch { /* a leftover leaf is operational, not a settlement failure */ }
  }
  private noteCheckoutWait(run: ProjectQaRun, error: unknown): void {
    const current = this.store.qaRun(run.id);
    if (!current || current.state !== "running") return;
    const detail = `QA checkout reconciliation waiting: ${error instanceof Error ? error.message : String(error)}`;
    if (!current.outputTail.includes(detail)) this.store.putQaRun({ ...current,
      outputTail: tailWithTruncationMarker(`${current.outputTail}${current.outputTail ? "\n" : ""}${detail}`, PROJECT_QA_TAIL_BYTES) });
  }
  /**
   * Caller identity for one Queue-owned milestone host run. The canonical string
   * lives in `qa-caller` so the retained-output sweep can verify this producer's
   * ownership from durable records instead of trusting a prefix (task 444).
   */
  qaCallerIdentity(key: string, runId: string): string { return canonicalQaCallerIdentity(key, runId); }

  /**
   * True when the pipeline runs in a detached supervisor. The service runs it
   * itself only when a fixture injected its executors: those functions cannot
   * cross a process boundary, and the supervisor is the production path.
   */

  /** Resolve a repository name (absolute checkout path or `owner/name` origin) to its one-run key and a local checkout to fetch from. */
  async resolveRepository(input: string, baseBranch: string): Promise<ResolvedRepository> {
    void baseBranch;
    if (isAbsolute(input)) {
      const real = await realpath(input).catch(() => null);
      if (!real || !existsSync(real)) throw new Error(`Project QA repository path does not exist: ${input}`);
      const origin = await repositoryOrigin(real).catch(() => null);
      return { key: origin ?? real, origin, path: real, checkoutPath: real };
    }
    const origin = normalizeRepositoryOrigin(input);
    if (!origin) throw new Error("Repository must be an absolute checkout path or a normalised owner/name origin");
    const row = this.store.repositoryFor(origin);
    const hinted = row?.repository.path || this.store.projects().flatMap(project => project.repositories).find(repo => repo.origin === origin)?.path || "";
    if (hinted && existsSync(hinted)) {
      const real = await realpath(hinted).catch(() => hinted);
      return { key: origin, origin, path: real, checkoutPath: real };
    }
    // Fall back to any known checkout whose remote reports this origin.
    for (const project of this.store.projects()) {
      for (const repo of project.repositories) {
        if (!repo.path || !existsSync(repo.path)) continue;
        const seen = await repositoryOrigin(repo.path).catch(() => null);
        if (seen === origin) {
          const real = await realpath(repo.path).catch(() => repo.path);
          return { key: origin, origin, path: real, checkoutPath: real };
        }
      }
    }
    throw new Error(`Project QA has no local checkout for ${origin}: set the repository path with repository.set first`);
  }

  /** Read one recorded run by ID or the latest run for a repository. */
  get(input: { id: string } | { repository: string }): Promise<ProjectQaRun | null> {
    return projectQaRunReads.get.call(this, input);
  }

  /** Latest run per repository, re-attaching to or healing running rows so the board never shows a stuck run. */
  async list(): Promise<ProjectQaRun[]> {
    this.settleInterruptedPreparations();
    // Audit A7: re-attach only the settled rows that still hold capacity for
    // escaped descendants not yet proven dead, selected in SQL instead of
    // parsing every host-run row on each 20 s tick and 4 s poll.
    for (const run of this.store.hostRunsAwaitingEscapedDescendants()) this.watchEscapedDescendants(run.id);
    const runs = this.store.latestQaRuns();
    for (const run of runs) {
      if (run.state === "queued") { this.attachQueued(run); continue; }
      if (run.state === "running") await this.reconcile(run.key, run.id).catch(() => { /* reconciliation is best-effort on reads */ });
    }
    await this.pruneSettledCheckouts();
    return this.store.latestQaRuns();
  }

  /** Settled checkouts are removed; per-run files expire with retained history. */
  private async pruneSettledCheckouts(): Promise<void> {
    if (Date.now() - this.lastCheckoutRetentionAt < 60 * 60 * 1000) return;
    this.lastCheckoutRetentionAt = Date.now();
    const rows = this.store.db.prepare("SELECT data FROM project_qa_runs WHERE json_valid(data)").all() as { data: string }[];
    const dataDir = this.isolationDataDir();
    const roots = [dataDir, ...(this.qaPlacement()
      ? (this.options.testPlacement ? [this.options.testPlacement.dataDir, ...(this.options.testPlacement.retainedDataDirs ?? [])] : [join(getWorkRoot(), "queue")])
      : [])];
    for (const row of rows) {
      let run: ProjectQaRun;
      try { run = projectQaRunSchema.parse(JSON.parse(row.data)); } catch { continue; }
      if (run.state === "queued" || run.state === "running" || !run.finishedAt || run.checkoutCleanupPending) continue;
      const keyDigest = digest(run.submittedKey ?? run.key).slice(0, 24);
      const expected = roots.map(root => join(root, "project-qa", keyDigest, run.id));
      const checkout = expected.find(path => path === run.checkoutPath)
        ?? expected.find(path => (!run.checkoutPath || run.checkoutPath.endsWith(`/project-qa/${keyDigest}/${run.id}`)) && path === this.qaCheckoutPath(run.key, run.id));
      if (!checkout) continue;
      if (this.needsTeardownRetry(run) && this.store.latestQaRun(run.key)?.id === run.id) continue;
      const hostRun = this.hostRuns.get(run.id);
      if (hostRun && hostRun.state !== "settled") continue;
      try {
        await removeQaWorkspace({ registeredPath: run.repository.path, checkoutPath: checkout,
        });
      } catch { /* Preserve uncertain checkouts; a later sweep retries. */ }
    }
    await this.pruneQaFiles(roots);
  }

  private pruneQaFiles(roots: string[]): Promise<void> {
    return projectQaFilePruning.pruneQaFiles.call({
      store: this.store, hostRuns: this.hostRuns, historyRetentionMs: HISTORY_RETENTION_MS,
      needsTeardownRetry: run => this.needsTeardownRetry(run),
    }, roots);
  }

  private needsTeardownRetry(run: ProjectQaRun): boolean {
    const lastTeardown = run.steps.filter(step => step.name === "teardown").at(-1);
    return run.failedStep === "teardown" || Boolean(lastTeardown && (lastTeardown.exitCode !== 0 || lastTeardown.signal != null
      || lastTeardown.timedOut || lastTeardown.terminationError != null || lastTeardown.processGroupEmpty === false));
  }

  private readonly inspection = new ProjectQaInspection({ get: id => this.hostRuns.get(id) }, key => this.qaRepositoryRootPath(key));

  private inspectSupervisor(run: ProjectQaRun): Promise<SupervisorInspection> {
    return this.inspection.inspectSupervisor(run);
  }

  /**
   * Resolve a `running` row this process is not driving: apply a settled
   * supervision file, re-attach to a supervisor that is still alive (or whose
   * identity cannot currently be read), or — only when the supervisor is proven
   * dead — reconcile it as lost while keeping the steps it had recorded.
   */
  async reconcile(key: string, requestedId?: string): Promise<void> {
    const latest = requestedId ? this.store.qaRun(requestedId) : this.store.latestQaRun(key);
    if (!latest || latest.key !== key) return;
    if (latest.state === "queued") { this.attachQueued(latest); return; }
    if (latest.state !== "running") return;
    if (!this.hostRuns.get(latest.id)) {
      const selector = latest.selector ?? selectorForArgv(latest.argv, "qa");
      const classification = latest.runClass ? { runClass: latest.runClass, classSource: latest.classSource ?? "default" as const }
      : classifyHostRun(latest.repository.path, selector, selector === "test" && latest.argv.length > 2);
      this.hostRuns.adoptRunning({ id: latest.id, epoch: this.hostRuns.authority().epoch,
        caller: this.qaCallerIdentity(latest.key, latest.id), repository: latest.repository,
        selector, ...classification, priority: "milestone", runTimeoutMs: latest.runTimeoutMs ?? DEFAULT_PROJECT_QA_TIMEOUT_MS,
        submittedAt: latest.submittedAt ?? latest.startedAt, launchedAt: latest.startedAt, pid: latest.pid });
    }
    const alreadyWatching = qaAttachments.has(latest.id);
    const inspection = await this.inspectSupervisor(latest);
    if (JSON.stringify(this.store.qaRun(latest.id)) !== JSON.stringify(latest)) return;
    if (alreadyWatching) {
      if (inspection.kind !== "dead") return;
      const activeRecovery = qaRecoveries.get(key);
      if (activeRecovery) return activeRecovery;
      const settling = this.reconcileLostRun(latest, inspection.state, inspection.reason, inspection.escapedDescendants)
        .finally(() => qaRecoveries.delete(key));
      qaRecoveries.set(key, settling);
      return settling;
    }
    const activeRecovery = qaRecoveries.get(key);
    if (activeRecovery) return activeRecovery;
    if (inspection.kind === "settled") {
      const settling = this.settleFromSupervisor(latest, inspection.state, inspection.hostResult)
        .then(() => {}).finally(() => qaRecoveries.delete(key));
      qaRecoveries.set(key, settling);
      return settling;
    }
    if (inspection.kind === "running") {
      // A supervisor still owns this run: wait for it in the background instead
      // of reaping it, so a board read never blocks on a long QA command.
      const watching = this.watchSupervisor(latest.id, key).finally(() => { qaAttachments.delete(latest.id); });
      qaAttachments.set(latest.id, watching);
      void watching.catch(() => { /* the watcher records its own fault on the run */ });
      return;
    }
    if (inspection.kind === "unstarted") {
      // The host scheduler records launch immediately before Queue spawns the
      // detached supervisor. Its first supervision state is written before
      // checkout preparation or any QA command, so this gap is safe to resume
      // with the same plan and run ID after a backend restart.
      if (qaGates.has(key)) return;
      const recovery = qaRecoveries.get(key);
      if (recovery) return recovery;
      const resumed = this.resumeUnstartedSupervisor(latest, inspection.plan)
        .catch(error => { if (!latest.checkoutPath) throw error; this.noteCheckoutWait(latest, error); })
        .finally(() => qaRecoveries.delete(key));
      qaRecoveries.set(key, resumed);
      void resumed.catch(() => { /* startup recovery is retried by the next board read */ });
      return;
    }
    if (qaGates.has(key)) return;
    const recovery = qaRecoveries.get(key);
    if (recovery) return recovery;
    const lost = this.reconcileLostRun(latest, inspection.state, inspection.reason, inspection.escapedDescendants)
      .catch(error => { if (!latest.checkoutPath) throw error; this.noteCheckoutWait(latest, error); }).finally(() => qaRecoveries.delete(key));
    qaRecoveries.set(key, lost);
    return lost;
  }

  /** Resume the existing admission when the detached supervisor never began the pipeline. */
  private async resumeUnstartedSupervisor(run: ProjectQaRun, plan: QaSupervisionPlan): Promise<void> {
    if (plan.checkoutPath !== this.checkoutForRun(run) || Boolean(plan.externalCheckout) !== Boolean(run.checkoutPath))
      throw Error("Project QA supervision plan checkout identity changed");
    const current = this.store.qaRun(run.id);
    if (!current || current.state !== "running") return;
    const { statePath, planPath, resultPath } = qaSupervisionPaths(this.qaRepositoryRootPath(run.key), run.id);
    const persistedPlan = readQaSupervisionPlan(planPath);
    if (!persistedPlan || persistedPlan.runId !== run.id || persistedPlan.key !== run.key
        || persistedPlan.identityToken !== plan.identityToken) return;
    // Another launch may have become visible since inspection. Any state,
    // result or identity-bearing process belongs to the existing supervisor;
    // attach to it instead of spawning a duplicate.
    const process = findProcessByCommandToken(plan.identityToken);
    if (readQaSupervision(statePath) || readHostRunResult(resultPath, run.id) || process.state !== "absent") {
      await this.attachSupervisor(run.id, run.key);
      return;
    }
    const scheduledGroup = this.hostRuns.get(run.id)?.processGroupId;
    if (scheduledGroup && !processGroupEmpty(scheduledGroup)) {
      await this.attachSupervisor(run.id, run.key);
      return;
    }
    this.admitCheckout(run);
    const pid = this.spawnQaSupervisor(planPath, plan.identityToken, plan.temporaryDirectory);
    const latest = this.store.qaRun(run.id);
    if (latest?.state === "running") this.store.putQaRun({ ...latest, pid });
    await this.attachSupervisor(run.id, run.key, 1);
  }

  /**
   * Settle a run whose detached supervisor is proven dead. The steps it
   * recorded are kept, the step that was in flight is named, the real duration
   * comes from `startedAt`, and teardown still runs from the retained checkout
   * (unless the supervisor had already completed it) with its own step record.
   */
  private async reconcileLostRun(run: ProjectQaRun, state: QaSupervisionState | null, reason: string, escapedDescendants: HostRunEscapedDescendant[] = []): Promise<void> {
    const runRoot = this.qaRepositoryRootPath(run.key);
    const attempt = run.teardownRetryAttempt ?? 0;
    // A dead teardown-retry supervisor is not re-driven here: settle the run
    // back to hold with what the retry recorded and let the operator retry.
    if (attempt > 0) {
      const steps: ProjectQaStep[] = state ? [...state.steps] : [...run.steps];
      const detail = `${state?.detail ?? run.outputTail}${state?.detail || run.outputTail ? "\n" : ""}Queue lost this QA run (${reason}).`;
      const current = this.store.qaRun(run.id);
      if (current?.state === "running") this.store.transaction(() => {
        const held = this.applyTeardownRetry(current, {
          state: "hold", exitCode: current.exitCode, detail, finishedAt: now(), steps,
          failedStep: "teardown",
          checkoutCleanupPending: current.checkoutCleanupPending,
          logWriteErrors: mergeLogWriteErrors(run.logWriteErrors, state?.logWriteErrors),
          escapedDescendants: mergeQaEscapees(escapedDescendants, state?.escapedDescendants ?? []),
        });
        if (state?.inFlight === "teardown") this.store.putQaRun({ ...held, interruptedStep: "teardown",
          outputTail: tailWithTruncationMarker(`${held.outputTail}\nTeardown delivery is uncertain; do not replay it.`, PROJECT_QA_TAIL_BYTES) });
      });
      removeQaSupervisionFiles(runRoot, run.id, attempt);
      return;
    }
    const checkoutPath = this.checkoutForRun(run);
    this.admitCheckout(run);
    if (run.checkoutPath) {
      if (findGitWorktreeAdd(checkoutPath).state !== "absent") throw Error("Project QA checkout creation remains uncertain");
      const listing = parseWorktreeList(await gitText(run.repository.path, "worktree", "list", "--porcelain"));
      const matching = listing.filter(tree => tree.path === checkoutPath);
      if (existsSync(checkoutPath) && (matching.length !== 1 || matching[0].head !== run.base || matching[0].branch ||
          await repoCommonDir(checkoutPath) !== await repoCommonDir(run.repository.path)))
        throw Error("Project QA retained checkout identity is uncertain");
      if (!existsSync(checkoutPath) && matching.length) throw Error("Project QA checkout disappearance is uncertain");
      if (state?.inFlight === "teardown") throw Error("Project QA teardown delivery is uncertain; inspect the retained checkout");
    }
    const steps: ProjectQaStep[] = state ? [...state.steps] : [...run.steps];
    let failedStep: ProjectQaStepName | null = state?.failedStep ?? run.failedStep;
    const interruptedStep = state?.inFlight ?? null;
    let detail = state?.detail ?? run.outputTail;
    detail = `${detail}${detail ? "\n" : ""}Queue backend lost this QA run (${reason}).`;
    if (interruptedStep) detail = `${detail}${detail ? " " : ""}The ${interruptedStep} step was in flight when the supervisor died.`;
    let logWriteErrors = mergeLogWriteErrors(run.logWriteErrors, state?.logWriteErrors);
    let teardownFailed = false;
    if (existsSync(checkoutPath) && !steps.some(step => step.name === "teardown")) {
      try {
        const hooks = await projectQaWorktreeHooks(checkoutPath);
        if (hooks.teardown) {
          const result = await this.runWorktreeHook(checkoutPath, hooks.teardown, run.terminationGraceMs, {
            ...(run.temporaryDirectory ? { env: withRunTemporaryDirectory(minimalHookEnvironment(`project-qa:${run.id}`), run.temporaryDirectory) } : {}),
          });
          const logs = qaStepLogPaths(runRoot, run.id, "teardown");
          const stdoutLog = writeQaStepLog(logs.stdoutPath, result.stdout);
          const stderrLog = writeQaStepLog(logs.stderrPath, result.stderr);
          if (stdoutLog.error) {
            detail += `\nFull-output log for step teardown (stdout) could not be written: ${stdoutLog.error}`;
            logWriteErrors = mergeLogWriteErrors(logWriteErrors, [{ step: "teardown", stream: "stdout", error: stdoutLog.error }]);
          }
          if (stderrLog.error) {
            detail += `\nFull-output log for step teardown (stderr) could not be written: ${stderrLog.error}`;
            logWriteErrors = mergeLogWriteErrors(logWriteErrors, [{ step: "teardown", stream: "stderr", error: stderrLog.error }]);
          }
          steps.push(qaStepRecord("teardown", hooks.teardown, result, logs, stdoutLog, stderrLog));
          if (qaExecutionFailed(result)) failedStep ??= "teardown";
          const output = executionOutput(result);
          if (output) detail += `\nWorktree teardown output:\n${output}`;
          if (qaExecutionFailed(result)) {
            teardownFailed = true;
            detail += `\nQA worktree teardown failed${result.timedOut ? " (timed out)" : result.signal ? ` (${result.signal})` : ` (exit ${result.code})`}.`;
          }
        }
      } catch (error) {
        teardownFailed = true;
        detail += `\nQA worktree teardown failed: ${String(error)}`;
      }
    }
    if (!teardownFailed) {
      try {
        await removeQaWorkspace({ registeredPath: run.repository.path, checkoutPath,
          ...(run.checkoutPath ? { admission: () => this.admitCheckout(run), expectedHead: run.base } : {}) });
        detail += " Its Queue-owned checkout was removed.";
      } catch (error) {
        detail += `\nQA checkout cleanup failed: ${String(error)}`;
      }
    }
    const durationMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
    const current = this.store.qaRun(run.id);
    if (current?.state === "running") await this.settle(current, {
      state: "lost", exitCode: null, durationMs, detail, steps, failedStep, logWriteErrors,
      finishedAt: now(), interruptedStep, hostResult: null,
      escapedDescendants: mergeQaEscapees(escapedDescendants, state?.escapedDescendants ?? []),
      cancelReason: state?.cancelReason ?? current.cancelReason,
    });
    removeQaSupervisionFiles(runRoot, run.id);
  }

  /** Request a durable, idempotent cancellation; the detached supervisor owns stopping and teardown. */
  async cancel(input: { id: string; reason: string }): Promise<ProjectQaRun> {
    const reason = input.reason.trim();
    if (!input.id.trim() || !reason) throw new Error("Project QA cancel requires a run id and reason");
    const run = this.store.qaRun(input.id);
    if (!run) throw new Error(`Project QA run not found: ${input.id}`);
    if (run.state !== "running" && run.state !== "queued") return run;
    if ((run.teardownRetryAttempt ?? 0) > 0) throw new Error("A milestone QA teardown retry is not cancelable");
    const scheduled = this.hostRuns.get(run.id);
    if (scheduled && (scheduled.state === "queued" || scheduled.state === "admitted")) {
      const launchInFlight = qaGates.has(run.key);
      if (run.cancelReason !== reason) this.store.putQaRun({ ...run, cancelReason: reason });
      const cancelled = this.hostRuns.cancelQueued(run.id, reason, scheduled.epoch);
      if (launchInFlight) {
        const runRoot = this.qaRepositoryRootPath(run.key);
        await mkdir(runRoot, { recursive: true, mode: 0o700 });
        const { cancelPath } = qaSupervisionPaths(runRoot, run.id);
        writeQaCancelRequest(cancelPath, { runId: run.id, reason, requestedAt: now() });
      }
      await this.onSchedulerTerminal(run.id, cancelled);
      return this.store.qaRun(run.id)!;
    }
    if (run.state !== "running") return run;
    if (scheduled) this.hostRuns.cancelQueued(run.id, reason, scheduled.epoch); // journal the request before the stop side effect
    await this.reconcile(run.key, run.id);
    const current = this.store.qaRun(run.id);
    if (!current || current.state !== "running") return current ?? run;
    const runRoot = this.qaRepositoryRootPath(current.key);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const { cancelPath } = qaSupervisionPaths(runRoot, current.id);
    const request = writeQaCancelRequest(cancelPath, { runId: current.id, reason, requestedAt: now() });
    if (current.cancelReason !== request.reason) this.store.putQaRun({ ...current, cancelReason: request.reason });
    return this.store.qaRun(current.id)!;
  }

  /**
   * Tom, 2026-11-01: a board operator dismisses a finished run that is not passing. The record stays
   * and records who dismissed it and why; a live run is cancelled instead and a passing run fades.
   */
  dismiss(input: { id: string; reason: string; caller: string }): ProjectQaRun {
    const reason = input.reason.trim(), caller = input.caller.trim();
    if (!input.id.trim() || !reason || !caller) throw new Error("Project QA dismiss requires a run id, reason and caller");
    const run = this.store.qaRun(input.id);
    if (!run) throw new Error(`Project QA run not found: ${input.id}`);
    if (run.state === "queued" || run.state === "running") throw new Error("A queued or running milestone QA run is cancelled, not dismissed");
    if (run.state === "passed") throw new Error("A passed milestone QA run leaves the board on its own; nothing to dismiss");
    if (run.dismissal) return run;
    return this.store.putQaRun({ ...run, dismissal: { at: now(), by: caller, reason } });
  }

  /**
   * True while any recorded supervisor for this run is still alive. A settled
   * run's retained result file is not evidence of life, so only the recorded
   * pid plus identity token (and the plan's token) are consulted. An identity
   * that cannot be read counts as live, matching the re-attach rule.
   */
  private liveSupervisorFor(run: ProjectQaRun): boolean {
    const runRoot = this.qaRepositoryRootPath(run.key);
    for (const attempt of new Set([0, run.teardownRetryAttempt ?? 0])) {
      const { statePath, planPath } = qaSupervisionPaths(runRoot, run.id, attempt);
      const state = readQaSupervision(statePath);
      if (state && supervisorLiveness(state.pid, state.identityToken).state !== "dead") return true;
      const plan = readQaSupervisionPlan(planPath);
      if (plan?.runId === run.id && plan.key === run.key && findProcessByCommandToken(plan.identityToken).state !== "absent") return true;
    }
    return false;
  }

  /**
   * Task 134: rerun only a settled run's failed teardown, through the same
   * supervisor, termination and logging path as the original. Refused unless
   * the run settled at teardown, its Queue-owned checkout is retained and no
   * supervisor is live. The recorded QA step is never rerun or rewritten.
   */
  async retryTeardown(input: { id: string; reason: string }): Promise<ProjectQaRun> {
    const reason = input.reason.trim();
    if (!input.id.trim() || !reason) throw new Error("Project QA teardown retry requires a run id and reason");
    const run = this.store.qaRun(input.id);
    if (!run) throw new Error(`Project QA run not found: ${input.id}`);
    if (run.state === "queued" || run.state === "running")
      throw new Error(`Project QA run ${run.id} is ${run.state}; teardown retry needs a settled run`);
    const lastTeardown = run.steps.filter(step => step.name === "teardown").at(-1);
    const teardownFailed = Boolean(lastTeardown && (lastTeardown.exitCode !== 0 || lastTeardown.signal != null
      || lastTeardown.timedOut || lastTeardown.terminationError != null || lastTeardown.processGroupEmpty === false));
    if (run.failedStep !== "teardown" && !teardownFailed && !run.checkoutCleanupPending)
      throw new Error(`Project QA run ${run.id} did not fail at teardown; teardown retry is refused`);
    if (run.interruptedStep === "teardown")
      throw new Error(`Project QA run ${run.id} has an uncertain teardown outcome; retry is refused`);
    const checkoutPath = this.checkoutForRun(run);
    this.admitCheckout(run);
    if (!existsSync(checkoutPath))
      throw new Error(`Project QA run ${run.id} has no retained checkout; teardown retry is refused`);
    if (this.liveSupervisorFor(run))
      throw new Error(`Project QA run ${run.id} still has a live supervisor; teardown retry is refused`);
    const hook = lastTeardown ? null : (await projectQaWorktreeHooks(checkoutPath)).teardown;
    const cleanupOnly = Boolean(run.checkoutPath && run.checkoutCleanupPending);
    const command = lastTeardown?.command ?? hook ?? (cleanupOnly ? ":" : null);
    if (!command)
      throw new Error(`Project QA run ${run.id} records no teardown command; teardown retry is refused`);
    const qaExitCode = run.steps.find(step => step.name === "qa")?.exitCode ?? run.exitCode;
    const start = this.startTeardownRetry(run, command, qaExitCode, reason, cleanupOnly);
    const gate = start.finally(() => { qaGates.delete(run.key); });
    qaGates.set(run.key, gate);
    return await gate;
  }

  /** Spawn the detached supervisor for one teardown retry attempt and watch it settle. */
  protected async startTeardownRetry(run: ProjectQaRun, command: string, qaExitCode: number | null, reason: string, cleanupOnly: boolean): Promise<ProjectQaRun> {
    const runRoot = this.qaRepositoryRootPath(run.key);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const attempt = (run.teardownRetryAttempt ?? 0) + 1;
    const identityToken = randomUUID();
    const startedAt = now();
    const temporaryDirectory = this.ensureRunScratch(run);
    const plan = qaSupervisionPlanSchema.parse({
      schema: QA_SUPERVISION_PLAN_SCHEMA, schema_version: QA_SUPERVISION_SCHEMA_VERSION,
      runId: run.id, key: run.key, caller: this.qaCallerIdentity(run.key, run.id),
      base: run.base, baseBranch: run.baseBranch, startedAt, startedAtMs: Date.parse(startedAt),
      checkoutPath: this.checkoutForRun(run), registeredPath: run.repository.path, runRoot,
      ...(run.checkoutPath ? { externalCheckout: true } : {}),
      argv: run.argv, timeoutMs: run.runTimeoutMs ?? DEFAULT_PROJECT_QA_TIMEOUT_MS,
      maxOutputBytes: run.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES,
      epoch: run.hostRunEpoch ?? this.hostRuns.authority().epoch,
      runClass: run.runClass ?? "heavy", hostRunStateDir: this.hostRunStateDir(),
      terminationGraceMs: run.terminationGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS,
      hookTimeoutMs: DEFAULT_PROJECT_QA_TIMEOUT_MS, hookMaxOutputBytes: DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES,
      identityToken, links: [], mode: "teardown_retry", attempt,
      retry: { command, priorSteps: run.steps, qaExitCode, priorCancelReason: run.cancelReason, reason, cleanupOnly, priorFailedStep: run.failedStep },
      ...(temporaryDirectory ? { temporaryDirectory } : {}),
    });
    const { planPath } = qaSupervisionPaths(runRoot, run.id, attempt);
    writeQaSupervisionPlan(planPath, plan);
    const current = this.store.qaRun(run.id) ?? run;
    // Mark the run running before the spawn, so a roll in the launch window
    // leaves a running row the next service reconciles rather than a silent hold.
    this.store.putQaRun({ ...current, state: "running", pid: null, finishedAt: null, teardownRetryAttempt: attempt });
    const pid = this.spawnQaSupervisor(planPath, identityToken, temporaryDirectory);
    const running = this.store.putQaRun({ ...(this.store.qaRun(run.id) ?? current), pid });
    void this.attachSupervisor(running.id, running.key).catch(() => { /* the watcher records its own fault on the run */ });
    return running;
  }

  /**
   * Apply a teardown retry's outcome to the run record. Only state, exit code,
   * detail, finished time and steps change: the QA step is carried verbatim in
   * `steps`, and the run's base, Queue settlement and duration stay.
   */
  protected applyTeardownRetry(run: ProjectQaRun, outcome: {
    state: ProjectQaRun["state"]; exitCode: number | null; detail: string; finishedAt: string;
    steps: ProjectQaStep[]; failedStep: ProjectQaStepName | null; escapedDescendants: HostRunEscapedDescendant[];
    logWriteErrors?: ProjectQaLogWriteError[];
    checkoutCleanupPending?: boolean;
  }): ProjectQaRun {
    const escapedDescendants = mergeQaEscapees(run.escapedDescendants ?? [], outcome.escapedDescendants ?? []);
    const saved = this.store.putQaRun(projectQaRunSchema.parse({
      ...run, state: outcome.state, exitCode: outcome.exitCode,
      outputTail: tailWithTruncationMarker(outcome.detail, PROJECT_QA_TAIL_BYTES), finishedAt: outcome.finishedAt, pid: null,
      steps: outcome.steps, failedStep: outcome.failedStep, interruptedStep: null, escapedDescendants,
      ...(run.checkoutPath ? { checkoutCleanupPending: outcome.checkoutCleanupPending ?? false } : {}),
      logWriteErrors: mergeLogWriteErrors(run.logWriteErrors, outcome.logWriteErrors),
    }));
    this.releaseRunScratch(saved, Boolean(saved.checkoutCleanupPending));
    return saved;
  }

  /** Apply a settled teardown retry supervisor's durable result to the run record. */
  private settleTeardownRetry(run: ProjectQaRun, state: QaSupervisionState | null): ProjectQaRun {
    const result = state?.result;
    if (!result) return run;
    const current = this.store.qaRun(run.id) ?? run;
    const settled = this.applyTeardownRetry(current, {
      state: result.state, exitCode: result.exitCode, detail: result.detail, finishedAt: result.finishedAt,
      steps: state?.steps ?? current.steps, failedStep: state?.failedStep ?? current.failedStep,
      checkoutCleanupPending: result.checkoutCleanupPending,
      escapedDescendants: state?.escapedDescendants ?? current.escapedDescendants,
      logWriteErrors: state?.logWriteErrors ?? [],
    });
    removeQaSupervisionFiles(this.qaRepositoryRootPath(current.key), current.id, current.teardownRetryAttempt ?? 0);
    return settled;
  }

  private async settleBeforeLaunch(runId: string, reason: string): Promise<ProjectQaRun> {
    const current = this.store.qaRun(runId);
    if (!current) throw new Error(`Project QA run ${runId} disappeared`);
    if (current.state !== "running") {
      removeQaSupervisionFiles(this.qaRepositoryRootPath(current.key), runId);
      this.releaseRunScratch(current, Boolean(current.checkoutCleanupPending));
      return current;
    }
    removeQaSupervisionFiles(this.qaRepositoryRootPath(current.key), runId);
    return this.settle(current, {
      state: "cancelled", exitCode: null, durationMs: Math.max(0, Date.now() - Date.parse(current.startedAt)),
      detail: `QA cancelled: ${reason}`, steps: current.steps, failedStep: current.failedStep,
      finishedAt: now(), interruptedStep: null, hostResult: null, escapedDescendants: [], cancelReason: reason,
    });
  }

  /**
   * Start a milestone QA run, or return the running one when a second request
   * arrives while one is running — including a concurrent one. The claim is
   * one atomic store transaction after the read-only fetch: the fetch never
   * writes, so two callers that fetched together still serialize at the claim
   * and the loser returns the winner's running row. The running record returns
   * immediately; the detached supervisor executes in the background and the
   * store settles when it is done.
   */
  requestStatus(input: { requestId: string } | { repository: string; since: string; expectedHead: string }) {
    const requests = this.store.qaRequestRecords(input).map(record => projectQaRequestSchema.parse(record));
    const runs = "requestId" in input
      ? requests.flatMap(record => { const run = record.runId ? this.store.qaRun(record.runId) : null; return run ? [run] : []; })
      : this.store.qaHistoryForRequest(input);
    if (requests.length > 100 || runs.length > 100) throw new Error("QA request-status exceeds 100 records; narrow the time window or use requestId");
    return { ownerInstance: this.ownerInstance, ownerPid: process.pid, requests, runs };
  }

  async run(input: ProjectQaRunInput | { repository: string; baseBranch?: string; requestId?: string; expectedHead?: string; wait?: boolean }, admissionGuard?: (proposed: ProjectQaRun, selected: ProjectQaRun) => void): Promise<ProjectQaRun> {
    const { wait, ...request } = projectQaRunInputSchema.parse(input);
    const run = await this.requestRun(request, admissionGuard);
    if (!wait) return run;
    let current = run;
    while (current.state === "queued" || current.state === "running") {
      await sleep(250);
      const observed = await this.get({ id: run.id });
      if (!observed) throw new Error(`QA run ${run.id} disappeared while waiting; inspect project.qa.request-status`);
      current = observed;
    }
    let failuresLogPath: string | null = null;
    if (current.failuresLog) {
      const root = this.qaRepositoryRootPath(current.key);
      await mkdir(root, { recursive: true, mode: 0o700 });
      failuresLogPath = join(root, `${current.id}.failures.log`);
      writeAtomicOwnedFile(failuresLogPath, current.failuresLog);
    }
    return { ...current, failuresLogPath };
  }

  private async requestRun(input: ProjectQaRunInput, admissionGuard?: (proposed: ProjectQaRun, selected: ProjectQaRun) => void): Promise<ProjectQaRun> {
    const parsed = projectQaRunInputSchema.parse(input);
    const normalized = projectQaRunInputSchema.parse({ ...parsed, requestId: parsed.requestId ?? randomUUID() });
    const metaKey = `projectQaRequest:${normalized.requestId}`;
    const existing = this.store.transaction(() => {
      const previous = this.store.getMeta<ProjectQaRequest>(metaKey);
      if (!previous) this.store.setMeta(metaKey, projectQaRequestSchema.parse({ id: normalized.requestId, input: normalized,
        ownerInstance: this.ownerInstance, ownerPid: process.pid, receivedAt: now(), state: "preparing", runId: null, diagnostic: "" }));
      return previous;
    });
    if (existing) {
      const { wait: _wait, ...previousInput } = projectQaRunInputSchema.parse(existing.input);
      if (JSON.stringify(previousInput) !== JSON.stringify(normalized)) throw new Error("QA request ID is already bound to different input");
      if (existing.state === "admitted" && existing.runId) {
        const run = this.store.qaRun(existing.runId);
        if (!run) throw new Error("QA request's admitted run is missing; inspect request-status, do not resubmit");
        return run;
      }
      throw new Error(`QA request ${existing.id} is ${existing.state}: ${existing.diagnostic || "preparation delivery unresolved; inspect project.qa.request-status"}`);
    }
    const request = this.store.getMeta<ProjectQaRequest>(metaKey)!;
    try { return await this.admitRequest(normalized, request, admissionGuard); }
    catch (error) {
      // Admission and its request link commit together. Never relabel an admitted
      // run as refused because scheduling or response delivery subsequently failed.
      if (this.store.getMeta<ProjectQaRequest>(metaKey)?.state === "preparing")
        this.store.setMeta(metaKey, { ...request, state: "refused", diagnostic: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async admitRequest(input: ProjectQaRunInput, request: ProjectQaRequest, admissionGuard?: (proposed: ProjectQaRun, selected: ProjectQaRun) => void): Promise<ProjectQaRun> {
    const baseBranch = input.baseBranch || "main";
    const resolved = await this.resolveRepository(input.repository, baseBranch);
    await this.reconcile(resolved.key);
    // Fetch the current integration head before claiming, so a fetch failure
    // refuses without storing a doomed run. Read-only: concurrent callers may
    // repeat it; the claim below stays atomic.
    const base = await this.integrationHead(resolved.checkoutPath, baseBranch);
    if (input.expectedHead && base !== input.expectedHead) throw new Error(`QA integration head differs from expected head: ${base}`);
    const settings = this.store.canonicalRepository(resolved.checkoutPath, resolved.origin);
    // The milestone command is the repository's `qa` setting, never `validation`: that one
    // also runs on every task's prospective merge (project-k planner, 2026-09-30).
    // #121: a staged setting replaces the single argv/timeoutMs; each stage is its
    // own recorded step. A single-argv setting is unchanged: it becomes one "qa" stage.
    const qaSetting = settings?.qa ?? null;
    const stages: ProjectQaStage[] = qaSetting?.stages
      ? qaSetting.stages.map(stage => ({ ...stage, maxOutputBytes: stage.maxOutputBytes ?? qaSetting.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES }))
      : [{ name: "qa", argv: qaSetting?.argv ?? [...DEFAULT_PROJECT_QA_ARGV],
          timeoutMs: qaSetting?.timeoutMs ?? DEFAULT_PROJECT_QA_TIMEOUT_MS,
          maxOutputBytes: qaSetting?.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES }];
    const argv = stages[0].argv;
    // The whole run is admitted once. A staged setting's scheduler envelope must
    // cover the setup hook, every stage's own timeout and the teardown hook, so
    // setup or an earlier stage can never consume a later stage's
    // launch-relative window; each stage's timeout starts when that stage
    // launches. A single-argv setting keeps its record shape unchanged: one
    // stage, its configured timeout as the run timeout.
    const timeoutMs = qaSetting?.stages ? projectQaEnvelopeMs(stages) : stages[0].timeoutMs;
    const maxOutputBytes = qaSetting?.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES;
    const terminationGraceMs = qaSetting?.terminationGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS;
    const id = randomUUID();
    const placement = this.qaPlacement();
    const allocation = placement ? join(placement.dataDir, "project-qa", digest(resolved.key).slice(0, 24), id) : null;
    let storageError: unknown = null;
    if (allocation) { try { placement!.admit(allocation); } catch (error) { storageError = error; } }
    const caller = this.qaCallerIdentity(resolved.key, id);
    const selector = selectorForArgv(argv, "qa");
    // #121: one parent admission covers the whole staged setting in any order,
    // so a later heavy stage is never admitted as a light-only parent. The
    // source names where the class the run actually took came from: a manifest
    // that declared only a lighter stage is not evidence that it selected a
    // heavier run (papercut 65c2883a).
    const classifications = stages.map(stage => {
      const stageSelector = selectorForArgv(stage.argv, "qa");
      return classifyHostRun(resolved.checkoutPath, stageSelector, stageSelector === "test" && stage.argv.length > 2);
    });
    const runClass = classifications.some(entry => entry.runClass === "heavy") ? "heavy" as const : "light" as const;
    const classification = {
      runClass,
      classSource: classifications.some(entry => entry.runClass === runClass && entry.classSource === "manifest")
        ? "manifest" as const : "default" as const,
    };
    const epoch = this.hostRuns.authority().epoch;
    // The supervisor's identity: a random per-run token it carries in its argv,
    // so a recycled pid can never be mistaken for it (task 114 review).
    const identityToken = randomUUID();
    const submittedAt = now();
    const startedAtMs = Date.parse(submittedAt);
    const record = projectQaRunSchema.parse({
      id,
      ...(allocation ? { checkoutPath: allocation } : {}),
      ...(input.submitterAgentId ? { submitterAgentId: input.submitterAgentId } : {}),
      repository: { origin: resolved.origin, path: resolved.path },
      key: resolved.key, state: "queued", baseBranch, base,
      argv, ...(qaSetting?.stages ? { stages } : {}),
      digest: digest(JSON.stringify(qaSetting?.stages ? stages.map(stage => ({ name: stage.name, argv: stage.argv, timeoutMs: stage.timeoutMs })) : argv)),
      exitCode: null, durationMs: 0, outputTail: "", startedAt: submittedAt, submittedAt, finishedAt: null, pid: null,
      terminationGraceMs,
      capacityWait: null, capacityUnavailable: false,
      hostRunEpoch: epoch, selector, runClass: classification.runClass, classSource: classification.classSource,
      priority: "milestone", runTimeoutMs: timeoutMs, maxOutputBytes,
      queuePosition: null,
    });
    const launch: ProjectQaLaunch = { ...resolved, baseBranch, base, argv, stages, timeoutMs, runClass: classification.runClass,
      maxOutputBytes, terminationGraceMs, id, caller, identityToken, startedAtMs, startedAt: submittedAt, epoch };
    const claimed = this.store.transaction(() => {
      const latest = this.store.latestQaRun(resolved.key);
      const selected = latest?.state === "running" || latest?.state === "queued" ? latest : record;
      if (selected === record && storageError) throw storageError;
      admissionGuard?.(record, selected);
      if (input.expectedHead && selected.base !== input.expectedHead) throw new Error(`Existing QA run ${selected.id} is at a different head: ${selected.base}`);
      // Papercut 26636095: the QA admission fence refuses only a NEW run, here,
      // atomically with the claim. Joining an active run creates no work and an
      // accepted request replays before this point, so neither is fenced.
      const fence = selected === record ? this.store.qaFenceInForce() : null;
      if (fence) throw new Error(qaFenceRefusal(fence));
      // The request is admitted only while it is still this runner's own
      // preparation: a settled request can never turn admitted afterwards.
      const persisted = this.store.getMeta<ProjectQaRequest>(`projectQaRequest:${request.id}`);
      if (persisted?.state !== "preparing" || persisted.ownerInstance !== request.ownerInstance)
        throw new Error(`QA request ${request.id} was settled during admission (${persisted?.state ?? "missing"}); no QA run was claimed`);
      if (selected === record) this.store.putQaRun(record);
      this.store.setMeta(`projectQaRequest:${request.id}`, { ...request, state: "admitted", runId: selected.id });
      return selected;
    });
    if (claimed.id !== record.id) {
      if (claimed.state === "queued") this.attachQueued(claimed);
      return claimed;
    }
    this.submitToHostScheduler(record, launch);
    return this.store.qaRun(id)!;
  }

  private schedulerInput(run: ProjectQaRun, launch: ProjectQaLaunch) {
    return {
      id: run.id, epoch: launch.epoch, caller: launch.caller,
      repository: run.repository, selector: run.selector ?? selectorForArgv(run.argv, "qa"),
      runClass: run.runClass ?? "heavy", classSource: run.classSource ?? "default",
      priority: "milestone" as const, runTimeoutMs: run.runTimeoutMs ?? launch.timeoutMs,
      submittedAt: run.submittedAt ?? run.startedAt,
    };
  }

  private handlerFor(run: ProjectQaRun, launch: ProjectQaLaunch): HostRunHandler {
    return {
      launch: async () => {
        let current = this.store.qaRun(run.id);
        if (!current || current.state !== "queued") return;
        if (current.queuePosition !== null || current.capacityWait) {
          current = this.store.putQaRun({ ...current, queuePosition: null, capacityWait: null });
        }
        const gate = this.startSupervised(launch)
          .catch(error => this.settleLaunchFailure(run.id, error))
          .finally(() => { qaGates.delete(run.key); });
        qaGates.set(run.key, gate);
        await gate;
      },
      terminal: hostRun => { void this.onSchedulerTerminal(run.id, hostRun); },
      position: position => {
        const current = this.store.qaRun(run.id);
        if (!current || current.state !== "queued" || current.queuePosition === position) return;
        this.store.putQaRun({ ...current, queuePosition: position, capacityWait: { position, observedAt: now() } });
      },
    };
  }

  private submitToHostScheduler(run: ProjectQaRun, launch: ProjectQaLaunch): void {
    this.hostRuns.submit(this.schedulerInput(run, launch), this.handlerFor(run, launch));
  }

  /** The ordered stages a stored run executes; a row written before #121 is one "qa" stage. */
  protected stagesForRun(run: ProjectQaRun): ProjectQaStage[] {
    return run.stages ?? [{ name: "qa", argv: run.argv,
      timeoutMs: run.runTimeoutMs ?? DEFAULT_PROJECT_QA_TIMEOUT_MS,
      maxOutputBytes: run.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES }];
  }

  private attachQueued(run: ProjectQaRun): void {
    const scheduled = this.hostRuns.get(run.id);
    if (scheduled?.state === "running") {
      const recovered = this.store.putQaRun({ ...run, state: "running", startedAt: scheduled.launchedAt ?? run.startedAt,
        hostRunEpoch: scheduled.epoch, runTimeoutMs: scheduled.runTimeoutMs, queuePosition: null, capacityWait: null });
      void this.reconcile(recovered.key, recovered.id).catch(() => { /* recovery is retried by the next board read */ });
      return;
    }
    const launch: ProjectQaLaunch = {
      key: run.key, origin: run.repository.origin, path: run.repository.path, checkoutPath: run.repository.path,
      baseBranch: run.baseBranch, base: run.base, argv: run.argv, stages: this.stagesForRun(run),
      timeoutMs: run.runTimeoutMs ?? DEFAULT_PROJECT_QA_TIMEOUT_MS,
      runClass: run.runClass ?? "heavy",
      maxOutputBytes: run.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES,
      terminationGraceMs: run.terminationGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS,
      id: run.id, caller: this.qaCallerIdentity(run.key, run.id), identityToken: randomUUID(),
      startedAtMs: Date.parse(run.submittedAt ?? run.startedAt), startedAt: run.submittedAt ?? run.startedAt,
      epoch: run.hostRunEpoch ?? this.hostRuns.authority().epoch,
    };
    const handler = this.handlerFor(run, launch);
    if (scheduled) this.hostRuns.attach(run.id, handler);
    else this.submitToHostScheduler(run, launch);
  }

  protected markLaunched(launch: ProjectQaLaunch): ProjectQaLaunch | null {
    const pending = this.hostRuns.get(launch.id);
    if (!pending || pending.state !== "admitted") return null;
    const active = this.hostRuns.markLaunched(launch.id);
    if (active.state !== "running" || !active.launchedAt) return null;
    const startedAt = active.launchedAt!;
    const startedAtMs = Date.parse(startedAt);
    const current = this.store.qaRun(launch.id);
    if (current && current.state === "queued") this.store.putQaRun({ ...current, state: "running", startedAt,
      submittedAt: current.submittedAt ?? current.startedAt, queuePosition: null, capacityWait: null,
      hostRunEpoch: active.epoch, runTimeoutMs: active.runTimeoutMs });
    return { ...launch, timeoutMs: active.runTimeoutMs, epoch: active.epoch, startedAt, startedAtMs };
  }

  private async onSchedulerTerminal(id: string, hostRun: HostRunInternalRecord): Promise<void> {
    const current = this.store.qaRun(id);
    if (!current || current.state === "passed" || current.state === "failed" || current.state === "hold" || current.state === "timed_out" || current.state === "cancelled" || current.state === "lost") return;
    const settlement = hostRun.settlement;
    if (settlement?.outcome === "capacity_timeout") {
      await this.settle(current, { state: "hold", exitCode: null, durationMs: 0,
        detail: "QA capacity deadline expired before launch; this is a hold, not a QA failure.",
        steps: current.steps, failedStep: current.failedStep, finishedAt: settlement.settledAt,
        interruptedStep: null, hostResult: null, escapedDescendants: [], cancelReason: null });
    } else if (settlement?.outcome === "cancelled" && !settlement.launched) {
      await this.settle(current, { state: "cancelled", exitCode: null, durationMs: 0,
        detail: `QA cancelled before launch${current.cancelReason ? `: ${current.cancelReason}` : ""}.`,
        steps: current.steps, failedStep: current.failedStep, finishedAt: settlement.settledAt,
        interruptedStep: null, hostResult: null, escapedDescendants: [], cancelReason: current.cancelReason });
    } else if (!settlement && hostRun.state === "settled") {
      await this.settleLaunchFailure(id, new Error("Host scheduler could not launch QA"));
    }
  }

  /** Fetch `origin` and read the current integration head. The registered checkout is never written. */
  private async integrationHead(checkoutPath: string, baseBranch: string): Promise<string> {
    const timeoutMs = this.options.fetchTimeoutMs ?? 60_000;
    const commonGitDir = await realpath(await gitText(checkoutPath, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    try {
      await queueGitFetch(commonGitDir, () => withSpawnSlot(async () => {
        const { spawn } = await import("node:child_process");
        return new Promise<{ code: number; stderr: string }>((resolvePromise, reject) => {
          const child = spawn("git", ["fetch", "origin"], { cwd: checkoutPath, env: { ...process.env, ...GIT_ENV } });
          let stderr = "";
          const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("git fetch origin timed out")); }, timeoutMs);
          child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
          child.on("error", error => { clearTimeout(timer); reject(error); });
          child.on("close", code => {
            clearTimeout(timer);
            const result = { code: code ?? -1, stderr };
            if (result.code !== 0) reject(new Error(result.stderr.trim() || `exit ${result.code}`));
            else resolvePromise(result);
          });
        });
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "git fetch origin timed out") throw error;
      throw new Error(`Project QA could not fetch the integration head: ${error instanceof Error ? error.message : String(error)}`);
    }
    try { return await gitText(checkoutPath, "rev-parse", `origin/${baseBranch}`); }
    catch { throw new Error(`Project QA could not read origin/${baseBranch} after fetch`); }
  }

  /** One owner for the layout: the detached supervisor derives the same root from the same key. */
  protected qaRepositoryRootPath(key: string): string {
    return qaRunRootPath(this.isolationDataDir(), key);
  }

  private qaCheckoutPath(key: string, runId: string): string {
    return join(this.qaRepositoryRootPath(key), runId);
  }

  /**
   * The worktree hooks recorded at the run's exact integration head. Reading the
   * manifest at `base` from the registered checkout is the same content the
   * checkout will hold, and lets Queue resolve sibling links before the
   * detached supervisor starts.
   */
  protected async worktreeHooksAt(repositoryPath: string, ref: string): Promise<ProjectQaWorktreeHooks> {
    const present = await gitRaw(repositoryPath, ["cat-file", "-e", `${ref}:paseo.json`]);
    if (present.code !== 0) return { setup: null, teardown: null };
    const shown = await gitRaw(repositoryPath, ["show", `${ref}:paseo.json`]);
    if (shown.code !== 0) throw new Error(`Could not read paseo.json at ${ref}`);
    return parseProjectQaWorktreeHooks(shown.stdout.toString("utf8"));
  }

  /**
   * Resolve every sibling link the run's checkout needs, in the order the
   * repository's own helper reads them: project members, literal relative
   * sources declared by the setup hook's `nucleus worktree prepare` call, and the
   * primary's Effigy dependency-ledger sources. Each source resolves through a
   * configured checkout and is placed beside the checkout before setup starts.
   */
  protected async resolveQaLinks(resolved: ResolvedRepository, setup: string | null): Promise<{ links: { name: string; target: string }[]; skippedProjectMembers: { origin: string | null; path: string; reason: string }[] }> {
    const links = new Map<string, string>();
    const skippedProjectMembers: { origin: string | null; path: string; reason: string }[] = [];
    const addLink = (name: string, target: string) => {
      const previous = links.get(name);
      if (previous && previous !== target) throw new Error(`Project QA sibling link name is ambiguous: ${name}`);
      links.set(name, target);
    };
    const project = this.store.projectFor(resolved.path, resolved.origin);
    for (const member of siblingMembers({ repoPath: resolved.path, repository: resolved.origin }, project)) {
      const missingCheckout = missingSiblingCheckout(member);
      if (missingCheckout) {
        skippedProjectMembers.push({ origin: member.origin, path: member.path, reason: "No local checkout" });
        continue;
      }
      // A project member is already Queue-configured; a member checkout that is
      // itself a linked worktree is still a valid source path, as for a task.
      addLink(siblingNameFor(member), await realpath(member.path));
    }
    for (const spec of worktreeSiblingSpecs(setup)) {
      const source = await resolveSiblingSource(resolved.path, spec.source, this.configuredCheckouts());
      addLink(spec.linkName ?? basename(source), source);
    }
    for (const libraryPath of await dependencyLinkPaths(resolved.path)) {
      const source = await resolveSiblingSource(resolved.path, libraryPath, this.configuredCheckouts());
      addLink(basename(source), source);
    }
    return { links: [...links].map(([name, target]) => ({ name, target })), skippedProjectMembers };
  }

  /** Queue-configured checkouts: registered repositories and project members. */
  private configuredCheckouts(): ConfiguredCheckout[] {
    return [
      ...this.store.repositories().map(row => row.repository),
      ...this.store.projects().flatMap(project => project.repositories),
    ];
  }

  protected async runWorktreeHook(root: string, script: string, terminationGraceMs = DEFAULT_PROCESS_TERMINATION_GRACE_MS,
    options: { env?: Record<string, string>; identityToken?: string; onSpawn?: (pid: number, processGroupId?: number, leaderStartIdentity?: string, startIdentity?: string) => void; cancelReason?: () => string | null } = {}) {
    const env = options.env ?? Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return (this.options.worktreeHookRun ?? executeHookProgram)({
      root, executable: "/bin/sh", argv: ["-lc", script], stdin: Buffer.alloc(0),
      timeoutMs: DEFAULT_PROJECT_QA_TIMEOUT_MS, maxOutputBytes: DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES, overflow: "tail", env,
      terminationGraceMs,
      processStartIdentity: options.identityToken,
      settleOnProcessGroup: true,
      onSpawn: options.onSpawn,
      cancelReason: options.cancelReason,
    });
  }

  /** The path of the detached supervisor entry shipped beside the service. */
  private supervisorEntry(): string {
    return this.options.supervisorEntry ?? fileURLToPath(new URL("../../bin/queue-qa-supervisor.mjs", import.meta.url));
  }

  /** Spawn the detached supervisor for one plan; it owns the run from here. */
  private spawnQaSupervisor(planPath: string, identityToken: string, temporaryDirectory?: string): number {
    const entry = this.supervisorEntry();
    const sourcePath = fileURLToPath(new URL("../..", import.meta.url));
    // The identity token is the last argument so the live process's own command
    // line proves it is this run's supervisor. Overlay the run leaf so the
    // supervisor's own Node/tsx sockets stay off the internal drive.
    const child = spawn(process.execPath, [...runtimeNodeArgs(), entry, planPath, identityToken], {
      detached: true, stdio: "ignore",
      env: { ...process.env, ...withRunTemporaryDirectory({}, temporaryDirectory) },
      cwd: sourcePath,
    });
    child.on("error", () => { /* the run settles as lost when no supervisor appears */ });
    child.unref();
    if (!child.pid) throw new Error("Project QA could not start its detached supervisor");
    return child.pid;
  }

  /**
   * Claim-to-supervisor handoff: read the head's hooks, resolve the sibling
   * links from Queue's records, write the plan and spawn the supervisor, then
   * wait for it to settle. Everything after the claim happens in the
   * supervisor, so a service roll cannot lose a started step.
   */
  protected async startSupervised(launch: ProjectQaLaunch): Promise<ProjectQaRun> {
    const runRoot = this.qaRepositoryRootPath(launch.key);
    const record = this.store.qaRun(launch.id);
    if (!record) throw new Error("Project QA run disappeared before launch");
    this.admitCheckout(record);
    const temporaryDirectory = this.ensureRunScratch(record);
    const { planPath, cancelPath } = qaSupervisionPaths(runRoot, launch.id);
    const hooks = await this.worktreeHooksAt(launch.checkoutPath, launch.base);
    const { links, skippedProjectMembers } = await this.resolveQaLinks(launch, hooks.setup);
    if (skippedProjectMembers.length) {
      const latest = this.store.qaRun(launch.id);
      if (!latest) throw new Error("Project QA run disappeared while recording skipped project members");
      this.store.putQaRun(projectQaRunSchema.parse({ ...latest, skippedProjectMembers }));
    }
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const cancelRequest = readQaCancelRequest(cancelPath, launch.id);
    if (cancelRequest) return this.settleBeforeLaunch(launch.id, cancelRequest.reason);
    const plan = qaSupervisionPlanSchema.parse({
      schema: QA_SUPERVISION_PLAN_SCHEMA, schema_version: QA_SUPERVISION_SCHEMA_VERSION,
      runId: launch.id, key: launch.key, caller: launch.caller, base: launch.base, baseBranch: launch.baseBranch,
      startedAt: launch.startedAt, startedAtMs: launch.startedAtMs,
      checkoutPath: this.checkoutForRun(record), registeredPath: launch.checkoutPath, runRoot,
      ...(record.checkoutPath ? { externalCheckout: true } : {}),
      argv: launch.argv, stages: launch.stages, timeoutMs: launch.timeoutMs, maxOutputBytes: launch.maxOutputBytes,
      epoch: launch.epoch, runClass: launch.runClass, hostRunStateDir: this.hostRunStateDir(),
      terminationGraceMs: launch.terminationGraceMs,
      hookTimeoutMs: DEFAULT_PROJECT_QA_TIMEOUT_MS, hookMaxOutputBytes: DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES,
      identityToken: launch.identityToken,
      links,
      ...(temporaryDirectory ? { temporaryDirectory } : {}),
    });
    writeQaSupervisionPlan(planPath, plan);
    const lateCancel = readQaCancelRequest(cancelPath, launch.id);
    if (lateCancel) {
      removeQaSupervisionFiles(runRoot, launch.id);
      return this.settleBeforeLaunch(launch.id, lateCancel.reason);
    }
    const activeLaunch = this.markLaunched(launch);
    if (!activeLaunch) {
      removeQaSupervisionFiles(runRoot, launch.id);
      const current = this.store.qaRun(launch.id)!;
      this.releaseRunScratch(current, Boolean(current.checkoutCleanupPending));
      return current;
    }
    const activePlan = qaSupervisionPlanSchema.parse({ ...plan, startedAt: activeLaunch.startedAt,
      startedAtMs: activeLaunch.startedAtMs, epoch: activeLaunch.epoch, timeoutMs: activeLaunch.timeoutMs });
    writeQaSupervisionPlan(planPath, activePlan);
    const pid = this.spawnQaSupervisor(planPath, activeLaunch.identityToken, temporaryDirectory);
    const current = this.store.qaRun(activeLaunch.id);
    if (current?.state === "running") this.store.putQaRun({ ...current, pid });
    return this.attachSupervisor(activeLaunch.id, activeLaunch.key);
  }

  /** Attach to a live supervisor and wait for it to settle; concurrent callers share one watcher. */
  private async attachSupervisor(runId: string, key: string, unstartedResumes = 0): Promise<ProjectQaRun> {
    const existing = qaAttachments.get(runId);
    if (existing) { await existing; return this.store.qaRun(runId)!; }
    const watching = this.watchSupervisor(runId, key, unstartedResumes).finally(() => { qaAttachments.delete(runId); });
    qaAttachments.set(runId, watching);
    await watching;
    return this.store.qaRun(runId)!;
  }

  /**
   * Poll one run's supervision file: mirror recorded steps onto the record as
   * they settle, settle the record when the supervisor writes its result, and
   * reconcile as lost the moment the supervisor is proven dead.
   */
  private async watchSupervisor(runId: string, key: string, unstartedResumes = 0): Promise<void> {
    const pollMs = this.options.supervisionPollMs ?? SUPERVISION_POLL_MS;
    for (;;) {
      const current = this.store.qaRun(runId);
      if (!current || current.state !== "running") return;
      const inspection = await this.inspectSupervisor(current);
      if (JSON.stringify(this.store.qaRun(runId)) !== JSON.stringify(current)) continue;
      this.publishCommandLaunchIdentity(current, inspection.state,
        inspection.kind === "settled" ? inspection.hostResult : null);
      if (inspection.kind === "settled") { await this.settleFromSupervisor(current, inspection.state, inspection.hostResult); return; }
      if (inspection.kind === "dead") {
        const recovery = qaRecoveries.get(key);
        if (recovery) { await recovery; return; }
        const settling = this.reconcileLostRun(current, inspection.state, inspection.reason, inspection.escapedDescendants)
          .finally(() => qaRecoveries.delete(key));
        qaRecoveries.set(key, settling);
        await settling;
        return;
      }
      if (inspection.kind === "unstarted") {
        if (unstartedResumes >= 1) {
          await this.reconcileLostRun(current, null, "the supervisor exited before publishing its initial state");
          return;
        }
        // This watcher may itself be the first post-restart observer. One
        // bounded resume handles an initially unreadable process scan; if the
        // new supervisor also exits before publishing state, settle normally.
        const { planPath } = qaSupervisionPaths(this.qaRepositoryRootPath(current.key), current.id);
        const plan = readQaSupervisionPlan(planPath);
        if (!plan || plan.runId !== current.id || plan.key !== current.key) {
          await this.reconcileLostRun(current, null, "the detached supervisor plan is unavailable");
          return;
        }
        const pid = this.spawnQaSupervisor(planPath, plan.identityToken, plan.temporaryDirectory);
        const latest = this.store.qaRun(runId);
        if (latest?.state === "running") this.store.putQaRun({ ...latest, pid });
        unstartedResumes++;
        continue;
      }
      if (inspection.state && (inspection.state.steps.length !== current.steps.length
          || JSON.stringify(inspection.state.logWriteErrors) !== JSON.stringify(current.logWriteErrors))) {
        // #136: a failed progress mirror must not stop supervision. The run keeps
        // its reservation and identity; the next poll retries the mirror.
        try { this.mirrorSupervisorProgress(current, inspection.state); }
        catch { /* a transient store write failure is retried on the next poll */ }
      }
      await sleep(pollMs);
    }
  }

  /** Show a running supervisor's settled steps on the record before the run finishes. */
  private mirrorSupervisorProgress(run: ProjectQaRun, state: QaSupervisionState): void {
    const current = this.store.qaRun(run.id);
    if (!current || current.state !== "running") return;
    this.store.putQaRun({ ...current, steps: state.steps, failedStep: state.failedStep,
      logWriteErrors: state.logWriteErrors,
      escapedDescendants: state.escapedDescendants, cancelReason: state.cancelReason });
  }

  /** Publish the command identity independently of whether a step has settled. */
  private publishCommandLaunchIdentity(run: ProjectQaRun, state: QaSupervisionState | null, hostResult: HostRunResult | null): void {
    const active = state?.activeProcess;
    const identity = active ? { pid: active.pid, processGroupId: active.processGroupId, startIdentity: active.startIdentity }
      : hostResult ? { pid: hostResult.pgid, processGroupId: hostResult.pgid, startIdentity: hostResult.startIdentity } : null;
    if (!identity) return;
    const current = this.hostRuns.get(run.id);
    if (!current || current.state !== "running"
        || current.pid === identity.pid && current.processGroupId === identity.processGroupId && current.startIdentity === identity.startIdentity) return;
    try { this.hostRuns.updateProcess(run.id, identity); }
    catch { /* A settled scheduler row no longer accepts process updates. */ }
  }

  private watchEscapedDescendants(runId: string): void {
    return projectQaEscapees.watchEscapedDescendants.call(this, runId);
  }

  /** Apply the durable host result, then publish its settlement in Queue's run row. */
  private async settleFromSupervisor(run: ProjectQaRun, state: QaSupervisionState | null, hostResult: HostRunResult | null): Promise<ProjectQaRun> {
    const result = state?.result ?? null;
    if (!result && !hostResult) return run;
    if ((run.teardownRetryAttempt ?? 0) > 0) return this.settleTeardownRetry(run, state);
    this.publishCommandLaunchIdentity(run, state, hostResult);
    const { cancelPath } = qaSupervisionPaths(this.qaRepositoryRootPath(run.key), run.id);
    const cancelRequest = readQaCancelRequest(cancelPath, run.id);
    const finalState = result?.state ?? (cancelRequest ? "cancelled" : hostResult?.signal ? "timed_out" : hostResult?.exitCode === 0 ? "passed" : "failed");
    const finishedAt = result?.finishedAt ?? hostResult?.endedAt ?? now();
    const durationMs = result?.durationMs ?? hostResult?.wallMs ?? Math.max(0, Date.parse(finishedAt) - Date.parse(run.startedAt));
    const detail = result?.detail ?? (cancelRequest
      ? `QA cancelled: ${cancelRequest.reason}`
      : hostResult?.signal ? `QA terminated by ${hostResult.signal}.`
        : hostResult?.exitCode === 0 ? "QA passed." : `QA failed with exit ${hostResult?.exitCode}.`);
    const settled = await this.settle(run, {
      state: finalState, exitCode: result?.exitCode ?? hostResult?.exitCode ?? null, durationMs, detail,
      checkoutCleanupPending: result?.checkoutCleanupPending,
      steps: state?.steps ?? run.steps, failedStep: state?.failedStep ?? run.failedStep,
      logWriteErrors: state?.logWriteErrors ?? run.logWriteErrors,
      failuresLog: state?.failuresLog ?? run.failuresLog ?? null,
      failureIndexes: state?.failureIndexes ?? run.failureIndexes,
      finishedAt, interruptedStep: null, hostResult,
      cpuCoverage: qaSupervisionCpuCoverage(run.id, state, hostResult,
        readQaCpuCoverage(qaSupervisionPaths(this.qaRepositoryRootPath(run.key), run.id).cpuCoveragePath)),
      escapedDescendants: hostResult?.escapedDescendants ?? state?.escapedDescendants ?? run.escapedDescendants,
      cancelReason: cancelRequest?.reason ?? state?.cancelReason ?? run.cancelReason,
    });
    this.watchEscapedDescendants(run.id);
    removeQaSupervisionFiles(this.qaRepositoryRootPath(run.key), run.id);
    return settled;
  }

  /** Settle a run whose launch failed before any supervisor step could start. */
  private async settleLaunchFailure(runId: string, error: unknown): Promise<ProjectQaRun | null> {
    const current = this.store.qaRun(runId);
    if (!current || (current.state !== "running" && current.state !== "queued")) return current;
    const scheduled = this.hostRuns.get(runId);
    if (scheduled?.state === "running" && scheduled.launchedAt) {
      // The supervisor may still own a live command. Keep its scheduler
      // reservation and durable plan/state/result files for the next reconcile.
      return current;
    }
    // Hold the QA row first. rejectBeforeLaunch journals a host-run cancelled
    // settlement and fires the terminal handler, which would otherwise race
    // this hold into a cancelled QA state.
    const settled = await this.settle(current, {
      state: "hold", exitCode: null, durationMs: scheduled?.launchedAt ? Math.max(0, Date.now() - Date.parse(scheduled.launchedAt)) : 0,
      detail: `QA checkout or launch failed: ${String(error)}`, steps: current.steps, failedStep: current.failedStep,
      finishedAt: now(), interruptedStep: null, hostResult: null, escapedDescendants: [], cancelReason: current.cancelReason,
    });
    const latestScheduled = this.hostRuns.get(runId);
    if (latestScheduled && (latestScheduled.state === "queued" || latestScheduled.state === "admitted"))
      this.hostRuns.rejectBeforeLaunch(runId, String(error));
    removeQaSupervisionFiles(this.qaRepositoryRootPath(current.key), runId);
    return settled;
  }

  /** Settle the Queue record and scheduler envelope from the supervisor's durable result. */
  protected async settle(run: ProjectQaRun, outcome: QaPipelineOutcome & { interruptedStep: ProjectQaStepName | null }): Promise<ProjectQaRun> {
    let state = outcome.state;
    let detail = outcome.detail;
    const scheduled = this.hostRuns.get(run.id);
    const capacityUnavailable = scheduled?.settlement?.outcome === "capacity_timeout";
    if (capacityUnavailable && state === "failed") {
      state = "hold";
      detail = `QA capacity unavailable: ${detail}`;
    }
    const current = this.store.qaRun(run.id) ?? run;
    const hostResult = outcome.hostResult ?? null;
    const escapedDescendants = outcome.escapedDescendants ?? hostResult?.escapedDescendants ?? current.escapedDescendants;
    const launched = Boolean(scheduled?.launchedAt) || Boolean(hostResult) || state === "lost" || outcome.steps.some(step => Boolean(step.processGroupId));
    const hostOutcome: HostRunSettlement["outcome"] = capacityUnavailable && !launched ? "capacity_timeout"
      : state === "passed" ? "passed"
        : state === "cancelled" ? "cancelled"
          : state === "timed_out" ? "timed_out"
            : state === "lost" ? "lost"
              : "failed";
    let hostSettlement: HostRunSettlement | null = scheduled?.settlement ?? null;
    if (!hostSettlement && !launched && (hostOutcome === "cancelled" || hostOutcome === "capacity_timeout")) {
      hostSettlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: run.id,
        outcome: hostOutcome, launched: false, settledAt: outcome.finishedAt, result: null, containers: [] });
    } else if (!hostSettlement && launched && hostOutcome === "lost") {
      hostSettlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: run.id,
        outcome: "lost", launched: true, settledAt: outcome.finishedAt, result: null, containers: [] });
    } else if (!hostSettlement && launched && hostResult) {
      const normalizedOutcome = state === "hold" ? "failed" : hostOutcome;
      hostSettlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: run.id,
        outcome: normalizedOutcome, launched: true, settledAt: outcome.finishedAt, result: hostResult, containers: [] });
    } else if (!hostSettlement && scheduled?.state === "running") {
      // The Queue supervisor launched, but no result record survived. This is
      // the contract's lost case and cannot be retried from an unknown result.
      hostSettlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: run.id,
        outcome: "lost", launched: true, settledAt: outcome.finishedAt, result: null, containers: [] });
      state = "lost";
    }
    const settled = projectQaRunSchema.parse({
      ...current, state, exitCode: outcome.exitCode, durationMs: outcome.durationMs,
      ...(current.checkoutPath ? { checkoutCleanupPending: outcome.checkoutCleanupPending ?? false } : {}),
      outputTail: tailWithTruncationMarker(detail, PROJECT_QA_TAIL_BYTES), finishedAt: outcome.finishedAt, pid: null,
      capacityWait: null, capacityUnavailable,
      steps: outcome.steps, failedStep: outcome.failedStep, interruptedStep: outcome.interruptedStep,
      failuresLog: outcome.failuresLog ?? current.failuresLog ?? "",
      failureIndexes: outcome.failureIndexes ?? current.failureIndexes,
      logWriteErrors: outcome.logWriteErrors ?? current.logWriteErrors ?? [],
      hostSettlement: hostSettlement ?? current.hostSettlement,
      escapedDescendants,
      cancelReason: outcome.cancelReason ?? current.cancelReason,
    });
    const escapedInResult = hostSettlement?.result?.escapedDescendants ?? [];
    const escapedProvenDead = escapedInResult.length > 0
      && escapedInResult.every(descendant => processStartIdentityLiveness(descendant.pid, descendant.startIdentity) === "dead");
    // A moved integration head is recorded, never a failure: the run proves the
    // exact head it ran, and the operator reruns for the new head.
    try {
      const after = await gitText(current.repository.path, "rev-parse", `origin/${current.baseBranch}`).catch(() => null);
      if (after && after !== current.base) settled.outputTail = tailWithTruncationMarker(`${settled.outputTail}\nIntegration head moved from ${current.base} to ${after} during the run.`, PROJECT_QA_TAIL_BYTES);
    } catch { /* Unknown head is operational silence. */ }
    const latestHostRun = this.hostRuns.get(run.id);
    let saved = settled;
    if (latestHostRun && latestHostRun.state !== "settled" && hostSettlement) {
      this.hostRuns.settle(run.id, hostSettlement, { wallMs: outcome.durationMs, cpuMs: hostResult?.cpuMs ?? null,
        cpuCoverage: hostResult ? boundCpuCoverage(hostResult.cpuMs, outcome.cpuCoverage) : undefined }, () => {
        saved = this.store.putQaRun(settled);
      });
    } else saved = this.store.putQaRun(settled);
    if (escapedInResult.length) {
      if (escapedProvenDead) this.hostRuns.markEscapedDescendantsDead(run.id, escapedInResult);
      else this.watchEscapedDescendants(run.id);
    }
    if (saved.finishedAt && this.options?.notify) {
      // A notice carries news; nothing about sending it may change the settled run.
      let planner: string | undefined;
      try { planner = this.store.projectFor(saved.repository.path, saved.repository.origin)?.planner?.agentId; }
      catch { /* the submitter is still told */ }
      const recipients = [...new Set([planner, saved.submitterAgentId].filter((id): id is string => Boolean(id)))];
      const message = projectQaNotice(saved);
      await Promise.all(recipients.map(agentId => this.options!.notify!(agentId, `project-qa-settled-${saved.id}-${agentId}`, message).catch(() => undefined)));
    }
    this.releaseRunScratch(saved, Boolean(saved.checkoutCleanupPending));
    return saved;
  }

}
