/**
 * The most participants one host keeps on demand at once. Demands expire after
 * one pass without use, so this only bounds a burst.
 */
export const PASS_DEMAND_HOST_CAP = 64;

/**
 * Participants whose owned-tool proof a task quantum read from its pass's
 * shared snapshot (Spec 068 §6): its tool page, or the process snapshot that
 * must postdate an inactivity observation.
 *
 * A demand outlives the pass that raised it, so the next host pass serves it
 * first: it observes each demanded participant before its process snapshot and
 * warms its tool page ahead of the rotation and outside the candidate cap. The
 * reads stay on the host pass, under its deadlines; a quantum only registers.
 * Each use renews the demand; one that no quantum renewed since the last pass
 * expires, so a settled proof stops costing reads after one pass.
 */
export class PassDemand {
  /** Per host: participant → renewed since the last host pass took the set. */
  private readonly hosts = new Map<string, Map<string, boolean>>();

  /** Ask the next host pass to observe and warm this participant first. */
  request(host: string, agentId: string): void {
    const demanded = this.hosts.get(host) ?? new Map<string, boolean>();
    if (!demanded.has(agentId) && demanded.size >= PASS_DEMAND_HOST_CAP) {
      const oldest = demanded.keys().next().value;
      if (oldest !== undefined) demanded.delete(oldest);
    }
    demanded.set(agentId, true);
    this.hosts.set(host, demanded);
  }

  /**
   * Start one host pass: drop demands that no quantum renewed since the last
   * pass or that no live task on this host still has, and return the rest,
   * oldest first, for this pass to serve.
   */
  take(host: string, live: ReadonlySet<string>): string[] {
    const demanded = this.hosts.get(host);
    if (!demanded) return [];
    for (const [agentId, renewed] of demanded) {
      if (renewed && live.has(agentId)) demanded.set(agentId, false);
      else demanded.delete(agentId);
    }
    if (!demanded.size) this.hosts.delete(host);
    return [...demanded.keys()];
  }
}
