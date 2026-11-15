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
   * Proof of absence: the full identity listing, and only that. Two listings
   * `ESCAPED_DESCENDANT_PROOF_MS` apart that both show no escaped descendant prove
   * the run's descendants are gone; the first clean instant is kept across later
   * clean listings, so a caller polling faster than the interval still proves it
   * on the first listing that lands past it. A listing that could not be read is
   * never proof, and neither is a single clean one: a descendant detaching at the
   * group's last instant must still be seen. The caller proves this only once the
   * run's own process group is empty, so the listing's group members cannot make
   * a live run look escaped.
   */
  absenceProven(processGroupId: number | null, nowMs = Date.now()): boolean {
    const found = processesForStartIdentity(this.identity);
    if (found.state === "unknown") { this.firstClearScanAt = null; return false; }
    const escaped = found.state === "found" ? escapedDescendantsOf(found, processGroupId) : [];
    this.record(escaped);
    if (escaped.length) { this.firstClearScanAt = null; return false; }
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
