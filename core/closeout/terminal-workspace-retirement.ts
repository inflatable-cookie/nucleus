import type { Task } from '../../shared/contracts';
import type { Engine } from '../engine';
import { progressWorkspaceRetirement } from '../workspaces/terminal-workspace-retirement';

export type TerminalWorkspaceRetirementContext = Pick<Engine, 'adapter' | 'retirement' | 'retentionHold' | 'stopped' | 'store' | 'workspaceParticipantsIdle'>;

/** Phase orchestration; workspace ownership, proof and archive implementation stay in workspaces. */
export class TerminalWorkspaceRetirement {
  constructor(readonly engine: TerminalWorkspaceRetirementContext) {}
  get store() { return this.engine.store; }
  settleWorkspaceRetirement(taskId: string): Promise<Task> {
    return progressWorkspaceRetirement(this.store, this.engine.adapter, this.engine.retirement, taskId,
      () => !this.engine.stopped && !this.store.getMeta('paused'),
      task => this.engine.workspaceParticipantsIdle(task, task.workspaceId!),
      target => this.engine.retentionHold(taskId, target, 'Owner-authorized cancelled workspace retirement'));
  }
}
