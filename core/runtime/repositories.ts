import { parseAgentId } from "../../shared/agent-identity";
import { qaFenceStatus, writeQaFence } from "../qa/qa-fence";
import type { ProjectQaFenceInput } from "../../shared/contracts";
import { isAbsolute } from "node:path";
import type { Store } from "../store/store";
import type { Engine } from "../engine";
import { repositoryOrigin } from "../planning/lanes";
import { requiredCheckPolicyCapability, type CheckRequirementTransport } from "../forge/index";
import { realpath } from "node:fs/promises";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import type { HostRunAccountingDisposeInput, RepositorySetInput, RepositorySettings, ProjectUpsertInput, Task, RepositoryRekeyInput, RepositoryRekeyOutput, RepositoryRekeyPreviewInput, RepositoryRekeyReceiptQuery, AgentRegisterInput, AgentUnregisterInput } from "../../shared/contracts";
import type { ProjectQaRunner } from '../qa/project-qa';
import type { HostRunScheduler } from '../host-runs/host-run-scheduler';
import { publicHostRunRecord } from '../host-runs/host-run-identity';

/** Narrow dependencies; construction and lifecycle remain runtime-owned. */
export interface RepositoriesContext {
  store: Store;
  engine: Pick<Engine, "adapter" | "startOperation" | "awaitOperation" | "projectOwnerCandidates" | "projectSettings" | "projectAgents"> & {
    resolution: Pick<Engine["resolution"], "projectPlannerRegistered">;
  };
  requiredCheckTransport: CheckRequirementTransport | undefined;
  readonly started: Promise<void>;
  hostRuns: Pick<HostRunScheduler, "list" | "releaseCapacity" | "disposeAccounting" | "accountingStatus" | "accountingList" | "boardState">;
  projectQaRunner(): ProjectQaRunner;
  markStoreAccess(): void;
  plannerChanged?(): Promise<void>;
}

export class RuntimeRepositories {
  constructor(private readonly context: RepositoriesContext) {}

  /**
   * Task 393: `checksPolicy: "required"` is accepted only after GitHub's own
   * requirement surfaces are shown readable for the canonical repository. The
   * read happens before any field of the patch commits; a positive answer only
   * permits the owner's setting and is never cached as merge proof. A checkout
   * whose recorded origin disagrees with the identity this write would use is
   * refused rather than probed or written under a guessed repository.
   */
  private async requireRequiredCheckCapability(identity: { origin: string | null; path: string }, existing: RepositorySettings | null): Promise<void> {
    // Every permanent row that lists this checkout path under a known origin must
    // agree with the origin this write resolves: a reused or re-pointed checkout
    // is not probed, and no row is written, under a repository identity nobody
    // asked for.
    const recorded = new Set<string>();
    if (existing?.repository.origin) recorded.add(existing.repository.origin);
    if (identity.path) for (const row of this.context.store.repositories())
      if (row.repository.origin && row.repository.path === identity.path) recorded.add(row.repository.origin);
    const refusal = (reason: string) => new Error(`checksPolicy "required" refused: ${reason}. Nothing was written`);
    if (identity.origin) {
      const differing = [...recorded].filter(origin => origin !== identity.origin);
      if (differing.length) throw refusal(`repository settings for ${identity.path || identity.origin} record origin ${differing.join(", ")}, but that checkout now reports ${identity.origin}; settle the repository identity first`);
    } else if (recorded.size) {
      throw refusal(`${identity.path || "the named repository"} is recorded under ${[...recorded].join(", ")}, but that checkout now reports no GitHub origin; settle the repository identity first`);
    }
    const origin = identity.origin ?? (recorded.size === 1 ? [...recorded][0] : null);
    if (!origin) throw refusal(`${identity.path || "the named repository"} has no settled GitHub owner/name origin, so GitHub's required checks cannot be observed`);
    const [owner, repository] = origin.split("/");
    const capability = await requiredCheckPolicyCapability({ repoPath: identity.path || existing?.repository.path || process.cwd() } as Task, owner, repository, this.context.requiredCheckTransport);
    if (!capability.supported) throw refusal(`${origin}: ${capability.reason}`);
  }

  /**
   * Spec 022 project settings. The operator names a repository by its absolute
   * local checkout (the origin is resolved from its Git remote) or by its
   * normalised `owner/name` origin alone.
   */
  async setRepository(input: RepositorySetInput) {
    let identity: { origin: string | null; path: string };
    if (isAbsolute(input.repository)) {
      const real = await realpath(input.repository).catch(() => null);
      if (!real) throw new Error(`Project repository path does not exist: ${input.repository}`);
      identity = { origin: await repositoryOrigin(real), path: real };
    } else {
      const origin = normalizeRepositoryOrigin(input.repository);
      if (!origin) throw new Error("Repository must be an absolute checkout path or a normalised owner/name origin");
      identity = { origin, path: "" };
    }
    const { repository: _repository, ...patch } = input;
    if (patch.checksPolicy === "required") {
      // The decision reads the row this patch would update, then proves nothing
      // newer landed while the capability was observed: no await runs inside a
      // transaction and a concurrent settings write is never overwritten.
      const target = this.context.store.repositorySettingsFor(identity);
      await this.requireRequiredCheckCapability(identity, target);
      const current = this.context.store.repositorySettingsFor(identity);
      if (current?.revision !== target?.revision || current?.repository.origin !== target?.repository.origin || current?.repository.path !== target?.repository.path)
        throw new Error(`checksPolicy "required" refused: repository settings for ${identity.origin ?? identity.path} changed while the required-check capability was observed (revision ${target?.revision ?? "none"} to ${current?.revision ?? "none"}). Nothing was written`);
    }
    return this.context.store.patchRepository(identity, patch);
  }

  async getRepository(input: { repository: string }) {
    this.context.markStoreAccess();
    // A path-based get resolves the checkout's current origin and returns the
    // canonical row — the same row closeout reads — so a reused path never
    // answers with another project's row. The path hint applies only when the
    // origin cannot be read; an owner/name origin returns its exact row.
    if (isAbsolute(input.repository)) {
      const real = await realpath(input.repository).catch(() => null);
      if (!real) return this.context.store.repositoryFor(input.repository);
      return this.context.store.canonicalRepository(real, await repositoryOrigin(real));
    }
    const origin = normalizeRepositoryOrigin(input.repository);
    return origin ? this.context.store.repositoryFor(origin) : null;
  }

  listRepositories() { this.context.markStoreAccess(); return this.context.store.repositories(); }

  /**
   * Spec 056: one repository namespace re-key, through the public durable
   * operation envelope. Nothing here touches a checkout, a Git remote or the
   * forge; the operator performs those separately, in the documented order.
   */
  async rekeyRepository(input: RepositoryRekeyInput): Promise<RepositoryRekeyOutput> {
    await this.context.started;
    this.context.markStoreAccess();
    const payload = { type: "repository_rekey" as const, input: { ...input, relayedBy: input.relayedBy ?? null } };
    // A receipt already written for this key means the step committed: this reply
    // replays it and never applies a second time.
    const priorReceipt = this.context.store.repositoryRekeyReceipt({ key: input.idempotencyKey });
    const acceptance = await this.context.engine.startOperation({
      key: `repository-rekey:${input.idempotencyKey}`.slice(0, 200), kind: "repository_rekey", payload,
    });
    if ("backpressured" in acceptance) return acceptance;
    const operation = await this.context.engine.awaitOperation(acceptance.operation.id);
    if (operation.state === "succeeded" && operation.result?.reference) {
      const receipt = this.context.store.repositoryRekeyReceipt({ id: operation.result.reference });
      if (receipt) return { receipt, replayed: Boolean(priorReceipt) };
    }
    if (operation.state === "failed") throw new Error(operation.diagnostic || "Repository re-key failed");
    return { accepted: true, operation };
  }

  /** Spec 056: what a fresh apply would do, read-only; it is never authority to apply drifted input. */
  previewRepositoryRekey(input: RepositoryRekeyPreviewInput) {
    this.context.markStoreAccess();
    return this.context.store.previewRepositoryRekey(input);
  }

  repositoryRekeyReceipt(input: RepositoryRekeyReceiptQuery) {
    this.context.markStoreAccess();
    return this.context.store.repositoryRekeyReceipt(input);
  }

  async runProjectQa(input: { repository: string; baseBranch?: string; requestId?: string; expectedHead?: string; wait?: boolean }) {
    this.context.markStoreAccess();
    return this.context.projectQaRunner().run({ ...input, baseBranch: input.baseBranch ?? "main" });
  }

  async cancelProjectQa(input: { id: string; reason: string }) {
    this.context.markStoreAccess();
    return this.context.projectQaRunner().cancel(input);
  }

  async retryProjectQaTeardown(input: { id: string; reason: string }) {
    this.context.markStoreAccess();
    return this.context.projectQaRunner().retryTeardown(input);
  }

  async dismissProjectQa(input: { id: string; reason: string; caller: string }) {
    this.context.markStoreAccess();
    return this.context.projectQaRunner().dismiss(input);
  }

  async getProjectQa(input: { id: string } | { repository: string }) {
    this.context.markStoreAccess();
    return this.context.projectQaRunner().get(input);
  }

  projectQaRequestStatus(input: { requestId: string } | { repository: string; since: string; expectedHead: string }) { this.context.markStoreAccess(); return this.context.projectQaRunner().requestStatus(input); }

  async listProjectQa() { this.context.markStoreAccess(); return this.context.projectQaRunner().list(); }

  /** Papercut 26636095: the operator's QA admission fence, with the complete unsettled QA inventory. */
  configureQaFence(input: ProjectQaFenceInput) { this.context.markStoreAccess(); return writeQaFence(this.context.store, input); }

  qaFenceStatus() { this.context.markStoreAccess(); return qaFenceStatus(this.context.store); }

  /** Contract 010 `host.run.list`: the pinned strict record, never Queue's internal identity. */
  listHostRuns() { this.context.markStoreAccess(); return this.context.hostRuns.list().map(publicHostRunRecord); }

  releaseHostRunCapacity(input: { runId: string; reason: string }) {
    this.context.markStoreAccess();
    return publicHostRunRecord(this.context.hostRuns.releaseCapacity(input.runId, input.reason));
  }

  /** Spec 035: the operator-only, exact-run accounting disposition (never a settlement). */
  disposeHostRunAccounting(input: HostRunAccountingDisposeInput) {
    this.context.markStoreAccess();
    return this.context.hostRuns.disposeAccounting(input);
  }

  /** Spec 035: the confirmation read for an accounting disposition, and the operator's view of it. */
  hostRunAccountingStatus(input: { runId: string }) {
    this.context.markStoreAccess();
    return this.context.hostRuns.accountingStatus(input.runId);
  }

  /** Spec 035: the board's bounded bulk read of which unsettled runs have retired accounting. */
  hostRunAccountingList() {
    this.context.markStoreAccess();
    return this.context.hostRuns.accountingList();
  }

  /**
   * Audit A8: the board's one combined host-run read. The pinned `host.run.list`
   * record and the accounting answer are derived from the same list call, so the
   * board polls once; both pinned reads remain exactly as they were.
   */
  hostRunBoard() {
    this.context.markStoreAccess();
    const board = this.context.hostRuns.boardState();
    return { runs: board.runs.map(publicHostRunRecord), accounting: board.accounting };
  }

  async upsertProject(input: ProjectUpsertInput) {
    const primaryIndex = input.primary ? input.repositories.findIndex(repo =>
      repo.origin && input.primary!.origin ? normalizeRepositoryOrigin(repo.origin) === normalizeRepositoryOrigin(input.primary!.origin) : Boolean(repo.path && repo.path === input.primary!.path)) : 0;
    if (primaryIndex < 0) throw new Error("Primary repository must belong to the project");
    const repositories = await Promise.all(input.repositories.map(async repo => {
      if (repo.path) {
        if (!isAbsolute(repo.path)) throw new Error("Project repository path hint must be absolute");
        const real = await realpath(repo.path).catch(() => null);
        const origin = real ? await repositoryOrigin(real) : null;
        const declared = repo.origin ? normalizeRepositoryOrigin(repo.origin) : null;
        if (repo.origin && !declared) throw new Error("Project repository origin must be owner/name");
        if (!declared && !real) throw new Error(`Project repository path does not exist: ${repo.path}`);
        if (declared && origin && declared !== origin) throw new Error(`Repository origin does not match ${repo.path}`);
        return { origin: declared ?? origin, path: real ?? repo.path };
      }
      const origin = repo.origin && normalizeRepositoryOrigin(repo.origin);
      if (!origin) throw new Error("Project repository needs an owner/name origin or an absolute checkout path");
      return { origin, path: "" };
    }));
    return this.context.store.upsertProject({ ...input, repositories, primary: input.primary ? repositories[primaryIndex] : undefined });
  }

  async getProject(input: { key: string } | { repository: { origin: string | null; path: string } | string }) {
    this.context.markStoreAccess();
    if ("key" in input) return this.context.store.projectByKey(input.key);
    if (typeof input.repository === "string") throw new Error("Old project.get repository settings call; use repository.get");
    const repo = input.repository;
    return this.context.store.projectFor(repo.path, repo.origin);
  }

  listProjects() { this.context.markStoreAccess(); return this.context.store.projects(); }

  parkProject(input: { key: string; version: number }) { this.context.markStoreAccess(); return this.context.store.setProjectVisibility(input, "parked"); }

  unparkProject(input: { key: string; version: number }) { this.context.markStoreAccess(); return this.context.store.setProjectVisibility(input, "active"); }

  async setProjectPlanner(input: { key: string; agentId: string | null; setBy?: string; note?: string }) {
    this.context.markStoreAccess();
    const setter = input.setBy ? parseAgentId(input.setBy) : null;
    // A thread naming itself keeps its proven host even when the host exposes no environment ID.
    const agentId = setter && input.agentId === setter.nativeAgentId ? input.setBy! : input.agentId;
    const hostId = agentId ? parseAgentId(agentId)?.hostId ?? (this.context.engine.adapter as { hostId?: string }).hostId ?? null : null;
    let project = this.context.store.setProjectPlanner({ key: input.key, agentId, setBy: input.setBy ?? 'operator', note: input.note });
    // Task 1110: the fallback planner is one of the project's registered agents;
    // naming a thread that is not registered yet registers it under the default
    // name, so `to: {project}` and `to: {project, agent}` address the same list.
    if (agentId) project = this.context.store.ensureProjectFallbackAgent({ key: input.key, hostId });
    await this.context.plannerChanged?.();
    if (agentId) void this.context.engine.resolution.projectPlannerRegistered(input.key, agentId).catch(() => {});
    return project;
  }

  /** Task 1110: one project's named, non-task threads with their live state. */
  projectAgents(input: { project: string }) { return this.context.engine.projectAgents(input.project); }

  /**
   * Task 1110: register a named, non-task thread. The calling thread registers
   * itself from its Nucleus ticket (`caller`), or the board names one live thread
   * (`agentId`). The registration is one durable write; the dispatch ticket
   * service then issues and delivers that thread's participant ticket.
   */
  async registerProjectAgent(input: AgentRegisterInput) {
    this.context.markStoreAccess();
    const project = this.context.store.projectByKey(input.project);
    if (!project) throw new Error(`Unknown project ${input.project}`);
    const caller = input.caller ? parseAgentId(input.caller) : null;
    if (input.caller && !caller) throw new Error('agent.register needs the calling thread\'s qualified Nucleus identity, never a typed name');
    const agentId = input.caller ?? input.agentId!;
    const hostId = caller?.hostId ?? parseAgentId(agentId)?.hostId ?? (this.context.engine.adapter as { hostId?: string }).hostId ?? null;
    if (!hostId) throw new Error('Cannot register an agent while no host is connected: the thread\'s host is unknown');
    const registered = this.context.store.registerProjectAgent({
      key: input.project, name: input.name, purpose: input.purpose, agentId, hostId,
      registeredBy: input.caller ?? 'operator (board)', note: input.note,
    });
    await this.context.plannerChanged?.();
    return registered;
  }

  /** Task 1110: remove one named agent; its participant ticket stops resolving. */
  async unregisterProjectAgent(input: AgentUnregisterInput) {
    this.context.markStoreAccess();
    const project = this.context.store.unregisterProjectAgent({
      key: input.project, name: input.name, unregisteredBy: input.caller ?? 'operator (board)', note: input.note,
    });
    await this.context.plannerChanged?.();
    return project;
  }

  projectOwnerCandidates() { this.context.markStoreAccess(); return this.context.engine.projectOwnerCandidates(); }

  projectSettings() { this.context.markStoreAccess(); return this.context.engine.projectSettings(); }

  resetProjectCancellation(input: {key:string;operationId:string;tasks:Array<{taskId:string;version:number}>}) { this.context.markStoreAccess(); return this.context.store.resetProjectCancellation(input); }

  projectManagementPreview(input: {key:string;target?:string}) { this.context.markStoreAccess(); return this.context.store.projectManagementPreview(input); }

  manageRemoveProject(input: import("../../shared/contracts").ProjectManageInput) { this.context.markStoreAccess(); return this.context.store.manageRemoveProject(input); }

  removeProject(input: { key: string; version: number; reason: string }) { this.context.markStoreAccess(); return this.context.store.removeProject(input); }

  removalBlockers(input: { key: string; repository?: string }) { this.context.markStoreAccess(); return this.context.store.removalBlockers(input.key, input.repository); }

  removeProjectRepository(input: import("../../shared/contracts").ProjectRemoveRepositoryInput) { this.context.markStoreAccess(); return this.context.store.removeProjectRepository(input); }

  mergeProject(input: import("../../shared/contracts").ProjectMergeInput) { this.context.markStoreAccess(); return this.context.store.mergeProject(input); }

  mergeCheck(input: import("../../shared/contracts").ProjectMergeCheckInput) { this.context.markStoreAccess(); return this.context.store.mergeCheck(input); }
}
