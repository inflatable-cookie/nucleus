import type { Task } from '../../shared/contracts';
import type { Store } from '../store/store';
import { decideWorkspacePressureWait } from './dispatch-decisions';

/** The store and engine facts workspace pressure pacing needs. */
export interface WorkspacePressurePorts {
  store: Pick<Store, 'getMeta'>;
  /** A stopped engine owes no further admission or wake. */
  stopped(): boolean;
  /** Start the next dispatch pass; the caller owns context isolation. */
  wake(): void;
}

/**
 * The one armed wake for the durable workspace admission gap. Host pressure
 * admits a bounded trickle of workspace creation: one task's admitted start
 * records when the next may begin, and this owner starts that next pass when
 * the gap ends, so a paced task never waits for an unrelated sweep. It never
 * scans tasks itself and never re-arms the same gap twice.
 */
export class WorkspacePressure {
  private wake: { at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(readonly ports: WorkspacePressurePorts) {}
  wait(task: Task, host: { load: number; cpus: number } | undefined): string {
    return decideWorkspacePressureWait(task, host, this.ports.store.getMeta<number>("workspacePressureNotBefore") ?? 0, Date.now());
  }
  arm(): void {
    const next = this.ports.store.getMeta<number>("workspacePressureNotBefore") ?? 0;
    const delay = next - Date.now();
    if (this.ports.stopped() || delay <= 0) return;
    if (this.wake?.at === next) return;
    if (this.wake) clearTimeout(this.wake.timer);
    const timer = setTimeout(() => {
      this.wake = null;
      if (this.ports.stopped()) return;
      this.ports.wake();
    }, delay);
    timer.unref();
    this.wake = { at: next, timer };
  }
  stop(): void {
    if (this.wake) clearTimeout(this.wake.timer);
    this.wake = null;
  }
}
