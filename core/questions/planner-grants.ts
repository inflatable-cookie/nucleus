import { parseAgentId } from '../../shared/agent-identity';
import type { Engine } from '../engine';
import { archiveRoutingGrants, grantArchiveDue, readRoutingGrants } from '../dispatch/routing-grants';
import { observationTimeout } from '../recovery/observation-timeout';

export type PlannerGrantCleanupContext = Pick<Engine, 'adapter' | 'host' | 'signoffDecisions' | 'store' | 'withHost' | 'hostAvailable'>;

export class PlannerGrantCleanup {
  constructor(readonly context: PlannerGrantCleanupContext) {}
  async archivePlannerGrants(): Promise<void> {
    if (!this.context.adapter.listLiveAgents || !grantArchiveDue(this.context.store)) return;
    const hostIds = new Set<string | undefined>(readRoutingGrants(this.context.store).map(grant =>
      parseAgentId(grant.planner)?.hostId ?? (this.context.adapter as { hostId?: string }).hostId));
    for (const hostId of hostIds) {
      const archive = async () => {
        try {
          if (hostId && !this.context.hostAvailable(hostId)) return;
          const live = await observationTimeout(this.context.host.listLiveAgents(), "Grant archive inventory timed out");
          archiveRoutingGrants(this.context.store, this.context.signoffDecisions, new Set(live.map(agent => agent.id)), hostId);
        } catch { /* disconnect, timeout, or truncated inventory: do not archive grants from a partial list */ }
      };
      if (hostId) await this.context.withHost(hostId, archive);
      else await archive();
    }
  }
}
