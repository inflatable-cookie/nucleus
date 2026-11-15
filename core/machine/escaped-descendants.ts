import type { HostRunEscapedDescendant } from "../../shared/contracts";
import { pidAlive } from "./pid";
import { processStartIdentityLiveness, processesForStartIdentity, processesForStartIdentityInTree, type ProcessStartIdentitySearch } from "./process-identity-search";
import { startIdentityMatches } from "./start-identity";

/**
 * Custody of a run's escaped descendants: the processes a `setsid` (or
 * equivalent) left outside the run's process group.
 *
 * Contract 010: a group counts as proven dead only when it is empty *and* no
 * escaped descendant the supervisor knows about is alive. An unreadable process
 * listing proves nothing — including when nothing has been found yet — so this
 * owner keeps unknown distinct from absent and never reports a clean run over
 * evidence it could not read. Callers that only need one settled inventory
 * (`escapedDescendantsOf`) and callers that must keep a run reserved until
 * absence is proven (`EscapedDescendantCustody`) read the same rule here.
 */

/**
 * The proof interval: a clean scan only proves absence once another clean scan
 * confirms it this long after the first one. Shorter than this, a descendant
 * detaching at the group's last instant could still be missed.
 */
export const ESCAPED_DESCENDANT_PROOF_MS = 150;
/**
 * How often a caller may scan: frequent enough to prove absence inside the
 * proof interval, sparse enough that a run waiting for descendants does not
 * read the host's process table on every settlement tick.
 */
export const ESCAPED_DESCENDANT_SCAN_MS = 100;

/** The escaped descendants one identity listing proves, as a result records them. */
export function escapedDescendantsOf(found: ProcessStartIdentitySearch, processGroupId: number | null): HostRunEscapedDescendant[] {
  if (found.state !== "found") return [];
  return found.processes
    .filter(process => process.processGroupId !== processGroupId)
    .map(process => ({ pid: process.pid, startIdentity: process.startIdentity }));
}

export class EscapedDescendantCustody {
  private readonly known = new Map<string, HostRunEscapedDescendant>();
  /** The first clean scan of the current clean run; kept across later clean scans. */
  private firstClearScanAt: number | null = null;

  constructor(private readonly identity: string) {}

  /** Every escaped descendant this run has been seen to leave behind. */
  recorded(): HostRunEscapedDescendant[] {
    return [...this.known.values()];
  }

  /**
   * Cheap inventory for a tick while the run is live: record the descendants the
   * tree walk reaches from the group and the ones already known. It cannot prove
   * absence — an orphan whose parent already exited is out of reach — so it never
   * decides settlement.
   */
  scan(processGroupId: number | null): void {
    const found = processesForStartIdentityInTree(this.identity, { processGroupId, pids: this.recorded().map(entry => entry.pid) });
    if (found.state !== "found") return;
    this.record(escapedDescendantsOf(found, processGroupId));
  }

  /**
   * Proof of absence. Contract 010 asks for two things at once: the run's process
   * group is empty (the caller checks that) *and* no escaped descendant it knows
   * about is alive. The identity listing alone cannot establish the second: a
   * known descendant that execs with a clean environment keeps its pid and OS
   * birth identity but loses the inherited marker, so a listing would report it
   * absent while it still runs. Both are therefore required, and a recorded
   * identity that cannot be observed is not proof of death:
   *
   * - the full identity listing must be readable and show no escaped process;
   * - every recorded identity must be proven dead by its own pid-and-identity
   *   read (an unavailable observation leaves it alive as far as this rule knows).
   *
   * Two fully clean scans `ESCAPED_DESCENDANT_PROOF_MS` apart prove it, so a
   * descendant detaching at the group's last instant is still seen; the first
   * clean instant is kept across later clean scans, so a caller polling faster
   * than the interval proves absence on the first scan that lands past it.
   */
  absenceProven(processGroupId: number | null, nowMs = Date.now()): boolean {
    const found = processesForStartIdentity(this.identity);
    if (found.state === "unknown") { this.firstClearScanAt = null; return false; }
    const escaped = found.state === "found" ? escapedDescendantsOf(found, processGroupId) : [];
    this.record(escaped);
    // A recorded descendant that is alive, that was recorded with an identity the
    // host could not read, or whose identity cannot be observed now, keeps the run
    // reserved: unknown is not absence.
    const knowsLive = [...this.known.values()].some(entry =>
      entry.startIdentity.endsWith("@unknown")
      || processStartIdentityLiveness(entry.pid, entry.startIdentity) !== "dead");
    if (escaped.length || knowsLive) { this.firstClearScanAt = null; return false; }
    this.firstClearScanAt ??= nowMs;
    return nowMs - this.firstClearScanAt >= ESCAPED_DESCENDANT_PROOF_MS;
  }

  private record(escaped: HostRunEscapedDescendant[]): void {
    for (const entry of escaped) this.known.set(`${entry.pid}:${entry.startIdentity}`, entry);
  }

  /**
   * Signal the recorded escaped descendants that are still *the same processes*:
   * the pid must carry the recorded birth identity right now. The recorded set is
   * a history, so an escapee that exited can have its pid reused by an unrelated
   * process — that pid is not signalled, and an identity that cannot be observed
   * is not signalled either (fail closed).
   */
  signal(signal: NodeJS.Signals): void {
    for (const entry of this.known.values()) {
      if (processStartIdentityLiveness(entry.pid, entry.startIdentity) !== "alive") continue;
      try { process.kill(entry.pid, signal); } catch { /* the descendant is already gone */ }
    }
  }
}
