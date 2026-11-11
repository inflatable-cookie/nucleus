import { type Run } from '../../shared/contracts';
import type { Resolution } from '../resolution';

export type OrphanRunsContext = Pick<Resolution, 'store'>;

export class OrphanRuns {
  constructor(readonly context: OrphanRunsContext) {}
  orphanRuns(taskId: string, agentId: string): Run[] {
    const runs = this.context.store.runs(taskId), current = this.context.store.task(taskId).resolution.currentRunId;
    return runs.filter(r => r.agentId === agentId && !r.released && !r.completion && r.id !== current &&
      runs.some(s => s.id !== r.id && s.agentId === agentId && s.released && s.completion && s.createdAt >= r.createdAt));
  }

  supersedeOrphans(taskId: string, orphans: Run[]): string[] {
    for (const orphan of orphans) {
      this.context.store.deleteCredential(orphan.id);
      this.context.store.putRun({ ...orphan, status: 'superseded', released: true });
      this.context.store.event(taskId, 'duplicate_run_superseded', `${orphan.role} ${orphan.id}: no completion; a sibling run on the same thread completed`);
    }
    return orphans.map(orphan => orphan.id);
  }
}
