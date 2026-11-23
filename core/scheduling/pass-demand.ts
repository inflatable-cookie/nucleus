type PageDemand = "owned-tools" | "timeline";

export const PASS_DEMAND_BATCH_SIZE = 64;

export type PassProofDemand = {
  agentId: string;
  page: PageDemand | null;
};

/**
 * Participants whose owned-tool proof a task quantum read from its pass's
 * shared snapshot (Spec 068 §6): its tool page, or the process snapshot that
 * must postdate an inactivity observation.
 *
 * A demand outlives the pass that raised it, so the next host pass serves it
 * first: it observes each demanded participant before its process snapshot and
 * warms its tool page ahead of the rotation and outside the candidate cap. The
 * reads stay on the host pass, under its deadlines; a quantum only registers.
 * Unserved demand carries forward. A completed attempt removes a demand unless
 * a quantum renewed it while the pass was serving it.
 */
export class PassDemand {
  private readonly hosts = new Map<
    string,
    Map<string, { renewed: boolean; page: PageDemand | null }>
  >();

  /** Ask the next host pass to observe and warm this participant first. */
  request(host: string, agentId: string, page: PageDemand | null): void {
    const demanded = this.hosts.get(host) ?? new Map();
    const previous = demanded.get(agentId);
    demanded.set(agentId, {
      renewed: true,
      page:
        previous?.page === "timeline"
          ? "timeline"
          : (page ?? previous?.page ?? null),
    });
    this.hosts.set(host, demanded);
  }

  /**
   * Start a host pass with the oldest queued demand. Move its head to the
   * tail for next time so even a pass that can attempt only one read advances
   * every waiting participant.
   */
  take(host: string): PassProofDemand[] {
    const demanded = this.hosts.get(host);
    if (!demanded) return [];
    const pending: PassProofDemand[] = [];
    for (const [agentId, demand] of demanded) {
      pending.push({ agentId, page: demand.page });
      demand.renewed = false;
      if (pending.length === PASS_DEMAND_BATCH_SIZE) break;
    }
    const first = pending[0];
    if (first) {
      demanded.delete(first.agentId);
      demanded.set(first.agentId, { renewed: false, page: first.page });
    }
    return pending;
  }

  served(host: string, agentId: string): void {
    const demanded = this.hosts.get(host);
    if (!demanded) return;
    if (demanded.get(agentId)?.renewed === false) demanded.delete(agentId);
    if (!demanded.size) this.hosts.delete(host);
  }
}
