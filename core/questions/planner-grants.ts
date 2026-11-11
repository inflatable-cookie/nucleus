import type { Engine } from '../engine';
import { archiveRoutingGrants, grantArchiveDue } from '../dispatch/routing-grants';
import { observationTimeout } from '../recovery/observation-timeout';

export type PlannerGrantCleanupContext = Pick<Engine, 'adapter' | 'host' | 'signoffDecisions' | 'store'>;

export class PlannerGrantCleanup {
  constructor(readonly context: PlannerGrantCleanupContext) {}
  async archivePlannerGrants(): Promise<void> {
    if (!this.context.adapter.listLiveAgents || !grantArchiveDue(this.context.store)) return;
    try {
      const live = await observationTimeout(this.context.host.listLiveAgents(), "Grant archive inventory timed out");
      archiveRoutingGrants(this.context.store, this.context.signoffDecisions, new Set(live.map(agent => agent.id)));
    } catch { /* disconnect, timeout, or truncated inventory: do not archive grants from a partial list */ }
  }
}
