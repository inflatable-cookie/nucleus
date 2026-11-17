/**
 * Spec 064 P5: the qualification storage ledger.
 *
 * The ledger charges the full inventory the spec names — the Nucleus database,
 * its WAL and ordered journal, temporary and final publications, the one combined
 * raw log including its framing, every permitted source/evidence copy and every
 * retained failure — under a root/provider/device identity, with the owner and
 * writers, the method and units, the sample tick, the missing coverage and the
 * reserve safety. When attribution of a shared footprint cannot be proven the
 * whole footprint is charged.
 *
 * Two monitored thresholds: the combined 512 MiB target (384 + 128 planning, no
 * free outside part) and the cooperative 22 GiB (20 + 2) start/abort reserve
 * safety. A breach or accounting overflow latches the first fault and requests
 * P3's direct-command stop; it is never a truncation exemption. Logical sampling
 * never claims an all-physical peak, so the physical peak stays literally
 * unknown and is disclosed rather than guaranteed.
 */
import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  HostRunQualificationLedger,
  HostRunQualificationLedgerEntry,
} from "../../shared/schema/host-runs";

/** The monitored combined target: 384 + 128 planning split inside one 512 MiB bound. */
export const QUALIFICATION_STORAGE_TARGET_BYTES = 512 * 1024 * 1024;
export const QUALIFICATION_STORAGE_PLANNED = { workloadBytes: 384 * 1024 * 1024, evidenceBytes: 128 * 1024 * 1024 } as const;
/** The cooperative start/abort safety threshold: 20 + 2 GiB. It reserves nothing against other writers. */
export const QUALIFICATION_RESERVE_THRESHOLD_BYTES = 22 * 1024 * 1024 * 1024;

/** Which bytes one entry charges, exactly as the spec's inventory names them. */
export type QualificationLedgerScope = HostRunQualificationLedgerEntry["scope"];

/**
 * One footprint to charge. `attributionProven: false` charges the whole shared
 * footprint (the DB/WAL/journal case) instead of guessing a per-run share.
 */
export interface QualificationFootprint {
  scope: QualificationLedgerScope;
  label: string;
  root: string;
  attributionProven: boolean;
  missingCoverage?: readonly string[];
}

/** One P3 stop request: the direct command, never a group, escapee or KILL. */
export interface QualificationStopRequest {
  mode: "qualification_direct";
  reason: string;
}

export interface QualificationLedgerReading {
  ledger: HostRunQualificationLedger;
  /** The latched breach reason, or null when the target still holds. */
  breach: string | null;
  /** The P3 stop this reading requests, when a breach or overflow latched. */
  stop: QualificationStopRequest | null;
}

const tick = (nowMs: number) => Math.floor(nowMs);

/**
 * The logical size of one file or tree, without following symlinks. A missing
 * path is `absent`, which is a real zero for a footprint that was never created
 * and is never silently read as zero for one that should exist; a refused read is
 * unknown.
 */
export function logicalTreeBytes(root: string): { state: "measured"; bytes: number } | { state: "absent" } | { state: "unknown"; reason: string } {
  const total = (path: string): number => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return 0;
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    let bytes = 0;
    for (const entry of readdirSync(path)) bytes += total(join(path, entry));
    return bytes;
  };
  try { return { state: "measured", bytes: total(root) }; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
    return { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Charge one footprint into a ledger entry. A logical sample proves only its own
 * observation time, and the entry says so: `sampledAt` is that tick and the
 * physical peak stays unclaimed.
 */
export function qualificationLedgerEntry(
  footprint: QualificationFootprint,
  sample: { nowMs: number; provider: { kind: "device" | "volume" | "root" | "provider"; id: string }; owner: string; writers: readonly string[] | "unknown";
    reserve: { observedFreeBytes: number | null } },
  previous: HostRunQualificationLedgerEntry | null = null,
): HostRunQualificationLedgerEntry {
  const measured = logicalTreeBytes(footprint.root);
  const chargedBytes = measured.state === "measured" ? measured.bytes : measured.state === "absent" ? 0 : null;
  const missingCoverage = [...(footprint.missingCoverage ?? [])];
  if (measured.state === "unknown") missingCoverage.push(`the ${footprint.label} footprint could not be read (${measured.reason})`);
  if (measured.state === "absent" && footprint.scope !== "retained_failure")
    missingCoverage.push(`the ${footprint.label} footprint is absent at ${footprint.root}; its absence is observed, not proven never-created`);
  const highWater = previous?.highWaterBytes != null && chargedBytes != null
    ? Math.max(previous.highWaterBytes, chargedBytes) : previous?.highWaterBytes ?? chargedBytes;
  const observedFreeBytes = sample.reserve.observedFreeBytes;
  return {
    scope: footprint.scope, label: footprint.label, root: footprint.root,
    provider: sample.provider, owner: sample.owner,
    writers: sample.writers === "unknown" ? "unknown" : [...sample.writers],
    method: measured.state === "unknown" ? "not_sampled" : "logical_tree_walk",
    units: "bytes",
    sampledAt: new Date(sample.nowMs).toISOString(),
    chargedBytes,
    highWaterBytes: highWater ?? null,
    wholeFootprintCharged: !footprint.attributionProven,
    missingCoverage,
    reserveSafety: {
      thresholdBytes: QUALIFICATION_RESERVE_THRESHOLD_BYTES,
      observedFreeBytes,
      state: observedFreeBytes === null ? "unknown" : observedFreeBytes >= QUALIFICATION_RESERVE_THRESHOLD_BYTES ? "safe" : "below_threshold",
    },
    physicalPeakClaimed: false,
  };
}

/**
 * The ledger as one attempt records it: the combined charge against the 512 MiB
 * target, whether that target was breached, whether the accounting overflowed and
 * the smallest reserve safety any entry observed. A required charge that is
 * unknown makes the combined total unknown — an unknown total never reads as
 * fit.
 */
export function qualificationLedger(
  entries: readonly HostRunQualificationLedgerEntry[],
  sampledAt: number | null,
  targetBytes: number = QUALIFICATION_STORAGE_TARGET_BYTES,
): HostRunQualificationLedger {
  const unknownCharge = entries.some(entry => entry.chargedBytes === null);
  const chargedBytes = unknownCharge ? null : entries.reduce((sum, entry) => sum + (entry.chargedBytes ?? 0), 0);
  const breach = chargedBytes === null ? null : chargedBytes > targetBytes;
  const overcharged = entries
    .filter(entry => entry.chargedBytes !== null && entry.chargedBytes > targetBytes)
    .map(entry => entry.label);
  const states = entries.map(entry => entry.reserveSafety.state);
  const reserve = states.includes("below_threshold") ? "below_threshold" as const : states.includes("unknown") ? "unknown" as const : "safe" as const;
  return {
    entries: [...entries],
    combined: {
      targetBytes,
      chargedBytes,
      breach,
      overflow: unknownCharge ? null : false,
      overchargedScopes: overcharged,
    },
    reserve: { thresholdBytes: QUALIFICATION_RESERVE_THRESHOLD_BYTES, state: reserve },
    physicalPeak: "unknown",
    sampledAt: sampledAt === null ? null : new Date(sampledAt).toISOString(),
  };
}

/**
 * The monitored monitor an attempt keeps: it accumulates entries, remembers the
 * first breach and answers with the P3 stop that breach requests. Once latched it
 * stays latched: a later sample under the target cannot withdraw a breach, and a
 * breach is never a truncation exemption.
 */
export class QualificationLedgerMonitor {
  private readonly entries: HostRunQualificationLedgerEntry[] = [];
  private latched: { reason: string; at: string } | null = null;
  private lastSampledAt: number | null = null;

  /** `targetBytes` is a simulation seam for the monitored 512 MiB bound; the default is the spec's number. */
  constructor(private readonly limits: { targetBytes?: number; stopMode?: "qualification_direct" } = {}) {}

  get targetBytes(): number { return this.limits.targetBytes ?? QUALIFICATION_STORAGE_TARGET_BYTES; }

  /** Charge (or re-charge) one entry; the same scope+label replaces its earlier sample. */
  record(entry: HostRunQualificationLedgerEntry, nowMs = Date.now()): QualificationLedgerReading {
    if (entry.physicalPeakClaimed !== false) throw new Error("The storage ledger never claims a physical peak");
    if (entry.chargedBytes !== null && entry.chargedBytes > this.targetBytes)
      this.latch(`${entry.label} alone charges ${entry.chargedBytes} bytes, past the ${this.targetBytes}-byte monitored target`, entry.sampledAt ?? new Date(nowMs).toISOString());
    const index = this.entries.findIndex(existing => existing.scope === entry.scope && existing.label === entry.label);
    if (index >= 0) this.entries.splice(index, 1, entry); else this.entries.push(entry);
    this.lastSampledAt = nowMs;
    const ledger = qualificationLedger(this.entries, this.lastSampledAt, this.targetBytes);
    if (ledger.combined.chargedBytes !== null && ledger.combined.chargedBytes > this.targetBytes)
      this.latch(`the combined charge ${ledger.combined.chargedBytes} exceeds the ${this.targetBytes}-byte monitored target`, new Date(nowMs).toISOString());
    return this.reading();
  }

  /** The current ledger and the stop it requests, if any. */
  reading(): QualificationLedgerReading {
    const ledger = qualificationLedger(this.entries, this.lastSampledAt, this.targetBytes);
    const breach = this.latched?.reason
      ?? (ledger.combined.chargedBytes !== null && ledger.combined.chargedBytes > this.targetBytes
        ? `the combined charge ${ledger.combined.chargedBytes} exceeds the ${this.targetBytes}-byte monitored target` : null);
    const stop: QualificationStopRequest | null = breach === null ? null
      : { mode: this.limits.stopMode ?? "qualification_direct", reason: `storage ledger latched: ${breach}; the direct command is stopped cooperatively and the evidence is retained` };
    return { ledger: { ...ledger, combined: { ...ledger.combined, breach: breach === null ? ledger.combined.breach : true } }, breach, stop };
  }

  /** The first latched fault; never rewritten by a later good sample. */
  firstFault(): { reason: string; at: string } | null {
    return this.latched;
  }

  private latch(reason: string, at: string): void {
    if (this.latched === null) this.latched = { reason, at };
  }
}

/** Rounded for a refusal sentence; every recorded value stays exact bytes. */
export const describeBytes = (bytes: number | null): string => bytes === null ? "unknown" : `${bytes} bytes (${(bytes / (1024 * 1024)).toFixed(1)} MiB)`;

/** The provider one root is charged under: the device and the root path, both observable. */
export function qualificationRunProvider(root: string): { kind: "root"; id: string } {
  return { kind: "root", id: root };
}

/** The reserve safety sample one root can observe, or `unknown` when it cannot. */
export function qualificationRunReserve(root: string): { observedFreeBytes: number | null } {
  try {
    const stats = statfsSync(root);
    return { observedFreeBytes: stats.bavail * stats.bsize };
  } catch { return { observedFreeBytes: null }; }
}

/**
 * The footprints S can charge itself: the one combined artifact it writes, and
 * the shared state root it publishes into. The Nucleus database, WAL and journal
 * are not visible to S and are charged by the service's own ledger, which S
 * discloses as missing coverage rather than counting them as zero.
 */
export function qualificationRunFootprints(stateDir: string, runId: string): QualificationFootprint[] {
  return [
    {
      scope: "raw_capture", label: "combined raw artifact", root: join(stateDir, "runs", runId),
      attributionProven: true,
      missingCoverage: ["the upstream pipe buffers are observed by the process owner, not counted here"],
    },
    {
      scope: "publication", label: "host-run state publications", root: stateDir,
      attributionProven: false,
      missingCoverage: ["the Nucleus database, WAL and ordered journal are charged by the service's ledger"],
    },
  ];
}

/**
 * The footprints the service charges for one qualification attempt: the database
 * and its WAL and journal (the whole shared footprint, because attribution to one
 * run is not proven), the publications under the host-run state root, and the one
 * combined artifact. Copies and retained failures stay charged under the state
 * root too.
 */
export function qualificationServiceFootprints(input: { stateDir: string; databasePath: string | null; runId: string }): QualificationFootprint[] {
  const databaseRoot = input.databasePath ? dirname(input.databasePath) : input.stateDir;
  const shared = ["attribution of one run's share is not proven, so the whole shared footprint is charged"];
  return [
    { scope: "database", label: "Nucleus database", root: databaseRoot, attributionProven: false, missingCoverage: shared },
    { scope: "wal", label: "Nucleus WAL", root: databaseRoot, attributionProven: false, missingCoverage: shared },
    { scope: "journal", label: "ordered journal and scheduler records", root: databaseRoot, attributionProven: false, missingCoverage: shared },
    { scope: "publication", label: "host-run publications", root: input.stateDir, attributionProven: false, missingCoverage: shared },
    { scope: "copy", label: "evidence copies and retained failures", root: input.stateDir, attributionProven: false, missingCoverage: shared },
    { scope: "raw_capture", label: "combined raw artifact", root: join(input.stateDir, "runs", input.runId), attributionProven: true, missingCoverage: [] },
  ];
}

/** One sample tick, so a caller's sample time is one expression. */
export const ledgerSampleTick = tick;
