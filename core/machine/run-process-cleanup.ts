import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Store } from "../store/store";
import type { HostProcessFact } from "../host/types";
import { readHostUidProcesses } from "./host-process-listing";
import { pidAlive } from "./pid";
import { runProcessEnvironments, runProcessLiveness, type RunProcessEnvironment } from "./run-process-identity";
import { hasRunProcessHost, protectedRunInfrastructure, rememberRunProcessHosts } from "./run-process-hosts";
import { protectedHostPids } from "./host-process-select";
import { terminateHostProcessTargets } from "./host-process-reap";

interface CleanupRun {
  id: string; taskId: string; hostId?: string; agentId?: string | null; temporaryDirectory?: string;
  pending?: boolean; uncertainty?: string;
  /** When this run last had a process stopped for it; a same-run respawn is left alone. */
  stoppedAt?: string;
  /** The one visible record of a process this run's cleanup deliberately left alone. */
  leftAlone?: { reason: string; at: string };
}
const key = (id: string) => `runProcessCleanup:${id}`;
const terminal = (phase: string) => ["done", "cancelled"].includes(phase);

/**
 * How long after a stop a process carrying the same run identity is left alone
 * rather than stopped again. A retained agent host respawns its helper at once;
 * cleanup records that once and never loops on it.
 */
export const CLEANUP_RESPAWN_WINDOW_MS = 10 * 60_000;
/**
 * Longest a process-table or ownership-environment read may hold a sweep. A read
 * that never answers proves nothing, so the sweep treats it as unknown and keeps
 * its intents and scratch for a later pass instead of wedging the host lane.
 */
export const RUN_PROCESS_READ_BOUND_MS = 20_000;

/** Exact inherited ticket or scratch identity; a shared checkout is never ownership. */
export function processBelongsToRun(fact: HostProcessFact, environment: RunProcessEnvironment | null | undefined,
  run: CleanupRun, dataHome: string): boolean {
  const ticket = join(dataHome, "tickets", `${run.id}.json`);
  if ([environment?.NUCLEUS_TICKET, environment?.NUCLEUS_CONTINUATION_TICKET].includes(ticket)) return true;
  const scratch = run.temporaryDirectory;
  if (!scratch) return false;
  if ([environment?.TMPDIR, environment?.TMP, environment?.TEMP].includes(scratch)) return true;
  const escaped = scratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s='\"])${escaped}(?:/|$|[\\s'\"])`).test(fact.command);
}

/** Legacy non-host proof: an orphan executing a scratch artifact, not a host merely mentioning scratch. */
export function orphanExecutesRunScratch(fact: Pick<HostProcessFact, "ppid" | "command">, scratch: string | undefined): boolean {
  if (fact.ppid !== 1 || !scratch) return false;
  const args = fact.command.trim().match(/(?:"[^"]*"|'[^']*'|\S+)/g)?.map(arg => arg.replace(/^["']|["']$/g, "")) ?? [];
  const program = args[0];
  if (!program || /\.app[\\/]Contents[\\/]/i.test(program)
    || args.some(arg => /^--?(?:session[-_]id|working[-_](?:dir|directory))(?:=|$)/i.test(arg))) return false;
  const inside = (arg: string | undefined) => Boolean(arg && isAbsolute(arg) && resolve(arg).startsWith(`${resolve(scratch)}/`));
  if (inside(program)) return true;
  const interpreter = basename(program).toLowerCase();
  if (!/^(?:node|nodejs|bun|deno|python(?:3(?:\.\d+)?)?|sh|bash|zsh|dash|fish|perl|ruby)$/.test(interpreter)) return false;
  // Only a direct script operand proves execution. Flags, loaders, config paths,
  // cwd and inline expressions cannot establish that a provider is a tool.
  return inside(["bun", "deno"].includes(interpreter) && args[1] === "run" ? args[2] : args[1]);
}

type Ancestry = ReadonlyMap<number, Pick<HostProcessFact, "pid" | "ppid" | "state">>;

/**
 * True while nothing above this process in the snapshot is alive: init (or
 * launchd) owns it. Cleanup never signals a process that any live non-init
 * ancestor still owns — an agent host, its MCP or report helper, or a retained
 * thread's tools — whatever run identity that process carries. Only a process
 * whose whole ancestry has exited is an orphan a settled run can leave behind.
 */
export function initRootedProcess(fact: Pick<HostProcessFact, "pid" | "ppid">, byPid: Ancestry,
  alive: (pid: number) => boolean = pidAlive): boolean {
  const seen = new Set<number>([fact.pid]);
  let ppid = fact.ppid ?? 0;
  while (ppid > 1) {
    if (seen.has(ppid)) return false;
    seen.add(ppid);
    const parent = byPid.get(ppid);
    // A parent outside this uid's table is live unless the OS proves it exited:
    // nothing in the snapshot may claim that ancestry reached init.
    if (!parent) return !alive(ppid);
    // A zombie has stopped; only its own parent can reap it. Keep walking up.
    if (parent.state?.startsWith("Z")) { ppid = parent.ppid ?? 0; continue; }
    return false;
  }
  return true;
}

/** Settled runs, including pre-upgrade history. Pending intents retain displaced initial workers. */
function cleanupRuns(store: Store, hostId: string, taskId?: string): { settled: CleanupRun[]; live: CleanupRun[]; known: CleanupRun[] } {
  const settled = new Map<string, CleanupRun>();
  const live = new Map<string, CleanupRun>();
  const tasks = store.db.prepare("SELECT data FROM tasks WHERE json_extract(data,'$.hostId')=?").all(hostId);
  for (const row of tasks) {
    const task = JSON.parse(String(row.data));
    for (const retired of task.retiredWorkers ?? [])
      settled.set(retired.runId, { id: retired.runId, taskId: task.id, hostId, agentId: retired.agentId });
    if (!task.runId) continue;
    const run = { id: task.runId, taskId: task.id, hostId, agentId: task.agentId, temporaryDirectory: task.temporaryDirectory };
    (task.completion || terminal(task.phase) || task.removedAt ? settled : live).set(run.id, run);
  }
  for (const row of store.db.prepare("SELECT data FROM runs WHERE json_extract(data,'$.hostId')=?").all(hostId)) {
    const run = JSON.parse(String(row.data));
    const task = store.task(run.taskId);
    if (run.released || run.completion || terminal(task.phase) || task.removedAt) {
      settled.set(run.id, run); live.delete(run.id);
    } else { live.set(run.id, run); settled.delete(run.id); }
  }
  for (const row of store.db.prepare("SELECT value FROM meta WHERE key LIKE 'runProcessCleanup:%'").all()) {
    const run: CleanupRun = JSON.parse(String(row.value));
    if (run.hostId === hostId && !live.has(run.id)) settled.set(run.id, { ...run, ...settled.get(run.id) });
  }
  for (const id of live.keys()) settled.delete(id);
  return { settled: [...settled.values()].filter(run => !taskId || run.taskId === taskId), live: [...live.values()], known: [...settled.values(), ...live.values()] };
}

// A task lane and the periodic maintenance lane can reach the same run. Coalesce them per store.
const running = new WeakMap<Store, Promise<void>>();
export function sweepSettledRunProcesses(store: Store, hostId: string, options: {
  taskId?: string; pendingOnly?: boolean; graceMs?: number;
  readProcesses?: () => Promise<HostProcessFact[] | null>;
  readEnvironments?: typeof runProcessEnvironments;
  terminate?: typeof terminateHostProcessTargets;
  /** Longest one process read may hold the sweep; tests shorten it. */
  readBoundMs?: number;
  /** How long a same-run respawn is left alone after a stop; tests shorten it. */
  respawnWindowMs?: number;
} = {}): Promise<void> {
  const previous = running.get(store) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => sweep(store, hostId, options));
  running.set(store, next);
  void next.finally(() => { if (running.get(store) === next) running.delete(store); }).catch(() => {});
  return next;
}

/** One read that never answers proves nothing; the sweep then answers unknown. */
async function boundedRead<T>(read: () => Promise<T>, boundMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), boundMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Whether this host owes a settled run's process cleanup. A host with no owed
 * intent costs no process read: the quantum asks this before queueing a sweep.
 */
export function hostOwesRunProcessCleanup(store: Store, hostId: string): boolean {
  return cleanupRuns(store, hostId).settled.some(run => store.getMeta<CleanupRun>(key(run.id))?.pending === true);
}

/** One process-table snapshot per sweep, shared by every run it settles. */
async function snapshot(store: Store, options: Parameters<typeof sweepSettledRunProcesses>[2]): Promise<HostProcessFact[] | null> {
  const readBoundMs = options?.readBoundMs ?? RUN_PROCESS_READ_BOUND_MS;
  return boundedRead(() => options?.readProcesses
    ? options.readProcesses()
    : readHostUidProcesses().then(read => read.state === "listed" ? read.processes : null), readBoundMs);
}

const factKey = (fact: { pid: number; startIdentity: string }) => `${fact.pid}@${fact.startIdentity}`;

async function sweep(store: Store, hostId: string, options: Parameters<typeof sweepSettledRunProcesses>[2], round = 0,
  startedAt = Date.now(), beforeStop?: ReadonlySet<string>): Promise<void> {
  const candidates = cleanupRuns(store, hostId, options?.taskId);
  const runs = candidates.settled.filter(run => {
    const intent = store.getMeta<CleanupRun>(key(run.id));
    // A cleanup that proved itself complete is settled: no later sweep, hourly
    // or per pass, reads the process table for it again.
    if (intent?.pending === false) return false;
    // A per-pass sweep only owes runs that recorded an intent; the hourly one
    // also retries history that predates the intent.
    return !options?.pendingOnly || Boolean(intent);
  });
  if (!runs.length && !candidates.live.some(run => !options?.taskId || run.taskId === options.taskId)) return;
  const facts = await snapshot(store, options);
  if (!facts) return; // Intents and scratch survive an unavailable observation.
  rememberRunProcessHosts(store, candidates.known, facts);
  if (!runs.length) return;
  const byPid: Ancestry = new Map(facts.map(fact => [fact.pid, fact]));
  const dataHome = dirname(store.path);
  const live = facts.filter(fact => !fact.state?.startsWith("Z"));
  // The one ownership question this table answers: what init owns outright.
  const rooted = new Set(live.filter(fact => initRootedProcess(fact, byPid)).map(fact => fact.pid));
  // A live non-init ancestor is an owner: these are never cleanup targets.
  const liveAncestor = new Set(facts.filter(fact => !rooted.has(fact.pid) && !fact.state?.startsWith("Z")).map(fact => fact.pid));
  const infrastructure = protectedRunInfrastructure(store, candidates.known, facts);
  // One ownership read for the whole snapshot, shared by every run it settles:
  // never a read per run or per check.
  const livePids = live.map(fact => fact.pid);
  const environments = livePids.length
    ? await boundedRead(() => (options?.readEnvironments ?? runProcessEnvironments)(livePids), options?.readBoundMs ?? RUN_PROCESS_READ_BOUND_MS)
      ?? new Map<number, RunProcessEnvironment | null>(livePids.map(pid => [pid, null]))
    : new Map<number, RunProcessEnvironment | null>();
  const protectedPids = protectedHostPids(new Set([...infrastructure, ...liveAncestor]));
  const respawnWindowMs = options?.respawnWindowMs ?? CLEANUP_RESPAWN_WINDOW_MS;
  // A process that was not in the snapshot this sweep started from appeared
  // while stopping: the live host started it again, so it is recorded once and
  // left alone rather than chased by another round.
  const existed = beforeStop ?? new Set(facts.map(factKey));
  let stopped = false;
  for (const run of runs) {
    // A run may have resumed while the OS reads were in flight.
    const stillSettled = () => {
      const current = store.run(run.id);
      if (run.agentId && store.unreleasedRunsForAgent(run.agentId, hostId).some(other => other.id !== run.id && !other.completion)) return false;
      const task = store.task(run.taskId);
      if (run.agentId && task.agentId === run.agentId && task.runId !== run.id && task.runId && !task.completion && !terminal(task.phase)) return false;
      if (terminal(task.phase) || task.removedAt) return true;
      if (current) return Boolean(current.released || current.completion);
      return task.runId !== run.id || Boolean(task.completion);
    };
    if (!stillSettled()) continue;
    // A retained thread's next turn inherits its first launch environment. An
    // earlier ticket must never give custody over that next turn's tools.
    if (run.agentId && candidates.live.some(live => live.agentId === run.agentId)) continue;
    const ownedFacts = facts.filter(fact => !protectedPids.has(fact.pid) && !fact.state?.startsWith("Z")
      && processBelongsToRun(fact, environments.get(fact.pid), run, dataHome)
      && !candidates.live.some(live => processBelongsToRun(fact, environments.get(fact.pid), live, dataHome)));
    // Saved host identities remain a positive exclusion after the helper exits.
    // With no observed host, an environment-only holder can still be that host.
    // A scratch command cannot rule out a different live run's inherited
    // identity when its environment is unreadable. Unknown start identities
    // also remain owned evidence, but cannot authorize a signal.
    const eligible = ownedFacts.filter(fact => rooted.has(fact.pid) && environments.get(fact.pid) != null
      && !fact.startIdentity.endsWith("@unknown") && fact.command.trim()
      && (hasRunProcessHost(store, run) || orphanExecutesRunScratch(fact, run.temporaryDirectory)));
    const intent = store.getMeta<CleanupRun>(key(run.id));
    // A process this run already lost to a stop, seen again within the window, is
    // recorded once and left alone: the live host respawned it, so stopping it
    // again only repeats the same loop.
    const lastStop = intent?.stoppedAt ? Date.parse(intent.stoppedAt) : Number.NaN;
    if (eligible.length && Number.isFinite(lastStop) && lastStop < startedAt && startedAt - lastStop < respawnWindowMs) {
      recordLeftAlone(store, run, hostId, "respawned-after-stop", eligible, startedAt);
      continue;
    }
    const respawned = round > 0 ? eligible.filter(fact => !existed.has(factKey(fact))) : [];
    if (respawned.length) recordLeftAlone(store, run, hostId, "respawned-after-stop", respawned, startedAt);
    const owned = respawned.length ? eligible.filter(fact => !respawned.some(item => item.pid === fact.pid)) : eligible;
    const result = await (options?.terminate ?? terminateHostProcessTargets)(owned.map(fact => ({ ...fact, cwd: fact.cwd ?? "", startTime: fact.startIdentity, via: "cwd" as const })),
      { graceMs: options?.graceMs, identityLiveness: (pid, identity) => stillSettled() ? runProcessLiveness(pid, identity) : "unknown" });
    // A target whose identity is proved dead has already exited: a re-read that
    // still lists it is not a survivor to retry, or a sweep would keep the
    // scratch of a process it just stopped.
    const failed = result.failed.filter(fact => runProcessLiveness(fact.pid, fact.startIdentity) !== "dead");
    if (result.terminated.length || failed.length) store.event(run.taskId, "run_process_cleanup", JSON.stringify({ runId: run.id,
      stopped: result.terminated.map(fact => ({ pid: fact.pid, startIdentity: fact.startIdentity })),
      survivors: failed.map(fact => ({ pid: fact.pid, startIdentity: fact.startIdentity, reason: fact.reason })) }));
    stopped ||= result.terminated.length > 0;
    if (result.terminated.length) recordStop(store, run, hostId, startedAt);
    // A failed per-process read (including a failed ps chunk) is not a negative
    // ownership proof. Only tools with complete identity can be stopped.
    const unknown = facts.filter(fact => !fact.state?.startsWith("Z")
      && environments.get(fact.pid) == null && (fact.startIdentity.endsWith("@unknown") || runProcessLiveness(fact.pid, fact.startIdentity) !== "dead"));
    const ambiguous = ownedFacts.filter(fact => !eligible.some(target => target.pid === fact.pid));
    if (unknown.length || ambiguous.length || failed.length) {
      const reason = unknown.length ? "process environment ownership is unreadable"
        : ambiguous.some(fact => fact.startIdentity.endsWith("@unknown")) ? "owned process start identity is unreadable"
        : ambiguous.length ? "process command or agent host identity has not been observed" : "owned processes could not be stopped";
      deferCleanup(store, run, reason, unknown.length ? unknown : ambiguous.length ? ambiguous : failed);
      continue;
    }
    if (result.terminated.length || respawned.length) continue;
    if (!stillSettled()) continue;
    // A live non-init ancestor still owns a process carrying this run's identity:
    // its next turn may use the scratch, so the leaf stays until that owner exits.
    const retainedByAncestor = facts.filter(fact => liveAncestor.has(fact.pid) && environments.get(fact.pid) !== undefined
      && processBelongsToRun(fact, environments.get(fact.pid), run, dataHome));
    if (retainedByAncestor.length) { recordLeftAlone(store, run, hostId, "live-ancestor", retainedByAncestor, startedAt); continue; }
    // A protected standing runtime can still use the launch leaf. Retire that
    // leaf only after the host releases it, rather than breaking its next turn.
    if (run.temporaryDirectory && facts.some(fact => protectedPids.has(fact.pid) && processBelongsToRun(fact, environments.get(fact.pid), run, dataHome)
      && [environments.get(fact.pid)?.TMPDIR, environments.get(fact.pid)?.TMP, environments.get(fact.pid)?.TEMP].includes(run.temporaryDirectory))) continue;
    if (run.temporaryDirectory && !store.removeRunScratchAfterProcesses(run.temporaryDirectory)) continue;
    // Retain a displaced initial worker's identity for historical sweeps even
    // after its task row moves to another run; support runs also have run rows.
    if (store.getMeta<CleanupRun>(key(run.id))?.pending !== false)
      store.setMeta(key(run.id), { id: run.id, taskId: run.taskId, hostId, agentId: run.agentId, temporaryDirectory: run.temporaryDirectory, pending: false });
  }
  // A tool can start another child while stopping. Re-read before deleting
  // scratch; a bounded pass retains anything still live for retry.
  if (stopped && round < 8) await sweep(store, hostId, options, round + 1, startedAt, existed);
}

/** Remember the one stop that makes a same-run respawn "seen again". */
function recordStop(store: Store, run: CleanupRun, hostId: string, at: number): void {
  const intent = store.getMeta<CleanupRun>(key(run.id)) ?? { id: run.id, taskId: run.taskId, hostId, agentId: run.agentId, temporaryDirectory: run.temporaryDirectory, pending: true };
  store.setMeta(key(run.id), { ...intent, stoppedAt: new Date(at).toISOString() });
}

/**
 * Record the one process set this run's cleanup left alone, and why. A live
 * ancestor is recorded once while it stands; a respawn after a stop is recorded
 * once per window, so repeated sweeps add nothing to the task timeline.
 */
function recordLeftAlone(store: Store, run: CleanupRun, hostId: string, reason: string,
  facts: Array<{ pid: number; startIdentity: string }>, at: number): void {
  const intent = store.getMeta<CleanupRun>(key(run.id));
  const previous = intent?.leftAlone;
  if (previous?.reason === reason && (reason === "live-ancestor" || at - Date.parse(previous.at) < CLEANUP_RESPAWN_WINDOW_MS)) return;
  store.event(run.taskId, "run_process_cleanup_left_alone", JSON.stringify({ runId: run.id, reason,
    processes: facts.map(fact => ({ pid: fact.pid, startIdentity: fact.startIdentity })) }));
  store.setMeta(key(run.id), { ...(intent ?? { id: run.id, taskId: run.taskId, hostId, agentId: run.agentId,
    temporaryDirectory: run.temporaryDirectory }), pending: intent?.pending ?? true, leftAlone: { reason, at: new Date(at).toISOString() } });
}

function deferCleanup(store: Store, run: CleanupRun, reason: string, facts: Array<{ pid: number; startIdentity: string }>): void {
  const uncertainty = JSON.stringify({ reason, processes: facts.map(fact => ({ pid: fact.pid, startIdentity: fact.startIdentity })) });
  if (store.getMeta<CleanupRun>(key(run.id))?.uncertainty === uncertainty) return;
  store.event(run.taskId, "run_process_cleanup_deferred", JSON.stringify({ runId: run.id, ...JSON.parse(uncertainty) }));
  store.setMeta(key(run.id), { id: run.id, taskId: run.taskId, hostId: run.hostId, agentId: run.agentId, temporaryDirectory: run.temporaryDirectory, pending: true, uncertainty });
}
