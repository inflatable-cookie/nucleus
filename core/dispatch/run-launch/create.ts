import type { Run, Task } from '../../../shared/contracts';
import type { HostAgentSpec } from '../../../shared/host';
import { runAgentSpec, removeMcpBinding, type CreationOwner } from '../agent-creation';
import { ordinaryReviewSource } from '../../review/ordinary-review';
import type { RecoveryDispatchSnapshot } from '../../recovery/recovery-context';
import type { OwnerReviewContext } from '../../review/owner-review-context';

/** Core preparation; native create and its guard remain on the host. */
export interface RunCreationOwner {
  creationOwner(): CreationOwner;
  guardedNativeAgentCreate(spec: HostAgentSpec, mcp: boolean, retry: boolean): Promise<{id: string; workspaceId: string | null}>;
  unsupportedMcp(error: unknown): boolean;
}
export async function createRunVia(owner: RunCreationOwner, task: Task, run: Run, token: string, context: RecoveryDispatchSnapshot | null = null, ownerContext: OwnerReviewContext | null = null,
  guard?: { allowed: () => Promise<boolean>; stillAllowed: () => boolean }) {
    if (run.ordinaryDetached) await ordinaryReviewSource(task, run.head, true);
    if (task.reviewEntry && run.workspaceId !== task.workspaceId)
      throw new Error('Review-entry reviewer must use the task workspace');
    if (!run.profile) throw new Error("Run profile missing");
    const spec = runAgentSpec(() => owner.creationOwner(), task, run, token, run.profile, guard, context, ownerContext);
    const mcp = spec.mcpBindingPath !== null;
    let agent;
    try { agent = await owner.guardedNativeAgentCreate(spec, mcp, false); }
    catch(error) {
      if(!mcp||!owner.unsupportedMcp(error))throw error;
      removeMcpBinding(spec.mcpBindingPath!);
      agent = await owner.guardedNativeAgentCreate(spec, false, true);
    }
    return { id: agent.id, workspaceId: agent.workspaceId };
}
