import type { Task } from '../../shared/contracts';
import type { Adapter } from '../host/adapter';
import type { Admission } from '../host/admission';
import type { Store } from '../store/store';
import { occupiesSlot } from './capacity';
import { PROFILE_CATALOG_PENDING_REASON } from '../recovery/task-reasons';
import { reviewContinuationLimit } from '../review/review-continuation';

/** Live reads used by queued dispatch admission; no engine lifecycle authority. */
export interface DispatchAdmissionContext {
  store(): Store;
  adapter(): Pick<Adapter, 'hostLoad'>;
  admission(): Pick<Admission, 'workspaceAdmissionReason'> | null;
  profileCatalogKnown(): boolean;
  withHost<T>(id: string, fn: () => T): T;
  hostAvailable(id: string): boolean;
  workspacePressureWait(task: Task): string;
}

export class DispatchAdmission {
  constructor(readonly context: DispatchAdmissionContext) {}
  private get store() { return this.context.store(); }
  private get adapter() { return this.context.adapter(); }
  private get admission() { return this.context.admission(); }
  queuedWaitSignature(): string {
    const host = this.adapter.hostLoad?.();
    const active = this.store.activeCapacityTasks();
    const owned = active.filter(task => occupiesSlot(task) && task.workspaceId).length;
    return JSON.stringify([this.context.profileCatalogKnown(), Boolean(host && host.load > host.cpus),
      (this.store.getMeta<number>("workspacePressureNotBefore") ?? 0) > Date.now(), this.admission?.workspaceAdmissionReason(owned) ?? ""]);
  }
  /** Present-time wait that needs no durable queued-task update. */
  queuedExternalWait(task: Task): string {
    if (task.phase !== "queued") return "";
    if (!task.hostId) return 'Waiting for a proven host identity';
    if (this.store.runs(task.id).some(run => run.hostId !== task.hostId)) return 'Waiting for consistent run host identity';
    if (!this.context.withHost(task.hostId, () => this.context.hostAvailable(task.hostId))) return `Waiting for host ${task.hostId}`;
    if (!this.context.profileCatalogKnown()) return PROFILE_CATALOG_PENDING_REASON;
    const pressure = this.context.workspacePressureWait(task);
    if (pressure || task.workspaceId || !this.admission) return pressure;
    const owned = this.store.activeCapacityTasks().filter(candidate => occupiesSlot(candidate) && candidate.workspaceId).length;
    return this.admission.workspaceAdmissionReason(owned);
  }
  reviewContinuationLimit(): number {
    return reviewContinuationLimit(this.store);
  }
}
