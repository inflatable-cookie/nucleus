import type { Task } from "../../shared/contracts";
import { hostUnavailableDetail } from "../../shared/host-outage";
import type { Adapter } from "../host/adapter";
import type { Admission } from "../host/admission";
import type { Store } from "../store/store";
import { occupiesSlot } from "./capacity";
import { PROFILE_CATALOG_PENDING_REASON } from "../recovery/task-reasons";
import { reviewContinuationLimit } from "../review/review-continuation";

/** Live reads used by queued dispatch admission; no engine lifecycle authority. */
export interface DispatchAdmissionContext {
  store(): Store;
  adapter(): Pick<Adapter, "hostLoad">;
  admission(): Pick<Admission, "workspaceAdmissionReason"> | null;
  profileCatalogKnown(): boolean;
  withHost<T>(id: string, fn: () => T): T;
  hostAvailable(id: string): boolean;
  workspacePressureWait(task: Task): string;
  hostIds(): readonly string[];
  /** The open outage the host's own record names, when one exists. */
  hostOutageSince(id: string): string | null;
  firstWorkerUnbound(task: Task): boolean;
  targetHostWait(task: Task): string | null;
  /** Hosts online with a read catalog that could take a first worker. */
  workerHostIds(task: { hostId?: string | null }): string[];
}

/** The host-wait sentence a queued task reads with a `host_unavailable` stop. */
export const QUEUED_HOST_WAIT_PREFIX = "Waiting for host ";
/** The wait a queued task with no proven host identity reads. */
export const QUEUED_HOST_IDENTITY_WAIT = "Waiting for a proven host identity";

export class DispatchAdmission {
  constructor(readonly context: DispatchAdmissionContext) {}
  private get store() {
    return this.context.store();
  }
  private get adapter() {
    return this.context.adapter();
  }
  private get admission() {
    return this.context.admission();
  }
  queuedWaitSignature(): string {
    const host = this.adapter.hostLoad?.();
    const active = this.store.activeCapacityTasks();
    const owned = active.filter(
      (task) => occupiesSlot(task) && task.workspaceId,
    ).length;
    // Queued host waits are read, not stored (Spec 069 §1), so a host coming or
    // going changes the board without a task write.
    const hosts = this.context
      .hostIds()
      .map((id) => [
        id,
        this.context.withHost(id, () => this.context.hostAvailable(id)),
        this.context.hostOutageSince(id),
      ]);
    return JSON.stringify([
      this.context.profileCatalogKnown(),
      Boolean(host && host.load > host.cpus),
      (this.store.getMeta<number>("workspacePressureNotBefore") ?? 0) >
        Date.now(),
      this.admission?.workspaceAdmissionReason(owned) ?? "",
      hosts,
      this.context.workerHostIds({}),
    ]);
  }
  /** Present-time wait that needs no durable queued-task update. */
  queuedExternalWait(task: Task): string {
    if (task.phase !== "queued") return "";
    const hostWait = this.queuedHostWait(task);
    if (hostWait) return hostWait;
    if (!this.context.profileCatalogKnown())
      return PROFILE_CATALOG_PENDING_REASON;
    const pressure = this.context.workspacePressureWait(task);
    if (pressure || task.workspaceId || !this.admission) return pressure;
    const owned = this.store
      .activeCapacityTasks()
      .filter(
        (candidate) => occupiesSlot(candidate) && candidate.workspaceId,
      ).length;
    return this.admission.workspaceAdmissionReason(owned);
  }
  /**
   * Spec 069 §1: the host a queued task waits for, worked out when the board or
   * `next` is read. A never-started task stores no host wait. An unbound first
   * worker waits for its target host kind, else for any host that can take it; a
   * bound task waits for its own host, named with the outage that host recorded.
   */
  queuedHostWait(task: Task): string {
    if (task.phase !== "queued") return "";
    if (this.context.firstWorkerUnbound(task)) {
      const target = this.context.targetHostWait(task);
      if (target) return target;
      if (this.context.workerHostIds(task).length > 0) return "";
    }
    if (!task.hostId) return QUEUED_HOST_IDENTITY_WAIT;
    if (
      this.store
        .runs(task.id)
        .some((run) => !run.released && run.hostId !== task.hostId)
    )
      return "Waiting for consistent run host identity";
    const hostId = task.hostId;
    if (this.context.withHost(hostId, () => this.context.hostAvailable(hostId)))
      return "";
    const since = this.context.hostOutageSince(hostId);
    return since
      ? hostUnavailableDetail(hostId, since)
      : `${QUEUED_HOST_WAIT_PREFIX}${hostId}`;
  }
  reviewContinuationLimit(): number {
    return reviewContinuationLimit(this.store);
  }
}
