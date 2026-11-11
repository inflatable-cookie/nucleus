import type { ExternalWorkspaceCatalog } from "../host/adapter";
import type { ProcessSearch } from "../machine/process-identity";
import { assertCheckoutAvailable, CheckoutRefusalError, CheckoutUnavailableError } from "./checkout-volume";
import { getWorkRoot } from "./work-root.mjs";
import { git, gitBulk, queueCheckoutStatus } from "../git/index";
import { defaultDataDir } from "../../shared/service/default-data-dir";
import {
  classifyWorkspaceCreation, isOwnedWorkspacePath, ownedWorkspacePath, populateOwnedWorktree, removeOrphanCheckout,
  repoCommonDir, sameWorkspacePath, workspaceCreationRefusal, workspaceDataDirFor, type OrphanWorkspace,
  type WorkspaceCreationState,
} from "./workspace-allocation";
import { capPaseoTitle, taskWorkspaceTitle } from "./workspace-title";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Task } from "../../shared/contracts";
import type { HostProjectRef, HostWorkspaceSpec } from "../../shared/host";

/**
 * The workspace lifecycle of one task — storage preflight, populate, creation,
 * orphan inspection and removal, and recovery — as core policy over a host.
 *
 * Step 4 row 1 of the Paseo split map (task 901) moved this out of
 * `host/paseo/paseo.ts`, which held it only because the adapter was the one
 * object core had. What decides is here: the machine path and volume admission,
 * the owned-path proof, the Git checkout, the creation and recovery decisions,
 * and the workspace identity match. What only a host can see stays with it, and
 * core reads it through {@link WorkspaceLifecycleHost}: the daemon's complete
 * workspace inventory, its project lookup and the native registration, the
 * external catalog, the process scan and the creation-progress hook.
 *
 * Every host fact is read at the call that uses it, never captured: a replaced
 * daemon surface, a test's `testPlacement`, a replaced `scanForWorktreeAdd` or a
 * progress hook the engine sets later are all seen by the next call. The policy
 * also reaches the entry points it re-enters through the host
 * (`findWorkspaces`, `inspectWorkspaceCreation`, `inspectOrphanWorkspace`), so an
 * override at the host still governs the whole operation exactly as the
 * adapter's self-calls did before the move.
 *
 * Nothing here awaits differently from the code it replaces, and the moved
 * bodies are token-identical modulo that one receiver rewrite: see
 * `evidence/902/`.
 */
export class WorkspaceLifecycle {
  constructor(private readonly host: WorkspaceLifecycleHost) {}

  private async creationStep<T>(task: Task, step: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.host.workspaceCreationProgress?.(task.id, step, "started");
    try {
      const value = await work();
      this.host.workspaceCreationProgress?.(task.id, step, "finished", Date.now() - started, "ok");
      return value;
    } catch (error) {
      this.host.workspaceCreationProgress?.(task.id, step, "finished", Date.now() - started, "failed");
      throw error;
    }
  }
  dataDir() { return workspaceDataDirFor(this.host.helperPath); }
  placement() {
    if (this.host.testPlacement) return this.host.testPlacement;
    const live = sameWorkspacePath(this.host.dataDir(), defaultDataDir());
    return live ? { dataDir: join(getWorkRoot(), 'queue'), admit: (path:string) => assertCheckoutAvailable({ target: path }) } : null;
  }
  async preflightWorkspaceStorage(task: Task): Promise<void> {
    const placement = this.host.placement();
    if (!placement) return;
    const ownedPath = await this.host.ownedPathFor(task);
    const common = await repoCommonDir(task.repoPath);
    if (!isOwnedWorkspacePath(ownedPath, this.host.dataDir(), common, task.id)) placement.admit(ownedPath);
  }
  async ownedPathFor(task: Task): Promise<string> {
    const common = await repoCommonDir(task.repoPath), placement = this.host.placement();
    if (placement && task.directory) {
      const roots = this.host.testPlacement ? [placement.dataDir, ...(this.host.testPlacement.retainedDataDirs ?? [])] : [join(getWorkRoot(), "queue")];
      const recorded = roots.find(root => isOwnedWorkspacePath(task.directory!, root, common, task.id));
      if (recorded) return task.directory;
      if (!isOwnedWorkspacePath(task.directory, this.host.dataDir(), common, task.id))
        throw new Error("Recorded workspace directory is not a Queue allocation");
    }
    return ownedWorkspacePath(placement?.dataDir ?? this.host.dataDir(), common, task.id);
  }
  async ownedDataDirFor(task: Task, directory: string): Promise<string | null> {
    const common = await repoCommonDir(task.repoPath), placement = this.host.placement();
    if (isOwnedWorkspacePath(directory, this.host.dataDir(), common, task.id)) return this.host.dataDir();
    const roots = placement ? (this.host.testPlacement ? [placement.dataDir, ...(this.host.testPlacement.retainedDataDirs ?? [])] : [join(getWorkRoot(), "queue")]) : [];
    for (const root of roots) if (isOwnedWorkspacePath(directory, root, common, task.id)) {
      placement!.admit(directory);
      return root;
    }
    return null;
  }
  private admitObservedWorkspace(task: Task, common: string, directory: string): void {
    const placement = this.host.placement();
    const roots = placement ? (this.host.testPlacement ? [placement.dataDir, ...(this.host.testPlacement.retainedDataDirs ?? [])] : [join(getWorkRoot(), "queue")]) : [];
    if (roots.some(root => isOwnedWorkspacePath(directory, root, common, task.id))) placement!.admit(directory);
  }
  /**
   * Only a creation in progress reports steps. A reconciliation's inspection stays silent:
   * a progress write moves the task's version, and the replay it decides fences on that version.
   */
  async inspectWorkspaceCreation(task: Task, options: { skipProcessScan?: boolean; skipRemoteCheck?: boolean; progress?: boolean } = {}): Promise<WorkspaceCreationState> {
    const common = await repoCommonDir(task.repoPath).catch(() => "");
    const placement = this.host.placement();
    const legacyPath = common && ownedWorkspacePath(this.host.dataDir(), common, task.id);
    const ownedPath = common && (task.directory === legacyPath ? legacyPath : await this.host.ownedPathFor(task));
    if (!ownedPath) return { kind: "unknown", evidence: `task repository ${task.repoPath} is not a readable Git common dir` };
    if (placement) {
      // An unavailable new root is not proof that an unbound creation is absent.
      try { if (ownedPath !== legacyPath) placement.admit(ownedPath); }
      catch (error) { if (error instanceof CheckoutUnavailableError || error instanceof CheckoutRefusalError) throw error; return { kind: 'unknown', evidence: error instanceof Error ? error.message : String(error) }; }
    }
    return classifyWorkspaceCreation({ task, ownedPath, legacyPaths: placement ? [legacyPath] : [], admitObserved: directory => this.admitObservedWorkspace(task, common, directory),
      skipProcessScan: options.skipProcessScan, skipRemoteCheck: options.skipRemoteCheck, scan: this.host.scanForWorktreeAdd,
      step: options.progress ? (step, work) => this.creationStep(task, `worktree_inspection_${step}`, work) : undefined });
  }
  async populateTaskWorktree(task: Task) {
    if (task.workspaceId && !task.proofOnly) throw new Error("Workspace already recorded; creation cannot replace it");
    if (task.proofOnly) {
      const ownedPath = await this.host.ownedPathFor(task);
      const state = await this.host.inspectWorkspaceCreation(task, { progress: true });
      if (state.kind === 'found_done') return { directory: state.directory, populated: false, budgetMs: 0, elapsedMs: 0 };
      if (state.kind === 'proof_head_mismatch') {
        const placement = this.host.placement();
        const common = await repoCommonDir(task.repoPath);
        return populateOwnedWorktree({ task, ownedPath, legacyPaths: placement ? [ownedWorkspacePath(this.host.dataDir(), common, task.id)] : [],
          admitObserved: directory => this.admitObservedWorkspace(task, common, directory), admit: placement ? () => placement.admit(ownedPath) : undefined, scan: this.host.scanForWorktreeAdd });
      }
      if (task.workspaceId) throw new Error(workspaceCreationRefusal(state));
    }
    const found = await this.host.findWorkspaces(task);
    if (found.length > 1) throw new Error("Ambiguous workspace identity; no new resource created");
    if (found.length === 1) return { directory: found[0]!.directory, populated: false, budgetMs: 0, elapsedMs: 0 };
    const ownedPath = await this.host.ownedPathFor(task);
    const state = await this.host.inspectWorkspaceCreation(task, { progress: true });
    if (state.kind === 'found_done') return { directory: state.directory, populated: false, budgetMs: 0, elapsedMs: 0 };
    if (state.kind !== 'absent') throw new Error(workspaceCreationRefusal(state));
    const placement = this.host.placement();
    const common = await repoCommonDir(task.repoPath);
    return populateOwnedWorktree({ task, ownedPath, legacyPaths: placement ? [ownedWorkspacePath(this.host.dataDir(), common, task.id)] : [],
      admitObserved: directory => this.admitObservedWorkspace(task, common, directory), admit: placement ? () => placement.admit(ownedPath) : undefined, scan: this.host.scanForWorktreeAdd });
  }
  /**
   * Spec 017 (task 494): one folder, one truthful registration.
   *
   * A folder can carry several Paseo catalog registrations — two projects may
   * root the same checkout, and a human's own "Video template review" entry can
   * sit beside the task's source. Queue does not merge or reparent those: the
   * registration belongs to whoever made it. What Queue must never do is *add*
   * to the pile, or silently take over somebody else's entry, when it registers
   * the checkout it is itself about to bind.
   *
   * The complete inventory at this exact folder decides. A positively listed
   * registration that is not this task's refuses the create with every alias
   * named, and nothing is sent. The task's own recorded registration at the
   * folder is returned for reuse instead of a second entry. An inventory that
   * cannot be read is not a duplicate: creation proceeds exactly as before, so a
   * daemon read failure never blocks dispatch on a guess.
   */
  private async samePathRegistration(task: Task, directory: string): Promise<{ reuse: { id: string; directory: string } } | null> {
    if (!this.host.externalWorkspaceCatalog) return null;
    const catalog = await this.host.externalWorkspaceCatalog(directory);
    if (!catalog.ok) return null;
    const own = task.workspaceId ? catalog.entries.find(entry => entry.workspaceId === task.workspaceId && entry.directory === directory) : undefined;
    const aliases = catalog.entries.filter(entry => entry.workspaceId !== task.workspaceId);
    if (aliases.length)
      throw Error(`Workspace registration for ${directory} was not sent: the folder already has workspace registration${aliases.length === 1 ? '' : 's'} ${aliases.map(entry => entry.workspaceId).join(', ')}, which ${aliases.length === 1 ? 'is' : 'are'} not this task's. Nucleus never adds a second registration for one folder and never reparents another owner's workspace; inspect the existing registration instead.`);
    return own ? { reuse: { id: own.workspaceId, directory: own.directory } } : null;
  }
  /**
   * The host project rooted at the task's repository, read through the host.
   * Without it, a directory workspace becomes its own project named after the
   * worktree folder (Paseo's findOrCreateProjectForDirectory). If no active
   * project is rooted there, the fallback keeps today's behaviour.
   */
  private repositoryProject(task: Task) {
    return this.host.workspaceHost.repositoryProject(task.repoPath);
  }
  async createWorkspace(task: Task, options: { freshlyPopulated?: boolean } = {}) {
    // A stable request ID does not prove the daemon will deduplicate a later
    // create. Recover a visible identity before asking Paseo for any resource.
    if (task.workspaceId) throw new Error("Workspace already recorded; creation cannot replace it");
    if (options.freshlyPopulated) this.host.workspaceCreationProgress?.(task.id, "workspace_identity_lookup", "skipped", 0);
    else {
      const found = await this.creationStep(task, "workspace_identity_lookup", () => this.host.findWorkspaces(task));
      if (found.length > 1) throw new Error("Ambiguous workspace identity; no new resource created");
      if (found.length === 1) return found[0]!;
    }
    const state = await this.creationStep(task, "worktree_inspection", () => this.host.inspectWorkspaceCreation(task, {
      progress: true,
      skipProcessScan: options.freshlyPopulated,
      skipRemoteCheck: options.freshlyPopulated,
    }));
    if (state.kind !== "found_done") throw new Error(workspaceCreationRefusal(state));
    const placement = this.host.placement();
    const ownedPath = await this.creationStep(task, "owned_path_proof", () => this.host.ownedPathFor(task));
    if (placement && state.directory === ownedPath) placement.admit(state.directory);
    const registered = await this.creationStep(task, "path_registration_check", () => this.samePathRegistration(task, state.directory));
    if (registered) return registered.reuse;
    const project = await this.creationStep(task, "repository_project_lookup", () => this.repositoryProject(task));
    const workspace = await this.creationStep(task, "paseo_workspace_create", () => this.host.workspaceHost.createWorkspace({ title: capPaseoTitle(taskWorkspaceTitle(task)), requestId: `ns-workspace-${task.id}`,
      directory: state.directory, project }));
    if (!workspace.directory) throw new Error("Workspace returned no directory");
    return { id: workspace.id, directory: workspace.directory };
  }
  /**
   * Null means nothing of this task's remains: replay is safe. A leftover that is
   * a Queue-owned or Paseo-initializing unpublished populate, or an unpublished
   * base-identical branch, is returned as an orphan. Found-done, still-running,
   * unknown, authored or published leftovers throw, because a replay would
   * collide and suffix.
   */
  async inspectOrphanWorkspace(task: Task): Promise<OrphanWorkspace | null> {
    const state = await this.host.inspectWorkspaceCreation(task);
    if (state.kind === "absent") return null;
    if (state.kind === "partial") return state.orphan;
    throw new Error(workspaceCreationRefusal(state));
  }
  async removeOrphanWorkspace(task: Task, orphan: OrphanWorkspace) {
    const again = await this.host.inspectOrphanWorkspace(task);
    if (!again || again.directory !== orphan.directory || again.head !== orphan.head) throw new Error("Orphan workspace changed; inspect again");
    const ownedData = orphan.directory ? await this.host.ownedDataDirFor(task, orphan.directory) : null;
    const ownedPath = ownedData ? ownedWorkspacePath(ownedData, await repoCommonDir(task.repoPath), task.id) : null;
    await removeOrphanCheckout(task, orphan, ownedPath);
  }
  /**
   * The published source a worker continuation resumes from: the queue branch on
   * origin, or a surviving local branch that holds newer commits. Two lines with
   * no fast-forward between them are refused, and when no branch exists at all
   * the accepted PR head is the last published source. `head` is the commit the
   * re-created checkout must hold; `local` is the branch ref it is placed from
   * (empty when no local branch survives).
   */
  private async workerSource(task: Task): Promise<{ head: string; local: string }> {
    const local = await git(task.repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}`).catch(() => "");
    // The advertisement is authoritative: the branch a worker pushes is the one
    // recovery reads, and an unreachable origin refuses with the Git cause.
    const advertised = await git(task.repoPath, "ls-remote", "origin", `refs/heads/${task.branch}`);
    const remote = advertised.split(/\s+/)[0] ?? "";
    const remoteHead = /^[a-f0-9]{40}$/.test(remote) ? remote : "";
    if (local && remoteHead && local !== remoteHead) {
      const remoteNewer = await git(task.repoPath, "merge-base", "--is-ancestor", local, remoteHead).then(() => true).catch(() => false);
      const localNewer = await git(task.repoPath, "merge-base", "--is-ancestor", remoteHead, local).then(() => true).catch(() => false);
      if (!remoteNewer && !localNewer)
        throw new Error(`The queue branch ${task.branch} is at ${local} locally and ${remoteHead} on origin with no fast-forward between them; inspect before recovering the worktree`);
      if (remoteNewer) await gitBulk(task.repoPath, "fetch", "origin", `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`);
      return { head: remoteNewer ? remoteHead : local, local };
    }
    if (remoteHead) {
      if (remoteHead !== local) await gitBulk(task.repoPath, "fetch", "origin", `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`);
      return { head: remoteHead, local };
    }
    // A deleted branch leaves the accepted PR head as the last published source.
    if (!task.prHead)
      throw new Error(`Task workspace recovery requires the branch ${task.branch} on origin, or an accepted PR head`);
    await gitBulk(task.repoPath, "fetch", "origin", task.prHead);
    return { head: task.prHead, local: "" };
  }
  /**
   * Re-create the checkout from the recovered source. A local branch at a
   * different commit is never reset: the re-created worktree fast-forwards to
   * the newer published head instead, and a fresh branch is created only when
   * none survives.
   */
  private async checkoutRecoveredBranch(task: Task, directory: string, source: { head: string; local: string }) {
    const args = source.local ? [directory, task.branch] : ["-b", task.branch, directory, source.head];
    try { await gitBulk(task.repoPath, "worktree", "add", ...args); }
    catch (error) {
      // The lost volume can leave the same owned path registered as a missing
      // worktree. Only that stale registration is overridden, and only when the
      // target path itself does not exist; a live checkout is never displaced.
      if (existsSync(directory)) throw error;
      await gitBulk(task.repoPath, "worktree", "add", "--force", ...args);
    }
    if (source.local && source.local !== source.head) await gitBulk(directory, "merge", "--ff-only", source.head);
  }
  /** The recovered checkout must be clean on the queue branch at the recovered head. */
  private async verifiedRecoveredCheckout(task: Task, directory: string, head: string) {
    const checkoutHead = await git(directory, "rev-parse", "HEAD");
    const branch = await git(directory, "branch", "--show-current");
    const dirty = await queueCheckoutStatus(directory, "status", "--porcelain");
    if (checkoutHead !== head || branch !== task.branch || dirty) throw new Error("Recovered task workspace must be clean at the recorded task head");
    return directory;
  }
  /**
   * Re-create a lost task workspace. The default target is the accepted PR head
   * (the exact source a review continues); `target: 'branch'` reads the queue
   * branch on origin instead, which is what a worker continuation resumes from.
   * A registration whose directory is gone is not a checkout: the worktree is
   * re-created at the owned path instead of rebinding a dead folder.
   */
  async recoverTaskWorkspace(task: Task, options: { target?: "pr_head" | "branch" } = {}) {
    const source = options.target === "branch" ? await this.workerSource(task) : { head: task.prHead ?? "", local: "" };
    if (!source.head) throw new Error("Task workspace recovery requires an accepted PR head");
    const found = await this.host.findWorkspaces(task);
    if (found.length > 1) throw new Error("Ambiguous workspace identity; no new resource created");
    const known = found[0]?.directory;
    let directory = known && existsSync(known) ? known : undefined;
    if (!directory) {
      const state = await this.host.inspectWorkspaceCreation(task);
      // A positive creation inspection proves the checkout itself (it reads the
      // worktree list and the directory); only the raw registration inventory can
      // name a folder that is gone.
      if (state.kind === "found_done") directory = state.directory;
      else if (state.kind === "absent") {
        const ownedPath = await this.host.ownedPathFor(task);
        this.host.placement()?.admit(ownedPath);
        mkdirSync(dirname(ownedPath), { recursive: true, mode: 0o700 });
        this.host.placement()?.admit(ownedPath);
        await this.checkoutRecoveredBranch(task, ownedPath, source);
        directory = ownedPath;
      } else throw new Error(workspaceCreationRefusal(state));
      const placement = this.host.placement();
      if (placement && directory === await this.host.ownedPathFor(task)) placement.admit(directory);
      const workspace = (await this.samePathRegistration(task, directory))?.reuse
        ?? await this.host.workspaceHost.createWorkspace({ title: capPaseoTitle(taskWorkspaceTitle(task)), requestId: `ns-recover-workspace-${task.id}`,
          directory, project: await this.repositoryProject(task) });
      if (!workspace.directory) throw new Error("Recovered task workspace returned no directory");
      return { id: workspace.id, directory: await this.verifiedRecoveredCheckout(task, workspace.directory, source.head) };
    }
    return { ...found[0]!, directory: await this.verifiedRecoveredCheckout(task, directory, source.head) };
  }
  async findWorkspaces(task: Task) {
    const entries = await this.host.workspaceHost.workspaceInventory();
    const slug = `ns-${task.id}`;
    const ownedPath = await this.host.ownedPathFor(task).catch(() => null);
    const common = await repoCommonDir(task.repoPath).catch(() => null);
    const legacyPath = common ? ownedWorkspacePath(this.host.dataDir(), common, task.id) : null;
    const matches = entries.filter(w => {
      const directory = w.workspaceDirectory ?? "";
      if (w.projectRootPath === task.repoPath && (w.worktreeSlug === slug || w.id === task.workspaceId)) return true;
      if ([ownedPath, legacyPath].some(path => path && (directory === path || w.projectRootPath === path)))
        return w.worktreeSlug === slug || w.id === task.workspaceId || directory.split("/").at(-1) === slug || w.projectRootPath.split("/").at(-1) === slug;
      return false;
    }).map(w => ({ id: w.id, directory: w.workspaceDirectory ?? "" }));
    const placement = this.host.placement();
    if (placement && ownedPath && matches.some(match => match.directory === ownedPath)) placement.admit(ownedPath);
    return matches;
  }
}

/**
 * What the workspace lifecycle reads from the host it runs on. The Paseo adapter
 * supplies it as `this`; nothing here is a Paseo type, and every member is read
 * at the call that uses it.
 */
export interface WorkspaceLifecycleHost {
  /** The Queue data home the machine placement and the owned path derive from. */
  readonly helperPath: string;
  /** The placed allocation surface a fixture supplies instead of the live volume policy. */
  readonly testPlacement?: WorkspacePlacementFixture;
  /** The engine's durable per-step creation timing hook, set after construction. */
  workspaceCreationProgress?: (taskId: string, step: string, status: "started" | "finished" | "skipped", elapsedMs?: number, outcome?: "ok" | "failed") => void;
  /** Still-running or unknown process evidence for a worktree add; a host without one observes none. */
  scanForWorktreeAdd?: (targetPath: string) => ProcessSearch;
  /** Every catalog registration of one exact folder; absent when the host has no catalog. */
  externalWorkspaceCatalog?(directory: string): Promise<ExternalWorkspaceCatalog>;
  /** The host's native workspace calls: complete inventory, project lookup and registration. */
  readonly workspaceHost: WorkspaceHostCalls;
  /**
   * The core entry points and machine facts this policy re-enters, so an override
   * on the adapter still governs the whole operation exactly as the adapter's own
   * self-calls did: every internal call to one of these goes through the host.
   */
  dataDir(): string;
  placement(): WorkspacePlacement;
  ownedPathFor(task: Task): Promise<string>;
  ownedDataDirFor(task: Task, directory: string): Promise<string | null>;
  findWorkspaces(task: Task): Promise<{ id: string; directory: string }[]>;
  inspectWorkspaceCreation(task: Task, options?: { skipProcessScan?: boolean; skipRemoteCheck?: boolean; progress?: boolean }): Promise<WorkspaceCreationState>;
  inspectOrphanWorkspace(task: Task): Promise<OrphanWorkspace | null>;
}

/** The placed allocation surface, or null when this machine has none. */
export type WorkspacePlacement = WorkspacePlacementFixture | null;

/** The native workspace calls core makes: each returns the host's own answer, unmapped. */
export interface WorkspaceHostCalls {
  /** The complete active inventory, paged to its end by the host. */
  workspaceInventory(): Promise<WorkspaceInventoryEntry[]>;
  /** The host project rooted at a repository; `{}` when the host reports none. */
  repositoryProject(projectRoot: string): Promise<HostProjectRef>;
  /** The native registration of one folder; a missing directory is the host's own answer. */
  createWorkspace(spec: HostWorkspaceSpec): Promise<{ id: string; directory: string | null }>;
}

/** A placed allocation surface: where Queue worktrees live and how one is admitted. */
export interface WorkspacePlacementFixture {
  dataDir: string;
  retainedDataDirs?: string[];
  admit: (path: string) => void;
}

/**
 * One registration a host lists, as the identity match reads it. The Paseo host's
 * native entry carries more (`labels`); a fact a host does not report is absent
 * here, never invented.
 */
export interface WorkspaceInventoryEntry {
  readonly id: string;
  readonly projectRootPath: string;
  readonly workspaceDirectory?: string | null;
  readonly worktreeSlug?: string | null;
}
