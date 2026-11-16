import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Store } from "../store/store";
import type { HostProcessFact } from "../host/types";
import { readHostUidProcesses } from "./host-process-listing";
import { runProcessEnvironments, runProcessLiveness, type RunProcessEnvironment } from "./run-process-identity";
import { hasRunProcessHost, protectedRunInfrastructure, rememberRunProcessHosts } from "./run-process-hosts";
import { protectedHostPids } from "./host-process-select";
import { terminateHostProcessTargets } from "./host-process-reap";

interface CleanupRun { id: string; taskId: string; hostId?: string; agentId?: string | null; temporaryDirectory?: string; pending?: boolean; uncertainty?: string }
const key = (id: string) => `runProcessCleanup:${id}`;
const terminal = (phase: string) => ["done", "cancelled"].includes(phase);

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
} = {}): Promise<void> {
  const previous = running.get(store) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => sweep(store, hostId, options));
  running.set(store, next);
  void next.finally(() => { if (running.get(store) === next) running.delete(store); }).catch(() => {});
  return next;
}

async function sweep(store: Store, hostId: string, options: Parameters<typeof sweepSettledRunProcesses>[2], round = 0): Promise<void> {
  const candidates = cleanupRuns(store, hostId, options?.taskId);
  const runs = candidates.settled.filter(run => {
    const intent = store.getMeta<CleanupRun>(key(run.id));
    return !options?.pendingOnly || Boolean(intent && intent.pending !== false);
  });
  if (!runs.length && !candidates.live.some(run => !options?.taskId || run.taskId === options.taskId)) return;
  const facts = options?.readProcesses ? await options.readProcesses() : await readHostUidProcesses().then(read => read.state === "listed" ? read.processes : null);
  if (!facts) return; // Intents and scratch survive an unavailable observation.
  rememberRunProcessHosts(store, candidates.known, facts);
  if (!runs.length) return;
  const environments = await (options?.readEnvironments ?? runProcessEnvironments)(facts.map(fact => fact.pid));
  const protectedPids = protectedHostPids(protectedRunInfrastructure(store, candidates.known, facts));
  const dataHome = dirname(store.path);
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
      && !fact.startIdentity.endsWith("@unknown") && processBelongsToRun(fact, environments.get(fact.pid), run, dataHome)
      && !candidates.live.some(live => processBelongsToRun(fact, environments.get(fact.pid), live, dataHome)));
    // Saved host identities remain a positive exclusion after the helper exits.
    // With no observed host, an environment-only holder can still be that host.
    const owned = ownedFacts.filter(fact => fact.command.trim() && (hasRunProcessHost(store, run) || orphanExecutesRunScratch(fact, run.temporaryDirectory)));
    const result = await (options?.terminate ?? terminateHostProcessTargets)(owned.map(fact => ({ ...fact, cwd: fact.cwd ?? "", startTime: fact.startIdentity, via: "cwd" as const })),
      { graceMs: options?.graceMs, identityLiveness: (pid, identity) => stillSettled() ? runProcessLiveness(pid, identity) : "unknown" });
    if (result.terminated.length || result.failed.length) store.event(run.taskId, "run_process_cleanup", JSON.stringify({ runId: run.id,
      stopped: result.terminated.map(fact => ({ pid: fact.pid, startIdentity: fact.startIdentity })),
      survivors: result.failed.map(fact => ({ pid: fact.pid, startIdentity: fact.startIdentity, reason: fact.reason })) }));
    stopped ||= result.terminated.length > 0;
    // A failed per-process read (including a failed ps chunk) is not a negative
    // ownership proof. Stop known tools, but never remove scratch on this gap.
    const unknown = facts.filter(fact => !fact.state?.startsWith("Z")
      && environments.get(fact.pid) == null && runProcessLiveness(fact.pid, fact.startIdentity) !== "dead");
    const ambiguous = ownedFacts.filter(fact => !owned.some(target => target.pid === fact.pid));
    if (unknown.length || ambiguous.length || result.failed.length) {
      const reason = unknown.length ? "process environment ownership is unreadable"
        : ambiguous.length ? "process command or agent host identity has not been observed" : "owned processes could not be stopped";
      deferCleanup(store, run, reason, unknown.length ? unknown : ambiguous.length ? ambiguous : result.failed);
      continue;
    }
    if (result.terminated.length) continue;
    if (!stillSettled()) continue;
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
  if (stopped && round < 8) await sweep(store, hostId, options, round + 1);
}

function deferCleanup(store: Store, run: CleanupRun, reason: string, facts: Array<{ pid: number; startIdentity: string }>): void {
  const uncertainty = JSON.stringify({ reason, processes: facts.map(fact => ({ pid: fact.pid, startIdentity: fact.startIdentity })) });
  if (store.getMeta<CleanupRun>(key(run.id))?.uncertainty === uncertainty) return;
  store.event(run.taskId, "run_process_cleanup_deferred", JSON.stringify({ runId: run.id, ...JSON.parse(uncertainty) }));
  store.setMeta(key(run.id), { id: run.id, taskId: run.taskId, hostId: run.hostId, agentId: run.agentId, temporaryDirectory: run.temporaryDirectory, pending: true, uncertainty });
}
