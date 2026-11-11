import { hookHoldReason } from "./hooks";
import type { Engine } from '../engine';

export type HookRetentionContext = Pick<Engine, 'hooks' | 'store'>;

export class HookRetention {
  constructor(readonly context: HookRetentionContext) {}
  async retentionHold(taskId: string, target: { directory: string; head: string }, reason: string): Promise<{ hold: boolean; detail: string }> {
    const outcome = await this.context.hooks.retentionGate(this.context.store.task(taskId), { ...target, reason });
    return outcome.hold ? { hold: true, detail: hookHoldReason(outcome) } : { hold: false, detail: "" };
  }
}
