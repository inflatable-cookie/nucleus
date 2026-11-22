import { uptime } from "node:os";
import type { ParticipantProcess } from "../../shared/schema/task-activity";
import type { ProcessLiveness } from "../../shared/task-activity";
import type { HostProcessFact } from "../host/types";
import { argvBase, commandArgv } from "./process-shapes";
import { startIdentityMatches, startIdentityProves } from "./start-identity";

type ProcessTable = {
  at: number;
  byPid: ReadonlyMap<number, HostProcessFact>;
  providers: ReadonlyMap<string, ParticipantProcess | null>;
  enumeratedPids?: ReadonlySet<number>;
};

let lastRead = { at: 0, table: null as ProcessTable | null };

/** Keep the last answer from the existing local process reader, including unreadable answers. */
export function rememberParticipantProcessTable(
  processes: readonly HostProcessFact[] | null,
  at: number,
  enumeratedPids?: ReadonlySet<number>,
): void {
  if (at < lastRead.at) return;
  if (!processes) {
    lastRead = { at, table: null };
    return;
  }
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const providers = new Map<string, ParticipantProcess | null>();
  for (const process of processes) {
    if (!process.command.includes("mcp-report.mjs")) continue;
    const args = commandArgv(process.command);
    if (argvBase(args[0]) !== "node" || argvBase(args[1]) !== "mcp-report.mjs")
      continue;
    const runId = /^mcp-(.+)\.json$/.exec(argvBase(args[2]) ?? "")?.[1];
    if (!runId) continue;
    const provider = process.ppid ? byPid.get(process.ppid) : undefined;
    const identity = provider?.startIdentity;
    providers.set(
      runId,
      !providers.has(runId) &&
        provider &&
        identity &&
        startIdentityProves(identity) &&
        !zombie(provider)
        ? { pid: provider.pid, startIdentity: identity, seenAt: at }
        : null,
    );
  }
  lastRead = { at, table: { at, byPid, providers, enumeratedPids } };
}

function zombie(process: HostProcessFact): boolean {
  return process.state?.toUpperCase().startsWith("Z") ?? false;
}

const MAX_SAMPLE_AGE_MS = 60_000;

export function observedParticipantProcess(
  runId: string,
  now = Date.now(),
): ParticipantProcess | null {
  const table = lastRead.table;
  return table && now - table.at < MAX_SAMPLE_AGE_MS
    ? (table.providers.get(runId) ?? null)
    : null;
}

/**
 * Positive proof that one recorded participant process is gone, or null when the
 * facts do not prove it. An unreadable table, an unreadable start identity, a
 * PID the table could not enumerate and a sample that predates the record are
 * all no proof, never absence.
 */
export type ProcessDeathEvidence =
  | "pre_boot"
  | "pid_absent"
  | "start_identity_changed"
  | "zombie";

type ProcessVerdict =
  | { state: "gone"; evidence: ProcessDeathEvidence }
  | { state: "alive" }
  | { state: "unknown" };

/** The one liveness verdict; both public reads below are views of it. */
function processVerdict(
  recorded: ParticipantProcess | null,
  now: number,
  bootAt: number,
  table: ProcessTable | null,
): ProcessVerdict {
  if (!recorded) return { state: "unknown" };
  // The boot estimate and process start reads can have whole-second precision.
  const darwinStart = /@([0-9]{4}-[^@]+Z)$/.exec(recorded.startIdentity)?.[1];
  const seenAt =
    recorded.seenAt ?? (darwinStart ? Date.parse(darwinStart) : null);
  if (seenAt !== null && seenAt < bootAt - 2_000)
    return { state: "gone", evidence: "pre_boot" };
  if (!table || (seenAt !== null && table.at < seenAt))
    return { state: "unknown" };
  const observed = table.byPid.get(recorded.pid);
  if (!observed)
    return table.enumeratedPids?.has(recorded.pid)
      ? { state: "unknown" }
      : { state: "gone", evidence: "pid_absent" };
  if (zombie(observed)) return { state: "gone", evidence: "zombie" };
  if (
    !startIdentityProves(observed.startIdentity) ||
    !startIdentityProves(recorded.startIdentity)
  )
    return { state: "unknown" };
  if (!startIdentityMatches(recorded.startIdentity, observed.startIdentity))
    return { state: "gone", evidence: "start_identity_changed" };
  return now - table.at < MAX_SAMPLE_AGE_MS
    ? { state: "alive" }
    : { state: "unknown" };
}

/** A process observed before this boot is gone even when the current table cannot be read. */
export function participantProcessLiveness(
  recorded: ParticipantProcess | null,
  now: number,
  bootAt = now - uptime() * 1_000,
  table = lastRead.table,
): ProcessLiveness {
  return processVerdict(recorded, now, bootAt, table).state;
}

/** Why this recorded process is gone, for the one event that names the proof. */
export function participantProcessDeath(
  recorded: ParticipantProcess | null,
  now: number,
  bootAt = now - uptime() * 1_000,
  table = lastRead.table,
): ProcessDeathEvidence | null {
  const verdict = processVerdict(recorded, now, bootAt, table);
  return verdict.state === "gone" ? verdict.evidence : null;
}
