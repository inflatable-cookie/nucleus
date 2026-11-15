import type { HostRunEscapedDescendant } from "../../shared/contracts";
import { pidAlive } from "./pid";
import { processGroupEmpty } from "./process-group";
import { processesForStartIdentity, processesForStartIdentityInTree, type ProcessStartIdentitySearch } from "./process-identity-search";
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

/** What one custody scan established: whether a live escaped descendant may remain. */
export interface EscapedDescendantScan { occupied: boolean; clear: boolean }

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
   * True only when two readable scans `ESCAPED_DESCENDANT_PROOF_MS` apart both
   * found no live escaped descendant. The first clean instant is kept across
   * later clean scans, so a caller polling faster than the proof interval still
   * proves absence on the first scan that lands past it. A scan that could not
   * read the host is never proof, and neither is a single clean scan: a
   * descendant detaching at the group's last instant must still be seen.
   */
  absenceProven(processGroupId: number | null, nowMs = Date.now()): boolean {
    const scan = this.scan(processGroupId);
    if (!scan.clear || scan.occupied) { this.firstClearScanAt = null; return false; }
    this.firstClearScanAt ??= nowMs;
    return nowMs - this.firstClearScanAt >= ESCAPED_DESCENDANT_PROOF_MS;
  }

  /**
   * One scan: record what a readable listing proves, then answer whether a live
   * escaped descendant may remain. An unreadable listing is occupied even when
   * nothing has been recorded yet — an unknown host state is not evidence that
   * no descendant exists.
   */
  scan(processGroupId: number | null): EscapedDescendantScan {
    const knownPids = this.recorded().map(entry => entry.pid);
    let found = processesForStartIdentityInTree(this.identity, { processGroupId, pids: knownPids });
    // Last-instant detach: the parent is gone, so the cheap tree walk has no
    // roots unless the child was already inventoried. Fall back to the full
    // identity listing once the group is empty.
    if (found.state === "absent" && this.known.size === 0 && (!processGroupId || processGroupEmpty(processGroupId)))
      found = processesForStartIdentity(this.identity);
    if (found.state === "unknown") {
      // A recorded pid the kernel says is gone does not occupy the run by itself,
      // and a listing with nothing recorded cannot prove there was never a
      // descendant: unknown is occupied until a recorded descendant is proven dead.
      const occupied = this.known.size === 0 || [...this.known.values()].some(entry => pidAlive(entry.pid));
      return { occupied, clear: !occupied };
    }
    if (found.state === "absent") return { occupied: false, clear: true };
    const escaped = escapedDescendantsOf(found, processGroupId);
    for (const entry of escaped) this.known.set(`${entry.pid}:${entry.startIdentity}`, entry);
    // A recorded entry is alive only while the same listing proves its identity;
    // an unobservable identity is never read as death. The listing names live
    // processes, so no escaped process in it means no escaped process remains.
    const listed = new Map(found.processes.map(process => [process.pid, process.startIdentity]));
    const occupied = [...this.known.values()].some(entry =>
      entry.startIdentity.endsWith("@unknown")
      || startIdentityMatches(listed.get(entry.pid) ?? "", entry.startIdentity));
    return { occupied, clear: escaped.length === 0 };
  }

  /** Signal every recorded escaped descendant; an already-gone descendant is not an error. */
  signal(signal: NodeJS.Signals): void {
    for (const entry of this.known.values()) {
      try { process.kill(entry.pid, signal); } catch { /* the descendant is already gone */ }
    }
  }
}
