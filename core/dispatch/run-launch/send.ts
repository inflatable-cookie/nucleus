import { wireLabel } from "../../../shared/wire-labels";
import type { Run, Task } from '../../../shared/contracts';
import type { HostRetainedAgentRef } from '../../../shared/host';
import { runPrompt } from '../prompts';
import { runTemporaryEnvironment, type RunScratchPlacement } from '../../workspaces/run-scratch';
import { ProvenPreSendRefusalError } from '../../recovery/task-reasons';
import type { RecoveryDispatchSnapshot } from '../../recovery/recovery-context';
import type { OwnerReviewContext } from '../../review/owner-review-context';

/** Core preparation and fences around a retained host send. */
export interface RunSendOwner {
  readonly helperPath: string;
  scratchPlacement(task: Task): RunScratchPlacement;
  retainedAgentRef(id: string): HostRetainedAgentRef;
  binding(key: string, task: Task, runId: string, token: string): unknown;
  ticket(task: Task, run: Run, token: string): string;
  continueReviewer(task: Task, run: Run, messageId: string, text: string, allowed: () => Promise<boolean>, stillAllowed: () => boolean, beforeSend?: () => void): Promise<{sent: true} | {sent: false; reason: string}>;
}
export async function sendRunVia(owner: RunSendOwner, task: Task, run: Run, token: string, context: RecoveryDispatchSnapshot | null = null, ownerContext: OwnerReviewContext | null = null, guard?: { allowed: () => Promise<boolean>; stillAllowed: () => boolean }) {
    // Retained runs do not pass through createRun again. Re-prove and exclusively
    // create their recorded leaf here, before any prompt is sent.
    runTemporaryEnvironment(run.id, owner.scratchPlacement(task), run.temporaryDirectory);
    const agent=owner.retainedAgentRef(run.agentId!);await agent.refresh();
    const key=wireLabel(agent.current()?.labels, "mcpBinding");
    if(key && !run.ordinaryDetached)owner.binding(key,task,run.id,token);
    const prompt = runPrompt(task, run, owner.helperPath, owner.ticket(task, run, token),Boolean(key), context, ownerContext);
    if (run.ordinaryDetached) {
      if (!guard) throw Error('Ordinary retained round requires a live Nucleus custody guard');
      const sent = await owner.continueReviewer(task, run, `ns-run-${run.id}`, prompt, guard.allowed, guard.stillAllowed, () => { if(key)owner.binding(key,task,run.id,token); });
      if (!sent.sent) throw new ProvenPreSendRefusalError(sent.reason);
      return;
    }
    if (guard) {
      try {
        if (!await guard.allowed() || !guard.stillAllowed())
          throw new ProvenPreSendRefusalError('Review-entry source or writer state changed before send');
      } catch (error) {
        if (error instanceof ProvenPreSendRefusalError) throw error;
        throw new ProvenPreSendRefusalError(error instanceof Error ? error.message : String(error));
      }
    }
    await agent.send(prompt, { messageId: `ns-run-${run.id}` });
}
