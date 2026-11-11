import type { Profile, Task } from '../../../shared/contracts';
import type { PaseoAdapter } from './paseo';
import { capPaseoTitle } from '../../../shared/paseo-title';

/**
 * The Paseo host's native ask, consult and decider calls (Spec 058, tasks 540, 584
 * and 542). Step 3 row 11 of the Paseo host split map (task 871) moved these out of
 * `server/paseo.ts`.
 *
 * What decides stays core: `server/questions.ts`, `server/delegation.ts`,
 * `server/agent-asks.ts`, `server/ladder.ts` and `server/native-questions.ts` own the
 * profile and role choice, the stable request and label identities, delegation,
 * authority, follow-up and archive, and the answer, which arrives through the
 * authenticated command receipt and never through the recipient's chat output.
 *
 * The owner is kept and `owner.api` and `owner.sendWhenIdle` are read at call time, so
 * test replacements and the adapter's own surface are the ones called. Each method keeps
 * the body and sync prefix it had on the adapter.
 */
export class PaseoAskHost {
  constructor(private readonly owner: PaseoAdapter) {}
  /** Answers arrive only through the authenticated command, never through the host's chat output. */
  async askPlanner(planner: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }): Promise<string | null> {
    await this.owner.sendWhenIdle(planner, input);
    return null;
  }
  async askReviewer(reviewer: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }): Promise<string | null> {
    await this.owner.sendWhenIdle(reviewer, input);
    return null;
  }
  async createConsultReviewer(task: Task, input: { profile: Profile; id: string }) {
    if (!task.workspaceId) throw Error('Task has no workspace for a reviewer');
    const p = input.profile;
    const created = await this.owner.api.workspaces.ref(task.workspaceId).agents.create({
      config: { provider: `${p.provider}/${p.model}`, modeId: p.modeId, thinkingOptionId: p.thinkingOptionId, featureValues: p.featureValues },
      title: capPaseoTitle(`Review: ${task.title}`), autoArchive: false,
      requestId: `ns-reviewer-consult-${input.id}`, labels: { "nucleus.reviewer": task.id },
    });
    return { id: created.id, workspaceId: task.workspaceId };
  }
  async runDecider(task: Task, input: { profile: Profile; signal: AbortSignal; timeoutMs: number; decisionId: string }): Promise<{ agentId: string; text: string | null }> {
    if (!task.workspaceId) throw Error('Task has no workspace for a decider');
    const p = input.profile;
    const created = await this.owner.api.workspaces.ref(task.workspaceId).agents.create({
      config: { provider: `${p.provider}/${p.model}`, modeId: p.modeId, thinkingOptionId: p.thinkingOptionId, featureValues: p.featureValues },
      title: capPaseoTitle(`Decision: ${task.title}`), autoArchive: false, requestId: `ns-decider-${input.decisionId}`,
      labels: { "nucleus.decider": task.id },
    });
    return { agentId: created.id, text: null };
  }
}
