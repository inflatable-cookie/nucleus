/** Host load up to twice the CPU count: one workspace admission per this gap (Tom, 2026-11-05). */
const WORKSPACE_PRESSURE_GAP_MODERATE_MS = 20_000;
/** Host load above twice the CPU count: one workspace admission per this gap. */
const WORKSPACE_PRESSURE_GAP_SEVERE_MS = 60_000;
/** The admission gap for one host sample by load band; zero means no pacing. */
export function workspaceAdmissionGapMs(host: { load: number; cpus: number }): number {
  if (host.load <= host.cpus) return 0;
  if (host.load <= host.cpus * 2) return WORKSPACE_PRESSURE_GAP_MODERATE_MS;
  return WORKSPACE_PRESSURE_GAP_SEVERE_MS;
}
