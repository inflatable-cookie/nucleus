import { dispositionDetail } from "./read-model";
import { existsSync } from "node:fs";
import type { BulkDisposition, BulkDispositionRequest, Task } from "../../../shared/contracts";
import { bulkDispositionSchema, isDispositionActive } from "../../../shared/contracts";
import { digest, now } from "../../store/store";
import { buildOutputCleanupHooks } from "../../workspaces/worktree-cleanup";
import { sharedRepositoryArchiveHold } from "../../workspaces/repository-archive-gate";
import type { Engine } from "../../engine";
import type { DispositionRequest } from "./types";
import { productionDeps } from "./production";
import { recordIntent, recordResult } from "./effects";
import { fenceDisposition, requestDisposition } from "./requests";

/**
 * The operator and batch entry points, wired to the engine. A batch is durable
 * in `bulkDisposition:<id>`; `bulkRunning` only stops one engine running it twice.
 */
export class Dispositions {
  private bulkRunning = new Set<string>();
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  dispositionDeps() {
    return productionDeps({
      store: this.store, hooks: this.engine.hooks,
      hostAvailable: task => this.engine.taskHostAvailable(task),
      withHost: (id, fn) => this.engine.withHost(id, fn),
      observe: (id) => this.engine.host.observe(id),
      retainThreadsUntilCloseout: () => typeof this.adapter.deleteAgent === "function",
      archiveAgent: (id) => this.engine.host.archiveAgent(id),
      archiveWorkspace: async (task, attachedAgentIds) => {
        if (!this.adapter.archiveTaskWorkspace) throw new Error("Workspace cleanup is unavailable; task remains preserved");
        // A shared-project archive waits for the repository to quiesce (nucleus#1139 review).
        const sharedHold = sharedRepositoryArchiveHold(this.adapter, this.store.tasks(), task);
        if (sharedHold) throw new Error(sharedHold);
        const allowed = () => !this.engine.stopped && isDispositionActive(this.store.task(task.id)) && !this.store.runs(task.id).some(run => !run.released)
          && !this.store.hostRunHoldingWorkspace(task.directory!);
        const buildOutputCleanup = buildOutputCleanupHooks(this.store, task.id, task.workspaceId!, task.directory!, allowed, {
          intent: () => {
            const effects = this.store.task(task.id).disposition?.effects.filter(effect => effect.kind === "remove_build_output" && effect.target === task.workspaceId) ?? [];
            if (!effects.at(-1) || effects.at(-1)!.result !== null) recordIntent(this.store, task.id, "remove_build_output", task.workspaceId!);
          },
          observed: result => {
            const effects = this.store.task(task.id).disposition?.effects.filter(effect => effect.kind === "remove_build_output" && effect.target === task.workspaceId) ?? [];
            if (effects.at(-1)?.result === null) recordResult(this.store, task.id, "remove_build_output", task.workspaceId!, result.detail, !result.safe);
          },
          uncertain: reason => recordResult(this.store, task.id, "remove_build_output", task.workspaceId!, `Build output cleanup is uncertain: ${reason}`, true),
        });
        await this.engine.retirement.capture(task.id, task.workspaceId!, task.directory!);
        const archived = Boolean(await this.adapter.archiveTaskWorkspace(task, task.workspaceId!, task.directory!, "", allowed, false, true, attachedAgentIds, true, false, buildOutputCleanup));
        if (archived) await this.engine.retirement.archived(task.id, task.workspaceId!);
        return archived;
      },
      observeWorkspaceArchived: async (task) => {
        if (!this.adapter.taskWorkspaceArchived) throw new Error("Workspace archive observation is unavailable");
        const absent = await this.adapter.taskWorkspaceArchived(task.workspaceId!);
        return absent && Boolean(task.directory) && !existsSync(task.directory!);
      },
      archiveSiblings: (task) => this.engine.removeSiblings(task.id),
      interruptTurn: this.adapter.interruptAndContinue
        ? (agentId, messageId, text) => this.adapter.interruptAndContinue!(agentId, messageId, text)
        : undefined,
    });
  }
  async continueWithdrawnWorker(task: Task): Promise<void> {
    if (!task.agentId || !this.adapter.interruptAndContinue) return;
    if (!this.store.events(task.id).some(event => event.kind === "disposition_turn_interrupted" && event.detail === task.agentId)) return;
    try {
      await this.adapter.interruptAndContinue(task.agentId, `ns-withdraw-${task.id}-${task.version}`,
        "Nucleus: cancellation was withdrawn. Your assignment and authority are unchanged: continue exactly where you left off within your original instructions.");
      this.store.event(task.id, "disposition_withdraw_continued", task.agentId);
    } catch (error) {
      this.store.event(task.id, "disposition_withdraw_continue_failed", error instanceof Error ? error.message : String(error));
    }
  }
  async disposeTask(input: DispositionRequest): Promise<Task> {
    // One operator action: the fence persists before any stop or archive request.
    const result = await this.engine.control(() => requestDisposition(this.store, this.engine.dispositionDeps(), { ...input, requestedBy: "operator control" }), `task:${input.taskId}`);
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(result.repoPath));
    return result;
  }
  private bulkKey(operationId: string) { return `bulkDisposition:${operationId}`; }
  bulkDispositionDetail(operationId: string): BulkDisposition {
    const batch = this.store.getMeta<BulkDisposition>(this.bulkKey(operationId));
    if (!batch) throw new Error("Bulk disposition operation not found");
    return bulkDispositionSchema.parse(batch);
  }
  private saveBulk(batch: BulkDisposition): BulkDisposition {
    const next = bulkDispositionSchema.parse({ ...batch, updatedAt: now() });
    this.store.setMeta(this.bulkKey(batch.operationId), next);
    const ids = this.store.getMeta<string[]>("bulkDispositionIds") ?? [];
    if (!ids.includes(batch.operationId)) this.store.setMeta("bulkDispositionIds", [...ids, batch.operationId].slice(-100));
    return next;
  }
  async startBulkDisposition(input: BulkDispositionRequest, requestedBy = "operator control"): Promise<BulkDisposition> {
    const inputHash = digest(JSON.stringify(input));
    const batch = await this.engine.control(() => {
      if (this.store.getMeta(`bulkDispositionRetired:${input.operationId}`)) throw new Error("This unaccepted cancellation identity was retired; refresh before requesting another batch");
      const refused=this.store.getMeta<{inputHash:string}>(`bulkDispositionRefused:${input.operationId}`);
      if (refused && refused.inputHash!==inputHash) throw new Error("Bulk disposition operation ID already belongs to different input");
      const existing = this.store.getMeta<BulkDisposition>(this.bulkKey(input.operationId));
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error("Bulk disposition operation ID already belongs to different input");
        return existing;
      }
      return this.store.transaction(() => {
        const items = input.tasks.map(item => {
          const task = fenceDisposition(this.store, {
            taskId: item.taskId, version: item.version, action: input.action, reason: input.reason,
            replacementTaskId: input.replacementTaskId, workDisposition: input.workDisposition,
            requestedBy: `bulk ${input.operationId}: ${requestedBy}`,
          });
          return {
            taskId: task.id, initialVersion: item.version, currentVersion: task.version, phase: task.phase,
            status: task.phase === "cancelled" ? "complete" as const : "pending" as const, attempts: 0, error: "",
          };
        });
        const at = now();
        return this.saveBulk({
          operationId: input.operationId, inputHash, status: items.every(item => item.status === "complete") ? "complete" : "pending",
          action: input.action, reason: input.reason, replacementTaskId: input.replacementTaskId ?? null,
          workDisposition: input.workDisposition ?? "archive_if_empty", requestedBy: requestedBy.slice(0, 240),
          createdAt: at, updatedAt: at, items,
        });
      });
    }, "control:bulk").catch(error=>{
      // This callback contains only the local transactional acceptance. No
      // provider work starts until a batch is stored and scheduleBulk follows.
      if (!this.store.getMeta(this.bulkKey(input.operationId)) && !this.store.getMeta(`bulkDispositionRefused:${input.operationId}`))
        this.store.setMeta(`bulkDispositionRefused:${input.operationId}`,{input,inputHash,diagnostic:error instanceof Error?error.message:String(error),at:now()});
      throw error;
    });
    this.engine.scheduleBulk(input.operationId);
    return batch;
  }
  async retryBulkDisposition(operationId: string): Promise<BulkDisposition> {
    const batch = await this.engine.control(() => {
      const current = this.engine.bulkDispositionDetail(operationId);
      if (current.status === "complete") return current;
      return this.saveBulk({ ...current, status: "pending", items: current.items.map(item =>
        item.status === "attention" || item.status === "running" ? { ...item, status: "pending", error: "" } : item) });
    }, "control:bulk");
    this.engine.scheduleBulk(operationId);
    return batch;
  }
  resumeBulkDispositions(): void {
    for (const operationId of this.store.getMeta<string[]>("bulkDispositionIds") ?? []) {
      const batch = this.engine.bulkDispositionDetail(operationId);
      if (batch && batch.status !== "complete") this.engine.scheduleBulk(operationId);
    }
  }
  scheduleBulk(operationId: string): void {
    if (this.engine.stopped || this.bulkRunning.has(operationId)) return;
    this.bulkRunning.add(operationId);
    void this.runBulkDisposition(operationId).catch(error => {
      const batch = this.engine.bulkDispositionDetail(operationId);
      if (batch) this.saveBulk({ ...batch, status: "attention", items: batch.items.map(item =>
        item.status === "running" ? { ...item, status: "attention", error: error instanceof Error ? error.message : String(error) } : item) });
    }).finally(() => { this.bulkRunning.delete(operationId); });
  }
  private async runBulkDisposition(operationId: string): Promise<void> {
    while (!this.engine.stopped) {
      const progressed = await this.engine.control(async () => {
        let batch = this.engine.bulkDispositionDetail(operationId);
        const index = batch.items.findIndex(item => item.status === "pending" || item.status === "running");
        if (index === -1) {
          const status = batch.items.every(item => item.status === "complete") ? "complete" as const : "attention" as const;
          this.saveBulk({ ...batch, status });
          return false;
        }
        const item = batch.items[index];
        const running = { ...item, status: "running" as const, attempts: item.attempts + 1, error: "" };
        batch = this.saveBulk({ ...batch, status: "running", items: batch.items.map((candidate, at) => at === index ? running : candidate) });
        let task: Task;
        try {
          const current = this.store.task(item.taskId);
          task = await requestDisposition(this.store, this.engine.dispositionDeps(), {
            taskId: current.id, version: current.version, action: batch.action, reason: batch.reason,
            replacementTaskId: batch.replacementTaskId ?? undefined, workDisposition: batch.workDisposition,
            requestedBy: `bulk ${operationId}: ${batch.requestedBy}`,
          });
        } catch (error) {
          const current = this.store.task(item.taskId);
          const message = error instanceof Error ? error.message : String(error);
          this.saveBulk({ ...batch, items: batch.items.map((candidate, at) => at === index
            ? { ...running, currentVersion: current.version, phase: current.phase, status: "attention", error: message }
            : candidate) });
          this.store.event(item.taskId, "bulk_disposition_attention", `${operationId}: ${message}`);
          return true;
        }
        const complete = task.phase === "cancelled" && task.disposition?.status === "complete";
        const error = complete ? "" : task.disposition?.attention || task.reason;
        this.saveBulk({ ...batch, items: batch.items.map((candidate, at) => at === index
          ? { ...running, currentVersion: task.version, phase: task.phase, status: complete ? "complete" : "attention", error }
          : candidate) });
        this.store.event(item.taskId, complete ? "bulk_disposition_complete" : "bulk_disposition_attention", `${operationId}: ${complete ? "terminal disposition reached" : error}`);
        return true;
      }, "control:bulk");
      if (!progressed) break;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    void this.engine.wake().catch(() => { /* a failed drain is recorded as engineError */ });
  }
  dispositionDetail(taskId: string) {
    return dispositionDetail(this.store, taskId);
  }
}
