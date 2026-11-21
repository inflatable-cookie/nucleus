import { parseAgentId } from "../../shared/agent-identity";
import { hostKindOf } from "../../shared/host-kind";
import type { Engine } from "../engine";
import {
  archiveRoutingGrants,
  grantArchiveDue,
  readRoutingGrants,
} from "../dispatch/routing-signoff";
import { observationTimeout } from "../recovery/observation-timeout";

export type PlannerGrantCleanupContext = Pick<
  Engine,
  | "adapter"
  | "host"
  | "signoffDecisions"
  | "store"
  | "withHost"
  | "hostAvailable"
> &
  Partial<Pick<Engine, "hostIds">>;

export class PlannerGrantCleanup {
  constructor(readonly context: PlannerGrantCleanupContext) {}
  async archivePlannerGrants(): Promise<void> {
    if (!grantArchiveDue(this.context.store)) return;
    const registeredPaseoHosts =
      this.context.hostIds?.().filter((id) => hostKindOf(id) === "paseo") ?? [];
    const ambientHostId = (this.context.adapter as { hostId?: string }).hostId;
    const legacyHostId =
      registeredPaseoHosts.length === 1
        ? registeredPaseoHosts[0]
        : ambientHostId && hostKindOf(ambientHostId) === "paseo"
          ? ambientHostId
          : undefined;
    const hostIds = new Set<string | undefined>(
      readRoutingGrants(this.context.store).map(
        (grant) => parseAgentId(grant.planner)?.hostId ?? legacyHostId,
      ),
    );
    for (const hostId of hostIds) {
      const archive = async () => {
        try {
          if (hostId && !this.context.hostAvailable(hostId)) return;
          if (!this.context.adapter.listLiveAgents) return;
          const live = await observationTimeout(
            this.context.host.listLiveAgents(),
            "Grant archive inventory timed out",
          );
          archiveRoutingGrants(
            this.context.store,
            this.context.signoffDecisions,
            new Set(live.map((agent) => agent.id)),
            hostId,
          );
        } catch {
          /* disconnect, timeout, or truncated inventory: do not archive grants from a partial list */
        }
      };
      if (hostId) await this.context.withHost(hostId, archive);
      else await archive();
    }
  }
}
