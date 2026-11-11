import { isOperatorOrigin, taskOwner } from "../../shared/contracts";
import { type Task } from '../../shared/contracts';
import type { Resolution } from '../resolution';

export type PlannerPresenceContext = Pick<Resolution, 'adapter' | 'host' | 'identifyOriginHost' | 'originHostAvailable' | 'plannerThreadGone' | 'projectPlannerFor' | 'store' | 'withHost'>;

export class PlannerPresence {
  constructor(readonly context: PlannerPresenceContext) {}
  async plannerThreadGone(agentId: string): Promise<boolean> {
    const hostId = await this.context.identifyOriginHost(agentId);
    if (!hostId || !this.context.withHost(hostId, () => this.context.originHostAvailable(hostId))) return false;
    try {
      const registered = await this.context.withHost(hostId, () => this.context.host.originAgent(agentId));
      return !registered || registered.archived;
    } catch { return false; }
  }

  async escalationRecipient(task: Task): Promise<string | null> {
    const { planner } = await this.context.projectPlannerFor(task);
    if (planner) return planner;
    const owner = taskOwner(task);
    return !isOperatorOrigin(owner) && !await this.context.plannerThreadGone(owner) ? owner : null;
  }

  notifyStaleQuestionAnswer(taskId: string, questionId: string, who: string): void {
    const agentId = who.match(/^(?:delegated )?(?:planner|decider)\s+(\S+)$/)?.[1];
    if (!agentId) return;
    void (async () => {
      const task = this.context.store.task(taskId);
      const host = agentId === task.originAgentId || agentId === task.notificationAgentId ? task.originHostId : await this.context.identifyOriginHost(agentId);
      if (!host) return;
      await this.context.withHost(host, async () => {
        if (!this.context.originHostAvailable(host) || !this.context.adapter.notify) return;
        await this.context.adapter.notify(agentId, `ns-stale-answer-${questionId}`, `Your answer to Nucleus question ${questionId} arrived after an owner control superseded it. Nucleus recorded it as stale; it has no effect.`);
      });
    })().catch(() => { /* the stale answer remains durably recorded */ });
  }
}
