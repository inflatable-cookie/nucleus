/**
 * Task 114: the claim-to-supervisor handoff. Everything after the claim happens
 * in the detached supervisor, so a service roll cannot lose a started step:
 * read the head's worktree hooks, resolve the sibling links from Queue's own
 * records, write the plan, spawn the supervisor and attach to it.
 */
import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeNodeArgs } from "../../shared/runtime.mjs";
import { now, type Store } from "../store/store";
import { projectQaRunSchema, type ProjectQaRun, type ProjectQaStepName } from "../../shared/contracts";
import { executeHookProgram, gitRaw } from "../hooks/hooks";
import { missingSiblingCheckout, siblingMembers, siblingNameFor } from "../workspaces/siblings";
import { dependencyLinkPaths, resolveSiblingSource, worktreeSiblingSpecs, type ConfiguredCheckout } from "../workspaces/worktree-links";
import { withRunTemporaryDirectory } from "../workspaces/run-scratch";
import type { HostRunScheduler } from "../host-runs/host-run-scheduler";
import { DEFAULT_PROCESS_TERMINATION_GRACE_MS } from "../../shared/contracts";
import { DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES, DEFAULT_PROJECT_QA_TIMEOUT_MS } from "./project-qa-defaults";
import {
  QA_SUPERVISION_PLAN_SCHEMA, QA_SUPERVISION_SCHEMA_VERSION, qaSupervisionPaths,
  qaSupervisionPlanSchema, readQaCancelRequest, removeQaSupervisionFiles, writeQaSupervisionPlan,
  type ProjectQaWorktreeHooks,
} from "./project-qa-supervision-files";
import { parseProjectQaWorktreeHooks } from "./project-qa-worktree";
import type { QaPipelineOutcome } from "./project-qa-pipeline";
import type { ProjectQaLaunch, ProjectQaOptions, ResolvedRepository } from "./project-qa-context";

export interface QaLaunchContext {
  store: Store;
  hostRuns: HostRunScheduler;
  options: Pick<ProjectQaOptions, "worktreeHookRun" | "supervisorEntry">;
  hostRunStateDir(): string;
  qaRepositoryRootPath(key: string): string;
  checkoutForRun(run: ProjectQaRun): string;
  admitCheckout(run: ProjectQaRun): void;
  ensureRunScratch(run: ProjectQaRun): string | undefined;
  releaseRunScratch(run: ProjectQaRun, checkoutRetained: boolean): void;
  markLaunched(launch: ProjectQaLaunch): ProjectQaLaunch | null;
  spawnQaSupervisor(planPath: string, identityToken: string, temporaryDirectory?: string): number;
  supervisorEntry(): string;
  worktreeHooksAt(repositoryPath: string, ref: string): Promise<ProjectQaWorktreeHooks>;
  resolveQaLinks(resolved: ResolvedRepository, setup: string | null): Promise<{ links: { name: string; target: string }[]; skippedProjectMembers: { origin: string | null; path: string; reason: string }[] }>;
  configuredCheckouts(): ConfiguredCheckout[];
  attachSupervisor(runId: string, key: string, unstartedResumes?: number): Promise<ProjectQaRun>;
  settleBeforeLaunch(runId: string, reason: string): Promise<ProjectQaRun>;
  startSupervised(launch: ProjectQaLaunch): Promise<ProjectQaRun>;
  settle(run: ProjectQaRun, outcome: QaPipelineOutcome & { interruptedStep: ProjectQaStepName | null }): Promise<ProjectQaRun>;
}

export const projectQaLaunch = {
  /** The path of the detached supervisor entry shipped beside the service. */
  supervisorEntry(this: QaLaunchContext): string {
    return this.options.supervisorEntry ?? fileURLToPath(new URL("../../bin/queue-qa-supervisor.mjs", import.meta.url));
  },

  /** Spawn the detached supervisor for one plan; it owns the run from here. */
  spawnQaSupervisor(this: QaLaunchContext, planPath: string, identityToken: string, temporaryDirectory?: string): number {
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
  },

  /**
   * The worktree hooks recorded at the run's exact integration head. Reading the
   * manifest at `base` from the registered checkout is the same content the
   * checkout will hold, and lets Queue resolve sibling links before the
   * detached supervisor starts.
   */
  async worktreeHooksAt(this: QaLaunchContext, repositoryPath: string, ref: string): Promise<ProjectQaWorktreeHooks> {
    const present = await gitRaw(repositoryPath, ["cat-file", "-e", `${ref}:paseo.json`]);
    if (present.code !== 0) return { setup: null, teardown: null };
    const shown = await gitRaw(repositoryPath, ["show", `${ref}:paseo.json`]);
    if (shown.code !== 0) throw new Error(`Could not read paseo.json at ${ref}`);
    return parseProjectQaWorktreeHooks(shown.stdout.toString("utf8"));
  },

  /**
   * Resolve every sibling link the run's checkout needs, in the order the
   * repository's own helper reads them: project members, literal relative
   * sources declared by the setup hook's `nucleus worktree prepare` call, and the
   * primary's Effigy dependency-ledger sources. Each source resolves through a
   * configured checkout and is placed beside the checkout before setup starts.
   */
  async resolveQaLinks(this: QaLaunchContext, resolved: ResolvedRepository, setup: string | null): Promise<{ links: { name: string; target: string }[]; skippedProjectMembers: { origin: string | null; path: string; reason: string }[] }> {
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
  },

  /** Queue-configured checkouts: registered repositories and project members. */
  configuredCheckouts(this: QaLaunchContext): ConfiguredCheckout[] {
    return [
      ...this.store.repositories().map(row => row.repository),
      ...this.store.projects().flatMap(project => project.repositories),
    ];
  },

  runWorktreeHook(this: QaLaunchContext, root: string, script: string, terminationGraceMs = DEFAULT_PROCESS_TERMINATION_GRACE_MS,
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
  },

  /**
   * Claim-to-supervisor handoff: read the head's hooks, resolve the sibling
   * links from Queue's records, write the plan and spawn the supervisor, then
   * wait for it to settle.
   */
  async startSupervised(this: QaLaunchContext, launch: ProjectQaLaunch): Promise<ProjectQaRun> {
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
  },

  /** Settle a run whose cancel request arrived before the supervisor started. */
  async settleBeforeLaunch(this: QaLaunchContext, runId: string, reason: string): Promise<ProjectQaRun> {
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
  },
};
