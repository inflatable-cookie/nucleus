import type { ExternalWorkspaceCatalog } from "../host/adapter";
import type { ProcessSearch } from "../machine/process-identity";
import {
  assertCheckoutAvailable,
  assertIntakeWorkspaceAvailable,
  CheckoutRefusalError,
  CheckoutUnavailableError,
  liveCheckoutDataDir,
} from "./checkout-volume";
import { git, gitAncestry, gitBulk, queueCheckoutStatus } from "../git/index";
import { gitFastForward } from "../git/git-command";
import {
  classifyWorkspaceCreation,
  isOwnedWorkspacePath,
  ownedWorkspacePath,
  ownedBbWorkspacePath,
  populateOwnedWorktree,
  removeOrphanCheckout,
  repoCommonDir,
  WORKSPACE_POPULATE_BUDGET_MS,
  workspaceCreationRefusal,
  workspaceDataDirFor,
  type OrphanWorkspace,
  type WorkspaceCreationState,
} from "./workspace-allocation";
import { taskWorkspaceTitle } from "./workspace-title";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Task,
  WorkspaceAllocation,
  WorkspaceProvider,
} from "../../shared/contracts";
import {
  BargeCliError,
  bargeWorktreeLeaseGet,
  bargeWorktreeStatus,
  classifyBargeDispatchError,
} from "./barge-cli";
import {
  chooseWorkspaceProvider,
  createBargeAllocationIntent,
  nextAllocationSequence,
  preserveBargeHeadForReplacement,
  provisionBargeAllocation,
  resolveBargeRepoIdentifier,
  returnBargeAllocation,
  verifyBargeLeaseAndCustody,
} from "./barge-allocator";
import type {
  SaveWorkspaceAllocationOptions,
  WorkspaceAllocationBridge,
} from "./workspace-allocation-bridge";
import {
  externalWorkspace,
  intakeOwnedReviewWorkspace,
  workspaceOutsideQueueAllocation,
} from "../../shared/workspace-ownership";
import type { HostInitLockRule } from "../host/types";
import type {
  HostProjectRef,
  HostWorkspacePlacement,
  HostWorkspaceSpec,
} from "../../shared/host";

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

  private async creationStep<T>(
    task: Task,
    step: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    this.host.workspaceCreationProgress?.(task.id, step, "started");
    try {
      const value = await work();
      this.host.workspaceCreationProgress?.(
        task.id,
        step,
        "finished",
        Date.now() - started,
        "ok",
      );
      return value;
    } catch (error) {
      this.host.workspaceCreationProgress?.(
        task.id,
        step,
        "finished",
        Date.now() - started,
        "failed",
      );
      throw error;
    }
  }
  dataDir() {
    return workspaceDataDirFor(this.host.helperPath);
  }
  /**
   * The placed allocation surface, or null when this machine has none. Whether
   * the data home is the live one is the checkout volume's own answer; deriving
   * it a second time here is how the two proofs drifted apart.
   */
  placement() {
    if (this.host.testPlacement) return this.host.testPlacement;
    const live = liveCheckoutDataDir(this.host.dataDir());
    return live
      ? {
          dataDir: live,
          admit: (path: string) => assertCheckoutAvailable({ target: path }),
          admitIntake: (path: string) =>
            assertIntakeWorkspaceAvailable({ target: path }),
        }
      : null;
  }
  private admitWorkspace(
    placement: WorkspacePlacementFixture,
    task: Task,
    directory: string,
  ): void {
    if (intakeOwnedReviewWorkspace(task))
      (placement.admitIntake ?? placement.admit)(directory);
    else placement.admit(directory);
  }
  /**
   * Every root a recorded checkout may have been allocated under: the placed
   * root, then the retained roots a fixture names. One owner for the list, so
   * the identity proofs below cannot disagree about where Queue allocates.
   */
  private placementRoots(): string[] {
    const placement = this.host.placement();
    if (!placement) return [];
    return [
      placement.dataDir,
      ...(this.host.testPlacement?.retainedDataDirs ?? []),
    ];
  }
  private latestTask(task: Task): Task {
    return this.host.workspaceAllocationBridge?.task?.(task.id) ?? task;
  }
  private providerFor(task: Task): WorkspaceProvider {
    const fresh = this.latestTask(task);
    const bridge = this.host.workspaceAllocationBridge;
    return chooseWorkspaceProvider({
      task: fresh,
      workspaceProviderFor: (target) =>
        bridge?.workspaceProviderFor(target) ?? "local",
    });
  }
  private saveAllocation(
    taskId: string,
    allocation: WorkspaceAllocation,
    options?: SaveWorkspaceAllocationOptions,
  ): void {
    const bridge = this.host.workspaceAllocationBridge;
    if (!bridge) {
      throw new CheckoutRefusalError(
        `Barge workspace provider requires a store allocation bridge for task ${taskId}`,
      );
    }
    bridge.saveWorkspaceAllocation(taskId, allocation, options);
  }
  private async preflightBargeStorage(task: Task): Promise<void> {
    if (task.workspaceAllocation?.leaseId) return;
    const cliOptions = this.host.workspaceAllocationBridge?.bargeCliOptions;
    let pools;
    try {
      const repo = await resolveBargeRepoIdentifier(
        task.repoPath,
        task.repository,
      );
      pools = await bargeWorktreeStatus({ repo }, cliOptions);
    } catch (error) {
      throw classifyBargeDispatchError(error);
    }
    const pool = pools[0];
    if (!pool) {
      throw new CheckoutUnavailableError(
        `No Barge worktree pool configured for ${task.repository ?? task.repoPath}`,
      );
    }
    if (pool.unavailable) {
      throw new CheckoutUnavailableError(pool.unavailable);
    }
    const allBusy =
      pool.roots.length >= pool.max &&
      pool.roots.every((root) => Boolean(root.lease_id || root.held));
    if (allBusy) {
      throw new CheckoutUnavailableError(
        `Barge worktree pool ${pool.pool} is at its maximum of ${pool.max} and no root is free`,
      );
    }
  }
  private async populateBargeTaskWorktree(
    task: Task,
    options: { replace?: boolean; targetHead?: string } = {},
  ): Promise<{
    directory: string;
    populated: boolean;
    budgetMs: number;
    elapsedMs: number;
  }> {
    const started = Date.now();
    const bridge = this.host.workspaceAllocationBridge;
    if (!bridge) {
      throw new CheckoutRefusalError(
        `Barge workspace provider requires a store allocation bridge for task ${task.id}`,
      );
    }
    let fresh = this.latestTask(task);
    const cliOptions = bridge.bargeCliOptions;
    const controlRootDir = bridge.custodianControlRootDir;

    const existing = fresh.workspaceAllocation;
    if (
      !options.replace &&
      existing?.provider === "barge" &&
      existing.state === "leased" &&
      existing.leaseId &&
      existing.checkoutPath
    ) {
      const verified = await verifyBargeLeaseAndCustody({
        allocation: existing,
        saveAllocation: (updated) => this.saveAllocation(fresh.id, updated),
        cliOptions,
      });
      return {
        directory: verified.checkoutPath!,
        populated: false,
        budgetMs: 0,
        elapsedMs: Date.now() - started,
      };
    }

    const unreturnedDisplaced = (
      fresh.resolution?.displacedWorkspaceAllocations ?? []
    ).filter(
      (entry) => entry.provider === "barge" && entry.state !== "returned",
    );
    if (unreturnedDisplaced.length > 0) {
      throw new CheckoutUnavailableError(
        `Waiting for displaced Barge lease ${unreturnedDisplaced[0]!.leaseId ?? unreturnedDisplaced[0]!.allocationId} to return before allocating replacement`,
      );
    }

    if (
      options.replace &&
      existing?.provider === "barge" &&
      existing.state !== "returned"
    ) {
      const expectedHead = options.targetHead;
      if (
        expectedHead &&
        existing.checkoutPath &&
        existsSync(existing.checkoutPath)
      ) {
        await preserveBargeHeadForReplacement({
          repoPath: fresh.repoPath,
          oldCheckoutPath: existing.checkoutPath,
          expectedHead,
        });
      }
      await returnBargeAllocation({
        allocation: existing,
        task: fresh,
        dispositionEvidence: expectedHead ? "host_move_head_preserved" : null,
        saveAllocation: (updated) => {
          fresh = bridge.saveWorkspaceAllocation(fresh.id, updated);
        },
        cliOptions,
      });
      fresh = this.latestTask(fresh);
    }

    const reusableIntent =
      !options.replace &&
      fresh.workspaceAllocation?.provider === "barge" &&
      ["intent", "uncertain"].includes(fresh.workspaceAllocation.state) &&
      Boolean(fresh.workspaceAllocation.requestId)
        ? fresh.workspaceAllocation
        : null;

    let intent: WorkspaceAllocation;
    if (reusableIntent) {
      intent = reusableIntent;
    } else {
      const baseRef =
        options.targetHead ?? fresh.planningBase ?? fresh.baseBranch;
      const baseSha = (await git(fresh.repoPath, "rev-parse", baseRef)).trim();
      const repoIdentifier = await resolveBargeRepoIdentifier(
        fresh.repoPath,
        fresh.repository,
      );
      intent = createBargeAllocationIntent({
        task: fresh,
        sequence: nextAllocationSequence(fresh),
        baseSha,
        repoIdentifier,
      });
      // Persist allocation intent + requestId BEFORE invoking Barge CLI.
      fresh = bridge.saveWorkspaceAllocation(fresh.id, intent, {
        displaceCurrent: Boolean(
          fresh.workspaceAllocation &&
            fresh.workspaceAllocation.allocationId !== intent.allocationId,
        ),
        auditEvent: {
          kind: "barge_allocation_intent",
          detail: `${intent.allocationId} request=${intent.requestId}`,
        },
      });
    }

    const provisioned = await provisionBargeAllocation({
      allocation: intent,
      task: fresh,
      saveAllocation: (updated) => {
        fresh = bridge.saveWorkspaceAllocation(fresh.id, updated);
      },
      cliOptions,
      controlRootDir,
    });
    return {
      directory: provisioned.checkoutPath!,
      populated: true,
      budgetMs: WORKSPACE_POPULATE_BUDGET_MS,
      elapsedMs: Date.now() - started,
    };
  }
  async preflightWorkspaceStorage(task: Task): Promise<void> {
    const fresh = this.latestTask(task);
    if (externalWorkspace(fresh)) return;
    if (this.providerFor(fresh) === "barge") {
      await this.preflightBargeStorage(fresh);
      return;
    }
    const placement = this.host.placement();
    if (!placement) return;
    // External workspaces are not Queue allocations. An intake-owned review
    // workspace is also outside Queue placement, but its own directory still
    // receives volume admission because Nucleus archives its workspace entry.
    if (workspaceOutsideQueueAllocation(fresh)) {
      this.admitWorkspace(placement, fresh, fresh.directory!);
      return;
    }
    const ownedPath = await this.host.ownedPathFor(fresh);
    const common = await repoCommonDir(fresh.repoPath);
    if (!isOwnedWorkspacePath(ownedPath, this.host.dataDir(), common, fresh.id))
      this.admitWorkspace(placement, fresh, ownedPath);
  }
  async ownedPathFor(task: Task): Promise<string> {
    const fresh = this.latestTask(task);
    if (fresh.workspaceAllocation?.provider === "barge") {
      if (
        fresh.workspaceAllocation.checkoutPath &&
        fresh.workspaceAllocation.state !== "returned"
      )
        return fresh.workspaceAllocation.checkoutPath;
      throw new CheckoutUnavailableError(
        `Barge allocation for task ${fresh.id} has no active checkout path`,
      );
    }
    if (workspaceOutsideQueueAllocation(fresh) && fresh.directory)
      return fresh.directory;
    const common = await repoCommonDir(task.repoPath),
      placement = this.host.placement();
    if (
      task.directory &&
      isOwnedWorkspacePath(task.directory, this.host.dataDir(), common, task.id)
    )
      return task.directory;
    if (placement && task.directory) {
      const recorded = this.placementRoots().find((root) =>
        isOwnedWorkspacePath(task.directory!, root, common, task.id),
      );
      if (recorded) return task.directory;
      if (
        !isOwnedWorkspacePath(
          task.directory,
          this.host.dataDir(),
          common,
          task.id,
        )
      )
        throw new Error(
          "Recorded workspace directory is not a Queue allocation",
        );
    }
    return (
      task.hostId?.startsWith("bb:") ? ownedBbWorkspacePath : ownedWorkspacePath
    )(placement?.dataDir ?? this.host.dataDir(), common, task.id);
  }
  async ownedDataDirFor(task: Task, directory: string): Promise<string | null> {
    const common = await repoCommonDir(task.repoPath),
      placement = this.host.placement();
    if (isOwnedWorkspacePath(directory, this.host.dataDir(), common, task.id))
      return this.host.dataDir();
    for (const root of this.placementRoots())
      if (isOwnedWorkspacePath(directory, root, common, task.id)) {
        placement!.admit(directory);
        return root;
      }
    return null;
  }
  private admitObservedWorkspace(
    task: Task,
    common: string,
    directory: string,
  ): void {
    const placement = this.host.placement();
    if (
      placement &&
      intakeOwnedReviewWorkspace(task) &&
      directory === task.directory
    )
      this.admitWorkspace(placement, task, directory);
    else if (
      placement &&
      this.placementRoots().some((root) =>
        isOwnedWorkspacePath(directory, root, common, task.id),
      )
    )
      this.admitWorkspace(placement, task, directory);
  }
  private legacyPaths(task: Task, common: string): string[] {
    return [
      ...new Set(
        [this.host.dataDir(), ...this.placementRoots()].map((root) =>
          ownedWorkspacePath(root, common, task.id),
        ),
      ),
    ];
  }
  /**
   * Only a creation in progress reports steps. A reconciliation's inspection stays silent:
   * a progress write moves the task's version, and the replay it decides fences on that version.
   */
  async inspectWorkspaceCreation(
    task: Task,
    options: {
      skipProcessScan?: boolean;
      skipRemoteCheck?: boolean;
      progress?: boolean;
    } = {},
  ): Promise<WorkspaceCreationState> {
    const fresh = this.latestTask(task);
    if (this.providerFor(fresh) === "barge") {
      const allocation = fresh.workspaceAllocation;
      if (!allocation || allocation.state === "returned") {
        return { kind: "absent" };
      }
      const bridge = this.host.workspaceAllocationBridge;
      const cliOptions = bridge?.bargeCliOptions;
      if (allocation.state === "intent" || allocation.state === "uncertain") {
        if (!allocation.requestId) return { kind: "absent" };
        try {
          const lease = await bargeWorktreeLeaseGet(
            { request: allocation.requestId },
            cliOptions,
          );
          if (lease.state === "returned") return { kind: "absent" };
          if (lease.state !== "leased") {
            return {
              kind: "unknown",
              evidence: `Barge lease ${lease.lease_id} is in state ${lease.state}`,
            };
          }
          if (bridge) {
            bridge.saveWorkspaceAllocation(fresh.id, {
              ...allocation,
              leaseId: lease.lease_id,
              pool: lease.pool,
              rootId: lease.root_id,
              checkoutPath: lease.path,
              state: "leased",
              updatedAt: new Date().toISOString(),
            });
          }
          return { kind: "found_done", directory: lease.path };
        } catch (error) {
          if (error instanceof BargeCliError && error.kind === "not_found")
            return { kind: "absent" };
          return {
            kind: "unknown",
            evidence: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (allocation.state === "leased" && allocation.checkoutPath) {
        const verified = await verifyBargeLeaseAndCustody({
          allocation,
          saveAllocation: bridge
            ? (updated) => {
                bridge.saveWorkspaceAllocation(fresh.id, updated);
              }
            : undefined,
          cliOptions,
          requireHeldCustodian: !options.skipProcessScan,
        });
        return { kind: "found_done", directory: verified.checkoutPath! };
      }
      return {
        kind: "unknown",
        evidence:
          allocation.error ??
          `Barge allocation ${allocation.allocationId} is in state ${allocation.state}`,
      };
    }
    const common = await repoCommonDir(task.repoPath).catch(() => "");
    const placement = this.host.placement();
    const legacyPath =
      common && ownedWorkspacePath(this.host.dataDir(), common, task.id);
    const ownedPath =
      common &&
      (task.directory === legacyPath
        ? legacyPath
        : await this.host.ownedPathFor(task));
    if (!ownedPath)
      return {
        kind: "unknown",
        evidence: `task repository ${task.repoPath} is not a readable Git common dir`,
      };
    if (placement) {
      // An unavailable new root is not proof that an unbound creation is absent.
      try {
        if (ownedPath !== legacyPath)
          this.admitWorkspace(placement, task, ownedPath);
      } catch (error) {
        if (
          error instanceof CheckoutUnavailableError ||
          error instanceof CheckoutRefusalError
        )
          throw error;
        return {
          kind: "unknown",
          evidence: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return classifyWorkspaceCreation({
      task,
      ownedPath,
      legacyPaths: this.legacyPaths(task, common).filter(
        (path) => path !== ownedPath,
      ),
      admitObserved: (directory) =>
        this.admitObservedWorkspace(task, common, directory),
      skipProcessScan: options.skipProcessScan,
      skipRemoteCheck: options.skipRemoteCheck,
      scan: this.host.scanForWorktreeAdd,
      initLock: this.host.initLock,
      step: options.progress
        ? (step, work) =>
            this.creationStep(task, `worktree_inspection_${step}`, work)
        : undefined,
    });
  }
  async populateTaskWorktree(task: Task) {
    const fresh = this.latestTask(task);
    if (fresh.workspaceId && !fresh.proofOnly)
      throw new Error("Workspace already recorded; creation cannot replace it");
    if (this.providerFor(fresh) === "barge") {
      return await this.populateBargeTaskWorktree(fresh);
    }
    if (task.proofOnly) {
      const ownedPath = await this.host.ownedPathFor(task);
      const state = await this.host.inspectWorkspaceCreation(task, {
        progress: true,
      });
      if (state.kind === "found_done")
        return {
          directory: state.directory,
          populated: false,
          budgetMs: 0,
          elapsedMs: 0,
        };
      if (state.kind === "proof_head_mismatch") {
        const placement = this.host.placement();
        const common = await repoCommonDir(task.repoPath);
        return populateOwnedWorktree({
          task,
          ownedPath,
          legacyPaths: this.legacyPaths(task, common),
          admitObserved: (directory) =>
            this.admitObservedWorkspace(task, common, directory),
          admit: placement
            ? () => this.admitWorkspace(placement, task, ownedPath)
            : undefined,
          scan: this.host.scanForWorktreeAdd,
        });
      }
      if (task.workspaceId) throw new Error(workspaceCreationRefusal(state));
    }
    const found = await this.host.findWorkspaces(task);
    if (found.length > 1)
      throw new Error("Ambiguous workspace identity; no new resource created");
    if (found.length === 1)
      return {
        directory: found[0]!.directory,
        populated: false,
        budgetMs: 0,
        elapsedMs: 0,
      };
    const ownedPath = await this.host.ownedPathFor(task);
    const state = await this.host.inspectWorkspaceCreation(task, {
      progress: true,
    });
    if (state.kind === "found_done")
      return {
        directory: state.directory,
        populated: false,
        budgetMs: 0,
        elapsedMs: 0,
      };
    if (state.kind !== "absent")
      throw new Error(workspaceCreationRefusal(state));
    const placement = this.host.placement();
    const common = await repoCommonDir(task.repoPath);
    return populateOwnedWorktree({
      task,
      ownedPath,
      legacyPaths: this.legacyPaths(task, common),
      admitObserved: (directory) =>
        this.admitObservedWorkspace(task, common, directory),
      admit: placement
        ? () => this.admitWorkspace(placement, task, ownedPath)
        : undefined,
      scan: this.host.scanForWorktreeAdd,
    });
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
  private async samePathRegistration(
    task: Task,
    directory: string,
  ): Promise<RegistrationDecision> {
    if (!this.host.externalWorkspaceCatalog) return { kind: "create" };
    const catalog = await this.host.externalWorkspaceCatalog(directory);
    if (!catalog.ok) {
      // An inventory that cannot be read is not a duplicate: creation proceeds
      // exactly as before, so a daemon read failure never blocks dispatch on a
      // guess. The skipped check is on the step trail rather than reported as a
      // check that found nothing.
      this.host.workspaceCreationProgress?.(
        task.id,
        "path_registration_check",
        "skipped",
        0,
      );
      return { kind: "unreadable", reason: catalog.reason };
    }
    const own = task.workspaceId
      ? catalog.entries.find(
          (entry) =>
            entry.workspaceId === task.workspaceId &&
            entry.directory === directory,
        )
      : undefined;
    const aliases = catalog.entries.filter(
      (entry) => entry.workspaceId !== task.workspaceId,
    );
    if (aliases.length)
      throw Error(
        `Workspace registration for ${directory} was not sent: the folder already has workspace registration${aliases.length === 1 ? "" : "s"} ${aliases.map((entry) => entry.workspaceId).join(", ")}, which ${aliases.length === 1 ? "is" : "are"} not this task's. Nucleus never adds a second registration for one folder and never reparents another owner's workspace; inspect the existing registration instead.`,
      );
    return own
      ? {
          kind: "reuse",
          reuse: { id: own.workspaceId, directory: own.directory },
        }
      : { kind: "create" };
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
  async createWorkspace(
    task: Task,
    options: { freshlyPopulated?: boolean } = {},
  ) {
    const fresh = this.latestTask(task);
    // A stable request ID does not prove the daemon will deduplicate a later
    // create. Recover a visible identity before asking Paseo for any resource.
    if (fresh.workspaceId)
      throw new Error("Workspace already recorded; creation cannot replace it");
    if (options.freshlyPopulated)
      this.host.workspaceCreationProgress?.(
        fresh.id,
        "workspace_identity_lookup",
        "skipped",
        0,
      );
    else {
      const found = await this.creationStep(
        fresh,
        "workspace_identity_lookup",
        () => this.host.findWorkspaces(fresh),
      );
      if (found.length > 1)
        throw new Error(
          "Ambiguous workspace identity; no new resource created",
        );
      if (found.length === 1) return found[0]!;
    }
    const state = await this.creationStep(fresh, "worktree_inspection", () =>
      this.host.inspectWorkspaceCreation(fresh, {
        progress: true,
        skipProcessScan: options.freshlyPopulated,
        skipRemoteCheck: options.freshlyPopulated,
      }),
    );
    if (state.kind !== "found_done")
      throw new Error(workspaceCreationRefusal(state));
    const isBarge = fresh.workspaceAllocation?.provider === "barge";
    const placement = this.host.placement();
    const ownedPath = await this.creationStep(fresh, "owned_path_proof", () =>
      this.host.ownedPathFor(fresh),
    );
    if (!isBarge && placement && state.directory === ownedPath)
      this.admitWorkspace(placement, fresh, state.directory);
    const registered = await this.creationStep(
      fresh,
      "path_registration_check",
      () => this.samePathRegistration(fresh, state.directory),
    );
    if (registered.kind === "reuse") return registered.reuse;
    const project = await this.creationStep(
      fresh,
      "repository_project_lookup",
      () => this.repositoryProject(fresh),
    );
    const seq = fresh.workspaceAllocation?.sequence ?? 1;
    const requestId =
      seq > 1 ? `ns-workspace-${fresh.id}-a${seq}` : `ns-workspace-${fresh.id}`;
    const workspace = await this.creationStep(fresh, "workspace_creation", () =>
      this.host.workspaceHost.createWorkspace({
        title: taskWorkspaceTitle(fresh),
        requestId,
        directory: state.directory,
        project,
      }),
    );
    if (!workspace.directory)
      throw new Error("Workspace returned no directory");
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
    const fresh = this.latestTask(task);
    if (fresh.workspaceAllocation?.provider === "barge") {
      throw new Error(
        `Refusing local orphan deletion on Barge-allocated task ${fresh.id}; use Barge return reconciliation`,
      );
    }
    const again = await this.host.inspectOrphanWorkspace(task);
    if (
      !again ||
      again.directory !== orphan.directory ||
      again.head !== orphan.head
    )
      throw new Error("Orphan workspace changed; inspect again");
    const ownedData = orphan.directory
      ? await this.host.ownedDataDirFor(task, orphan.directory)
      : null;
    const ownedPath = ownedData ? orphan.directory : null;
    await removeOrphanCheckout(task, orphan, ownedPath, this.host.initLock);
  }
  /**
   * The published source a worker continuation resumes from: the queue branch on
   * origin, or a surviving local branch that holds newer commits. Two lines with
   * no fast-forward between them are refused, and when no branch exists at all
   * the accepted PR head is the last published source. `head` is the commit the
   * re-created checkout must hold; `local` is the branch ref it is placed from
   * (empty when no local branch survives).
   */
  private async workerSource(
    task: Task,
  ): Promise<{ head: string; local: string }> {
    const local = await git(
      task.repoPath,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${task.branch}`,
    ).catch(() => "");
    // The advertisement is authoritative: the branch a worker pushes is the one
    // recovery reads, and an unreachable origin refuses with the Git cause.
    const advertised = await git(
      task.repoPath,
      "ls-remote",
      "origin",
      `refs/heads/${task.branch}`,
    );
    const remote = advertised.split(/\s+/)[0] ?? "";
    const remoteHead = /^[a-f0-9]{40}$/.test(remote) ? remote : "";
    if (local && remoteHead && local !== remoteHead) {
      // Only a proven "no" is divergence: an ancestry read that failed refuses on
      // its own cause instead of being reported as two divergent lines.
      const remoteNewer = await gitAncestry(task.repoPath, local, remoteHead);
      const localNewer = await gitAncestry(task.repoPath, remoteHead, local);
      if (remoteNewer === "unknown" || localNewer === "unknown")
        throw new Error(
          `The queue branch ${task.branch} ancestry at ${local} and origin ${remoteHead} is unreadable; inspect before recovering the worktree`,
        );
      if (remoteNewer === "diverged" && localNewer === "diverged")
        throw new Error(
          `The queue branch ${task.branch} is at ${local} locally and ${remoteHead} on origin with no fast-forward between them; inspect before recovering the worktree`,
        );
      if (remoteNewer === "ancestor")
        await gitBulk(
          task.repoPath,
          "fetch",
          "origin",
          `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`,
        );
      return { head: remoteNewer === "ancestor" ? remoteHead : local, local };
    }
    if (remoteHead) {
      if (remoteHead !== local)
        await gitBulk(
          task.repoPath,
          "fetch",
          "origin",
          `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`,
        );
      return { head: remoteHead, local };
    }
    // A deleted branch leaves the accepted PR head as the last published source.
    if (!task.prHead)
      throw new Error(
        `Task workspace recovery requires the branch ${task.branch} on origin, or an accepted PR head`,
      );
    await gitBulk(task.repoPath, "fetch", "origin", task.prHead);
    return { head: task.prHead, local: "" };
  }
  /**
   * Re-create the checkout from the recovered source. A local branch at a
   * different commit is never reset: the re-created worktree fast-forwards to
   * the newer published head instead, and a fresh branch is created only when
   * none survives.
   */
  private async checkoutRecoveredBranch(
    task: Task,
    directory: string,
    source: { head: string; local: string },
  ) {
    const args = source.local
      ? [directory, task.branch]
      : ["-b", task.branch, directory, source.head];
    try {
      await gitBulk(task.repoPath, "worktree", "add", ...args);
    } catch (error) {
      // The lost volume can leave the same owned path registered as a missing
      // worktree. Only that stale registration is overridden, and only when the
      // target path itself does not exist; a live checkout is never displaced.
      if (existsSync(directory)) throw error;
      await gitBulk(task.repoPath, "worktree", "add", "--force", ...args);
    }
    if (source.local && source.local !== source.head)
      await gitFastForward(directory, source.head);
  }
  /** The recovered checkout must be clean on the queue branch at the recovered head. */
  private async verifiedRecoveredCheckout(
    task: Task,
    directory: string,
    head: string,
  ) {
    const checkoutHead = await git(directory, "rev-parse", "HEAD");
    const branch = await git(directory, "branch", "--show-current");
    const dirty = await queueCheckoutStatus(directory, "status", "--porcelain");
    if (checkoutHead !== head || branch !== task.branch || dirty)
      throw new Error(
        "Recovered task workspace must be clean at the recorded task head",
      );
    return directory;
  }
  /**
   * Re-create a lost task workspace. The default target is the accepted PR head
   * (the exact source a review continues); `target: 'branch'` reads the queue
   * branch on origin instead, which is what a worker continuation resumes from.
   * A registration whose directory is gone is not a checkout: the worktree is
   * re-created at the owned path instead of rebinding a dead folder.
   */
  async recoverTaskWorkspace(
    task: Task,
    options: { target?: "pr_head" | "branch" } = {},
  ) {
    let fresh = this.latestTask(task);
    const source =
      options.target === "branch"
        ? await this.workerSource(fresh)
        : { head: fresh.prHead ?? "", local: "" };
    if (!source.head)
      throw new Error("Task workspace recovery requires an accepted PR head");
    if (this.providerFor(fresh) === "barge") {
      if (
        fresh.workspaceAllocation?.provider === "barge" &&
        fresh.workspaceAllocation.state === "leased" &&
        fresh.workspaceAllocation.checkoutPath &&
        existsSync(fresh.workspaceAllocation.checkoutPath)
      ) {
        const existingWorkspaces = await this.host.findWorkspaces(fresh);
        const cliOptions = this.host.workspaceAllocationBridge?.bargeCliOptions;
        if (
          existingWorkspaces.length === 1 &&
          existingWorkspaces[0]!.directory ===
            fresh.workspaceAllocation.checkoutPath
        ) {
          const verified = await verifyBargeLeaseAndCustody({
            allocation: fresh.workspaceAllocation,
            saveAllocation: (updated) => this.saveAllocation(fresh.id, updated),
            cliOptions,
          });
          const headOk = await git(
            verified.checkoutPath!,
            "rev-parse",
            "HEAD",
          ).catch(() => "");
          const branchOk = await git(
            verified.checkoutPath!,
            "branch",
            "--show-current",
          ).catch(() => "");
          const dirtyOk = await queueCheckoutStatus(
            verified.checkoutPath!,
            "status",
            "--porcelain",
          ).catch(() => "dirty");
          if (headOk === source.head && branchOk === fresh.branch && !dirtyOk) {
            return {
              ...existingWorkspaces[0]!,
              directory: verified.checkoutPath!,
            };
          }
        }
      }
      const populated = await this.populateBargeTaskWorktree(fresh, {
        replace:
          fresh.workspaceAllocation?.provider === "barge" &&
          fresh.workspaceAllocation.state !== "returned",
        targetHead: source.head,
      });
      fresh = this.latestTask(fresh);
      const directory = populated.directory;
      const seq = fresh.workspaceAllocation?.sequence ?? 1;
      const registered = await this.samePathRegistration(fresh, directory);
      const workspace =
        (registered.kind === "reuse" ? registered.reuse : null) ??
        (await this.host.workspaceHost.createWorkspace({
          title: taskWorkspaceTitle(fresh),
          requestId:
            seq > 1
              ? `ns-recover-workspace-${fresh.id}-a${seq}`
              : `ns-recover-workspace-${fresh.id}`,
          directory,
          project: await this.repositoryProject(fresh),
        }));
      if (!workspace.directory)
        throw new Error("Recovered Barge task workspace returned no directory");
      return {
        id: workspace.id,
        directory: await this.verifiedRecoveredCheckout(
          fresh,
          workspace.directory,
          source.head,
        ),
      };
    }
    const found = await this.host.findWorkspaces(task);
    if (found.length > 1)
      throw new Error("Ambiguous workspace identity; no new resource created");
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
        const admission = this.host.placement();
        if (admission) this.admitWorkspace(admission, task, ownedPath);
        mkdirSync(dirname(ownedPath), { recursive: true, mode: 0o700 });
        if (admission) this.admitWorkspace(admission, task, ownedPath);
        await this.checkoutRecoveredBranch(task, ownedPath, source);
        directory = ownedPath;
      } else throw new Error(workspaceCreationRefusal(state));
      const placement = this.host.placement();
      if (placement && directory === (await this.host.ownedPathFor(task)))
        this.admitWorkspace(placement, task, directory);
      const registered = await this.samePathRegistration(task, directory);
      const workspace =
        (registered.kind === "reuse" ? registered.reuse : null) ??
        (await this.host.workspaceHost.createWorkspace({
          title: taskWorkspaceTitle(task),
          requestId: `ns-recover-workspace-${task.id}`,
          directory,
          project: await this.repositoryProject(task),
        }));
      if (!workspace.directory)
        throw new Error("Recovered task workspace returned no directory");
      return {
        id: workspace.id,
        directory: await this.verifiedRecoveredCheckout(
          task,
          workspace.directory,
          source.head,
        ),
      };
    }
    return {
      ...found[0]!,
      directory: await this.verifiedRecoveredCheckout(
        task,
        directory,
        source.head,
      ),
    };
  }
  async findWorkspaces(task: Task) {
    const entries = await this.host.workspaceHost.workspaceInventory();
    const slug = `ns-${task.id}`;
    const ownedPath = await this.host.ownedPathFor(task).catch(() => null);
    const common = await repoCommonDir(task.repoPath).catch(() => null);
    const legacyPath = common
      ? ownedWorkspacePath(this.host.dataDir(), common, task.id)
      : null;
    // Identity is the exact path this task's allocation derives, or the task's own
    // slug or recorded workspace id inside its repository. A folder whose name
    // merely ends in `ns-<task id>` proves nothing: any other directory can be
    // called that. An external registered workspace is the task's own binding
    // wherever Paseo roots its project, so its recorded id matches as well
    // (nucleus#1261).
    const allocated = [
      ownedPath,
      legacyPath,
      ...(common ? this.legacyPaths(task, common) : []),
    ].filter((path): path is string => Boolean(path));
    const matches = entries
      .filter(
        (w) =>
          allocated.some(
            (path) =>
              w.workspaceDirectory === path || w.projectRootPath === path,
          ) ||
          (w.projectRootPath === task.repoPath &&
            (w.worktreeSlug === slug || w.id === task.workspaceId)) ||
          (workspaceOutsideQueueAllocation(task) && w.id === task.workspaceId),
      )
      .map((w) => ({ id: w.id, directory: w.workspaceDirectory ?? "" }));
    const placement = this.host.placement();
    if (
      placement &&
      ownedPath &&
      matches.some((match) => match.directory === ownedPath)
    )
      this.admitWorkspace(placement, task, ownedPath);
    return matches;
  }
}

/**
 * What one folder's registration inventory answered: this task's own entry to
 * reuse, a create with nothing of this task's registered there, or an inventory
 * Queue could not read. An unreadable inventory is never proof of a duplicate.
 */
type RegistrationDecision =
  | { kind: "reuse"; reuse: { id: string; directory: string } }
  | { kind: "create" }
  | { kind: "unreadable"; reason: string };

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
  /** Durable store bridge for repository provider opt-in and Barge leases. */
  readonly workspaceAllocationBridge?: WorkspaceAllocationBridge;
  /** The engine's durable per-step creation timing hook, set after construction. */
  workspaceCreationProgress?: (
    taskId: string,
    step: string,
    status: "started" | "finished" | "skipped",
    elapsedMs?: number,
    outcome?: "ok" | "failed",
  ) => void;
  /** Still-running or unknown process evidence for a worktree add; a host without one observes none. */
  scanForWorktreeAdd?: (targetPath: string) => ProcessSearch;
  /** Host-supplied initialization lock interpretation; absent on hosts without initialization locks. */
  initLock?: HostInitLockRule | null;
  /** Every catalog registration of one exact folder; absent when the host has no catalog. */
  externalWorkspaceCatalog?(
    directory: string,
  ): Promise<ExternalWorkspaceCatalog>;
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
  inspectWorkspaceCreation(
    task: Task,
    options?: {
      skipProcessScan?: boolean;
      skipRemoteCheck?: boolean;
      progress?: boolean;
    },
  ): Promise<WorkspaceCreationState>;
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
  createWorkspace(
    spec: HostWorkspaceSpec,
  ): Promise<{ id: string; directory: string | null }>;
}

/** A placed allocation surface: where Queue worktrees live and how one is admitted. */
export interface WorkspacePlacementFixture {
  dataDir: string;
  retainedDataDirs?: string[];
  admit: (path: string) => void;
  /** Intake-owned review checkouts use a volume-only path proof outside Queue roots. */
  admitIntake?: (path: string) => void;
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
  readonly placement?: HostWorkspacePlacement | null;
}
