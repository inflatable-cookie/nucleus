import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { Store } from "../store/store";
import type { HostProcessFact } from "../host/types";
import type { Run, Task } from "../../shared/contracts";
import { readHostUidProcesses } from "./host-process-listing";
import { pidAlive } from "./pid";
import {
  runProcessEnvironments,
  listedProcessLiveness,
  refreshedRunProcessLiveness,
  type RunProcessEnvironment,
} from "./run-process-identity";
import {
  protectedRunInfrastructure,
  rememberRunProcessHosts,
} from "./run-process-hosts";
import {
  RunProcessTable,
  possibleParticipantRuntimePids,
} from "./run-process-tree";
import { protectedHostPids } from "./host-process-select";
import { terminateHostProcessTargets } from "./host-process-reap";

interface CleanupRun {
  id: string;
  taskId: string;
  hostId?: string;
  agentId?: string | null;
  temporaryDirectory?: string;
  pending?: boolean;
  uncertainty?: string;
  /** When this run last had a process stopped for it; a same-run respawn is left alone. */
  stoppedAt?: string;
  /**
   * The one visible record of a process this run's cleanup deliberately left
   * alone, with the exact processes that decision was made for: the same
   * decision over the same processes writes nothing new.
   */
  leftAlone?: {
    reason: string;
    at: string;
    processes?: Array<{ pid: number; startIdentity: string }>;
  };
  /**
   * The uncertainty the last `run_process_cleanup_deferred` event recorded. A
   * left-alone record clears `uncertainty` for display, so this, not that, says
   * whether a deferral is news.
   */
  deferred?: string;
}
const key = (id: string) => `runProcessCleanup:${id}`;
const terminal = (phase: string) => ["done", "cancelled"].includes(phase);
const settledTask = (task: Task) =>
  Boolean(task.completion || terminal(task.phase) || task.removedAt);
const settledRun = (run: Run, task: Task) =>
  Boolean(
    run.released || run.completion || terminal(task.phase) || task.removedAt,
  );

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

/**
 * A provider host the host daemon started and keeps across runs: the provider's
 * own `app-server`/tool-host shape, whose parent carries none of this run's
 * identity. The daemon hands it the thread's launch environment, so it still
 * carries that run's ticket and scratch after the run released — it was started
 * for that thread — but it owns neither. It is host infrastructure: never a
 * released run's live ancestor, so its inherited identity neither holds the
 * scratch nor repeats a left-alone record (nucleus#1372).
 *
 * Only a readable parent environment answers this: an unreadable one keeps the
 * conservative live-ancestor hold, because nothing then rules out a run's own
 * owner. A provider host some run's own process started is not one of these: its
 * parent carries that run's identity and the existing runtime protection owns it.
 */
export function hostDaemonProviderHost(
  fact: Pick<HostProcessFact, "pid" | "ppid">,
  providerHosts: ReadonlySet<number>,
  environments: ReadonlyMap<number, RunProcessEnvironment | null>,
  table: Readonly<{ byPid: ReadonlyMap<number, HostProcessFact> }>,
  run: CleanupRun,
  dataHome: string,
): boolean {
  if (!providerHosts.has(fact.pid)) return false;
  const parent = table.byPid.get(fact.ppid ?? 0);
  const environment = environments.get(fact.ppid ?? 0);
  if (!parent || environment == null) return false;
  return !processBelongsToRun(parent, environment, run, dataHome);
}

/** Exact inherited ticket or scratch identity; a shared checkout is never ownership. */
export function processBelongsToRun(
  fact: HostProcessFact,
  environment: RunProcessEnvironment | null | undefined,
  run: CleanupRun,
  dataHome: string,
): boolean {
  if (environment?.NUCLEUS_TICKET || environment?.NUCLEUS_CONTINUATION_TICKET) {
    const ticket = join(dataHome, "tickets", `${run.id}.json`);
    if (
      environment.NUCLEUS_TICKET === ticket ||
      environment.NUCLEUS_CONTINUATION_TICKET === ticket
    )
      return true;
  }
  const scratch = run.temporaryDirectory;
  if (!scratch) return false;
  if (
    [environment?.TMPDIR, environment?.TMP, environment?.TEMP].includes(scratch)
  )
    return true;
  if (!fact.command.includes(scratch)) return false;
  const escaped = scratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s='\"])${escaped}(?:/|$|[\\s'\"])`).test(
    fact.command,
  );
}

/** Legacy non-host proof: an orphan executing a scratch artifact, not a host merely mentioning scratch. */
export function orphanExecutesRunScratch(
  fact: Pick<HostProcessFact, "ppid" | "command">,
  scratch: string | undefined,
): boolean {
  if (fact.ppid !== 1 || !scratch) return false;
  const args =
    fact.command
      .trim()
      .match(/(?:"[^"]*"|'[^']*'|\S+)/g)
      ?.map((arg) => arg.replace(/^["']|["']$/g, "")) ?? [];
  const program = args[0];
  if (
    !program ||
    /\.app[\\/]Contents[\\/]/i.test(program) ||
    args.some((arg) =>
      /^--?(?:session[-_]id|working[-_](?:dir|directory))(?:=|$)/i.test(arg),
    )
  )
    return false;
  const inside = (arg: string | undefined) =>
    Boolean(
      arg && isAbsolute(arg) && resolve(arg).startsWith(`${resolve(scratch)}/`),
    );
  if (inside(program)) return true;
  const interpreter = basename(program).toLowerCase();
  if (
    !/^(?:node|nodejs|bun|deno|python(?:3(?:\.\d+)?)?|sh|bash|zsh|dash|fish|perl|ruby)$/.test(
      interpreter,
    )
  )
    return false;
  // Only a direct script operand proves execution. Flags, loaders, config paths,
  // cwd and inline expressions cannot establish that a provider is a tool.
  return inside(
    ["bun", "deno"].includes(interpreter) && args[1] === "run"
      ? args[2]
      : args[1],
  );
}

type Ancestry = ReadonlyMap<
  number,
  Pick<HostProcessFact, "pid" | "ppid" | "state">
>;

/**
 * True while nothing above this process in the snapshot is alive: init (or
 * launchd) owns it. Cleanup never signals a process that any live non-init
 * ancestor still owns — an agent host, its MCP or report helper, or a retained
 * thread's tools — whatever run identity that process carries. Only a process
 * whose whole ancestry has exited is an orphan a settled run can leave behind.
 */
export function initRootedProcess(
  fact: Pick<HostProcessFact, "pid" | "ppid">,
  byPid: Ancestry,
  alive: (pid: number) => boolean = pidAlive,
): boolean {
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
    if (parent.state?.startsWith("Z")) {
      ppid = parent.ppid ?? 0;
      continue;
    }
    return false;
  }
  return true;
}

/** Settled runs, including pre-upgrade history. Pending intents retain displaced initial workers. */
function cleanupRuns(store: Store, hostId: string) {
  const settled = new Map<string, CleanupRun>();
  const live = new Map<string, CleanupRun>();
  const byTask = new Map<string, Task>();
  const intents = new Map<string, CleanupRun>();
  const tasks = store.db
    .prepare("SELECT data FROM tasks WHERE json_extract(data,'$.hostId')=?")
    .all(hostId);
  for (const row of tasks) {
    const task: Task = JSON.parse(String(row.data));
    byTask.set(task.id, task);
    for (const retired of task.retiredWorkers ?? [])
      settled.set(retired.runId, {
        id: retired.runId,
        taskId: task.id,
        hostId,
        agentId: retired.agentId,
      });
    if (!task.runId) continue;
    const run = {
      id: task.runId,
      taskId: task.id,
      hostId,
      agentId: task.agentId,
      temporaryDirectory: task.temporaryDirectory,
    };
    (settledTask(task) ? settled : live).set(run.id, run);
  }
  for (const row of store.db
    .prepare("SELECT data FROM runs WHERE json_extract(data,'$.hostId')=?")
    .all(hostId)) {
    const run: Run = JSON.parse(String(row.data));
    const task = byTask.get(run.taskId) ?? store.task(run.taskId);
    if (settledRun(run, task)) {
      settled.set(run.id, run);
      live.delete(run.id);
    } else {
      live.set(run.id, run);
      settled.delete(run.id);
    }
  }
  for (const row of store.db
    .prepare("SELECT value FROM meta WHERE key GLOB 'runProcessCleanup:*'")
    .all()) {
    const run: CleanupRun = JSON.parse(String(row.value));
    intents.set(run.id, run);
    if (run.hostId === hostId && !live.has(run.id))
      settled.set(run.id, { ...run, ...settled.get(run.id) });
  }
  for (const id of live.keys()) settled.delete(id);
  return { settled: [...settled.values()], live: [...live.values()], intents };
}

// A task lane and the periodic maintenance lane can reach the same run. Coalesce them per store.
const running = new WeakMap<Store, Promise<void>>();
export function sweepSettledRunProcesses(
  store: Store,
  hostId: string,
  options: {
    taskId?: string;
    pendingOnly?: boolean;
    graceMs?: number;
    readProcesses?: () => Promise<HostProcessFact[] | null>;
    readEnvironments?: typeof runProcessEnvironments;
    terminate?: typeof terminateHostProcessTargets;
    /** Longest one process read may hold the sweep; tests shorten it. */
    readBoundMs?: number;
    /** How long a same-run respawn is left alone after a stop; tests shorten it. */
    respawnWindowMs?: number;
  } = {},
): Promise<void> {
  const previous = running.get(store) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => sweep(store, hostId, options));
  running.set(store, next);
  void next
    .finally(() => {
      if (running.get(store) === next) running.delete(store);
    })
    .catch(() => {});
  return next;
}

/** One read that never answers proves nothing; the sweep then answers unknown. */
async function boundedRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  boundMs: number,
): Promise<T | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => read(controller.signal))
        .catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          resolve(null);
          controller.abort();
        }, boundMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Shortest gap between two per-pass sweeps of one host. The host pass schedules
 * one sweep each pass; a task quantum asks for another only after this long, so
 * records that stay pending cost about one sweep per pass, not one per quantum.
 */
export const RUN_PROCESS_SWEEP_MIN_INTERVAL_MS = 15_000;
const sweepClaims = new WeakMap<Store, Map<string, number>>();

/**
 * Claim this host's next per-pass sweep. The host pass always claims (`force`),
 * since its sweep also records live runs' host identities; a quantum's claim is
 * refused until the interval has passed since the last one.
 */
export function claimRunProcessSweep(
  store: Store,
  hostId: string,
  options: { force?: boolean; now?: number; minIntervalMs?: number } = {},
): boolean {
  const now = options.now ?? Date.now();
  let claims = sweepClaims.get(store);
  if (!claims) sweepClaims.set(store, (claims = new Map()));
  const last = claims.get(hostId);
  if (
    !options.force &&
    last !== undefined &&
    now - last < (options.minIntervalMs ?? RUN_PROCESS_SWEEP_MIN_INTERVAL_MS)
  )
    return false;
  claims.set(hostId, now);
  return true;
}

/**
 * Whether this host owes a settled run's process cleanup. A host with no owed
 * intent costs no process read: the quantum asks this before queueing a sweep.
 */
export function hostOwesRunProcessCleanup(
  store: Store,
  hostId: string,
): boolean {
  // The quantum needs only a pending occurrence. Read the matching intent
  // and its two indexed bindings instead of rebuilding the fleet's run list.
  const pending = store.db.prepare(`
    SELECT m.value AS intent, r.data AS run, t.data AS task
    FROM meta m
    LEFT JOIN runs r ON r.id=json_extract(m.value,'$.id')
    LEFT JOIN tasks t ON t.id=json_extract(m.value,'$.taskId')
    WHERE m.key GLOB 'runProcessCleanup:*' AND json_type(m.value,'$.pending')='true'
      AND ?1 IN (json_extract(m.value,'$.hostId'), json_extract(r.data,'$.hostId'), json_extract(t.data,'$.hostId'))
  `);
  for (const row of pending.iterate(hostId)) {
    const intent: CleanupRun = JSON.parse(String(row.intent));
    const run: Run | null = row.run ? JSON.parse(String(row.run)) : null;
    const task: Task | null = row.task ? JSON.parse(String(row.task)) : null;
    if (run?.hostId === hostId && task) {
      if (settledRun(run, task)) return true;
      continue;
    }
    if (task?.hostId === hostId && task.runId === intent.id) {
      if (settledTask(task)) return true;
      continue;
    }
    if (
      intent.hostId === hostId ||
      (task?.hostId === hostId &&
        task.retiredWorkers?.some((retired) => retired.runId === intent.id))
    )
      return true;
  }
  return false;
}

/** One process-table snapshot per sweep, shared by every run it settles. */
async function snapshot(
  options: Parameters<typeof sweepSettledRunProcesses>[2],
): Promise<HostProcessFact[] | null> {
  const readBoundMs = options?.readBoundMs ?? RUN_PROCESS_READ_BOUND_MS;
  return boundedRead(
    () =>
      options?.readProcesses
        ? options.readProcesses()
        : readHostUidProcesses().then((read) =>
            read.state === "listed" ? read.processes : null,
          ),
    readBoundMs,
  );
}

const factKey = (fact: { pid: number; startIdentity: string }) =>
  `${fact.pid}@${fact.startIdentity}`;

async function sweep(
  store: Store,
  hostId: string,
  options: Parameters<typeof sweepSettledRunProcesses>[2],
  round = 0,
  startedAt = Date.now(),
  beforeStop?: ReadonlySet<string>,
): Promise<void> {
  const candidates = cleanupRuns(store, hostId);
  const runs = candidates.settled.filter((run) => {
    if (options?.taskId && run.taskId !== options.taskId) return false;
    const intent = candidates.intents.get(run.id);
    // A cleanup that proved itself complete is settled: no later sweep, hourly
    // or per pass, reads the process table for it again.
    if (intent?.pending === false) return false;
    // A per-pass sweep only owes runs that recorded an intent; the hourly one
    // also retries history that predates the intent.
    return !options?.pendingOnly || Boolean(intent);
  });
  for (const live of candidates.live) {
    if (
      (!options?.taskId || live.taskId === options.taskId) &&
      candidates.intents.get(live.id)?.pending === true
    )
      deferReason(store, live, "run or its participant is active");
  }
  if (
    !runs.length &&
    !candidates.live.some(
      (run) => !options?.taskId || run.taskId === options.taskId,
    )
  )
    return;
  const facts = await snapshot(options);
  if (!facts) {
    for (const run of runs)
      if (candidates.intents.get(run.id)?.pending === true)
        deferReason(store, run, "process table observation is unavailable");
    return;
  }
  const table = new RunProcessTable(facts);
  const dirsRead = await boundedRead(async (signal) => {
    await table.readProgramDirectories(signal);
    return true;
  }, options?.readBoundMs ?? RUN_PROCESS_READ_BOUND_MS);
  if (!dirsRead) {
    for (const run of runs)
      if (candidates.intents.get(run.id)?.pending === true)
        deferReason(
          store,
          run,
          "process executable observation is unavailable",
        );
    return; // Executable identity also belongs to the observation window.
  }
  const known = [...candidates.settled, ...candidates.live];
  const records = store.transaction(() =>
    rememberRunProcessHosts(store, known, facts, table),
  );
  if (!runs.length) return;
  // Every liveness and identity answer below reads this one table. A sweep spawns
  // no synchronous `ps`: the profile's dominant stack was
  // `sweep → runProcessLiveness → processStartIdentityLiveness → startLine →
  // spawnSync` (nucleus#1329). Signalling still proves an identity now, from one
  // bounded spawned read for exactly the targets.
  const tableLiveness = listedProcessLiveness(facts);
  const dataHome = dirname(store.path);
  const live = facts.filter((fact) => !fact.state?.startsWith("Z"));
  // The one ownership question this table answers: what init owns outright.
  const rooted = new Set(
    live
      .filter((fact) => initRootedProcess(fact, table.byPid))
      .map((fact) => fact.pid),
  );
  // A live non-init ancestor is an owner: these are never cleanup targets.
  const liveAncestor = new Set(
    facts
      .filter((fact) => !rooted.has(fact.pid) && !fact.state?.startsWith("Z"))
      .map((fact) => fact.pid),
  );
  const infrastructure = protectedRunInfrastructure(
    store,
    known,
    facts,
    table,
    records,
  );
  // The provider hosts the host daemon started and keeps, decided from this
  // snapshot alone: they inherit a thread's run identity without owning it.
  const providerHosts = table.providerHostPids();
  // One ownership read for the whole snapshot, shared by every run it settles:
  // never a read per run or per check.
  const livePids = live.map((fact) => fact.pid);
  const environments = livePids.length
    ? ((await boundedRead(
        (signal) =>
          (options?.readEnvironments ?? runProcessEnvironments)(livePids, {
            signal,
          }),
        options?.readBoundMs ?? RUN_PROCESS_READ_BOUND_MS,
      )) ??
      new Map<number, RunProcessEnvironment | null>(
        livePids.map((pid) => [pid, null]),
      ))
    : new Map<number, RunProcessEnvironment | null>();
  const protectedPids = protectedHostPids(
    new Set([
      ...infrastructure,
      ...liveAncestor,
      // A host task runtime whose identity this snapshot cannot prove — an ACP
      // parent, its role sessions — is never a released run's tool.
      ...possibleParticipantRuntimePids(facts),
    ]),
  );
  const unprotected = live.filter((fact) => !protectedPids.has(fact.pid));
  const protectedFacts = facts.filter((fact) => protectedPids.has(fact.pid));
  const retainedFacts = live.filter(
    (fact) => liveAncestor.has(fact.pid) && environments.has(fact.pid),
  );
  const liveAgents = new Set(candidates.live.map((run) => run.agentId));
  const claimedByLive = new Map<number, boolean>();
  // Unknown ownership is a property of this observation, shared even when
  // the unknown process has no command or belongs to another run.
  const unknown = live.filter(
    (fact) =>
      environments.get(fact.pid) == null &&
      (fact.startIdentity.endsWith("@unknown") ||
        (tableLiveness(fact.pid, fact.startIdentity) !== "dead" &&
          pidAlive(fact.pid))),
  );
  const respawnWindowMs = options?.respawnWindowMs ?? CLEANUP_RESPAWN_WINDOW_MS;
  // A process that was not in the snapshot this sweep started from appeared
  // while stopping: the live host started it again, so it is recorded once and
  // left alone rather than chased by another round.
  const existed = beforeStop ?? new Set(facts.map(factKey));
  let stopped = false;
  for (const [index, run] of runs.entries()) {
    if (index > 0 && index % 32 === 0) await yieldToLoop();
    // A run may have resumed while the OS reads were in flight.
    const stillSettled = () => {
      const current = store.run(run.id);
      if (
        run.agentId &&
        store
          .unreleasedRunsForAgent(run.agentId, hostId)
          .some((other) => other.id !== run.id && !other.completion)
      )
        return false;
      const task = store.task(run.taskId);
      if (
        run.agentId &&
        task.agentId === run.agentId &&
        task.runId !== run.id &&
        task.runId &&
        !task.completion &&
        !terminal(task.phase)
      )
        return false;
      if (terminal(task.phase) || task.removedAt) return true;
      if (current) return Boolean(current.released || current.completion);
      return task.runId !== run.id || Boolean(task.completion);
    };
    if (!stillSettled()) {
      deferReason(store, run, "run or its participant is active");
      continue;
    }
    // A retained thread's next turn inherits its first launch environment. An
    // earlier ticket must never give custody over that next turn's tools.
    if (run.agentId && liveAgents.has(run.agentId)) {
      deferReason(store, run, "a live run shares this agent");
      continue;
    }
    const ownedFacts = unprotected.filter((fact) => {
      const environment = environments.get(fact.pid);
      if (!processBelongsToRun(fact, environment, run, dataHome)) return false;
      let claimed = claimedByLive.get(fact.pid);
      if (claimed === undefined) {
        claimed = candidates.live.some((live) =>
          processBelongsToRun(fact, environment, live, dataHome),
        );
        claimedByLive.set(fact.pid, claimed);
      }
      return !claimed;
    });
    // Saved host identities remain a positive exclusion after the helper exits.
    // With no observed host, an environment-only holder can still be that host.
    // A scratch command cannot rule out a different live run's inherited
    // identity when its environment is unreadable. Unknown start identities
    // also remain owned evidence, but cannot authorize a signal. A per-run report
    // bridge whose provider has exited is the run's own leftover even when no
    // host was ever recorded for it.
    const eligible = ownedFacts.filter(
      (fact) =>
        rooted.has(fact.pid) &&
        environments.get(fact.pid) != null &&
        !fact.startIdentity.endsWith("@unknown") &&
        fact.command.trim() &&
        (records.has(run.id) ||
          orphanExecutesRunScratch(fact, run.temporaryDirectory) ||
          table.orphanedHelpers.has(fact.pid)),
    );
    const intent = store.getMeta<CleanupRun>(key(run.id));
    // A process this run already lost to a stop, seen again within the window, is
    // recorded once and left alone: the live host respawned it, so stopping it
    // again only repeats the same loop.
    const lastStop = intent?.stoppedAt
      ? Date.parse(intent.stoppedAt)
      : Number.NaN;
    if (
      eligible.length &&
      Number.isFinite(lastStop) &&
      lastStop < startedAt &&
      startedAt - lastStop < respawnWindowMs
    ) {
      recordLeftAlone(
        store,
        run,
        hostId,
        "respawned-after-stop",
        eligible,
        startedAt,
      );
      continue;
    }
    const respawned =
      round > 0 ? eligible.filter((fact) => !existed.has(factKey(fact))) : [];
    if (respawned.length)
      recordLeftAlone(
        store,
        run,
        hostId,
        "respawned-after-stop",
        respawned,
        startedAt,
      );
    const owned = respawned.length
      ? eligible.filter(
          (fact) => !respawned.some((item) => item.pid === fact.pid),
        )
      : eligible;
    // Older runs may predate cleanup intents. Keep the same durable boundary
    // as releases written by the current store before signalling or removing scratch.
    if (owned.length && !store.getMeta<CleanupRun>(key(run.id)))
      store.queueRunProcessCleanup({ ...run, hostId });
    // One bounded spawned identity read for exactly these targets, so a signal
    // still rests on the recorded birth identity now rather than on the listing.
    const liveness = owned.length
      ? ((await boundedRead(
          (signal) =>
            refreshedRunProcessLiveness(
              owned.map((fact) => fact.pid),
              tableLiveness,
              signal,
            ),
          options?.readBoundMs ?? RUN_PROCESS_READ_BOUND_MS,
        )) ??
        ((pid: number) =>
          pidAlive(pid) ? ("unknown" as const) : ("dead" as const)))
      : tableLiveness;
    const result = await (options?.terminate ?? terminateHostProcessTargets)(
      owned.map((fact) => ({
        ...fact,
        cwd: fact.cwd ?? "",
        startTime: fact.startIdentity,
        via: "cwd" as const,
      })),
      {
        graceMs: options?.graceMs,
        identityLiveness: (pid, identity) =>
          stillSettled() ? liveness(pid, identity) : "unknown",
      },
    );
    // A target whose identity is proved dead has already exited: a re-read that
    // still lists it is not a survivor to retry, or a sweep would keep the
    // scratch of a process it just stopped.
    const failed = result.failed.filter(
      (fact) => liveness(fact.pid, fact.startIdentity) !== "dead",
    );
    const ambiguous = ownedFacts.filter(
      (fact) => !eligible.some((target) => target.pid === fact.pid),
    );
    const reason = unknown.length
      ? "process environment ownership is unreadable"
      : ambiguous.some((fact) => fact.startIdentity.endsWith("@unknown"))
        ? "owned process start identity is unreadable"
        : ambiguous.length
          ? "process command or agent host identity has not been observed"
          : "owned processes could not be stopped";
    const unresolved = unknown.length
      ? unknown
      : ambiguous.length
        ? ambiguous
        : failed;
    const survivors = failed.map((fact) => ({
      pid: fact.pid,
      startIdentity: fact.startIdentity,
      reason: fact.reason,
    }));
    const uncertainty = unresolved.length
      ? JSON.stringify({
          reason,
          processes: unresolved.map((fact) => ({
            pid: fact.pid,
            startIdentity: fact.startIdentity,
          })),
          ...(survivors.length ? { survivors } : {}),
        })
      : undefined;
    const repeated =
      uncertainty !== undefined && intent?.uncertainty === uncertainty;
    if (result.terminated.length || (failed.length && !repeated))
      store.event(
        run.taskId,
        "run_process_cleanup",
        JSON.stringify({
          runId: run.id,
          stopped: result.terminated.map((fact) => ({
            pid: fact.pid,
            startIdentity: fact.startIdentity,
          })),
          survivors,
        }),
      );
    stopped ||= result.terminated.length > 0;
    if (result.terminated.length) recordStop(store, run, hostId, startedAt);
    if (uncertainty !== undefined) {
      deferCleanup(store, run, uncertainty);
      continue;
    }
    if (result.terminated.length || respawned.length) continue;
    if (!stillSettled()) {
      deferReason(store, run, "run or its participant is active");
      continue;
    }
    // A live non-init ancestor still owns a process carrying this run's identity:
    // its next turn may use the scratch, so the leaf stays until that owner exits.
    // A provider host the daemon keeps carries that identity only because it was
    // handed this thread's environment; it is host infrastructure, so it never
    // holds a released run's scratch (nucleus#1372).
    const retainedByAncestor = retainedFacts.filter(
      (fact) =>
        !hostDaemonProviderHost(
          fact,
          providerHosts,
          environments,
          table,
          run,
          dataHome,
        ) &&
        processBelongsToRun(fact, environments.get(fact.pid), run, dataHome),
    );
    if (retainedByAncestor.length) {
      recordLeftAlone(
        store,
        run,
        hostId,
        "live-ancestor",
        retainedByAncestor,
        startedAt,
      );
      continue;
    }
    // A protected standing runtime can still use the launch leaf. Retire that
    // leaf only after the host releases it, rather than breaking its next turn.
    if (
      run.temporaryDirectory &&
      protectedFacts.some(
        (fact) =>
          !hostDaemonProviderHost(
            fact,
            providerHosts,
            environments,
            table,
            run,
            dataHome,
          ) &&
          [
            environments.get(fact.pid)?.TMPDIR,
            environments.get(fact.pid)?.TMP,
            environments.get(fact.pid)?.TEMP,
          ].includes(run.temporaryDirectory),
      )
    ) {
      deferReason(
        store,
        run,
        "a protected runtime still uses the scratch directory",
      );
      continue;
    }
    if (run.temporaryDirectory) {
      if (!store.getMeta<CleanupRun>(key(run.id)))
        store.queueRunProcessCleanup({ ...run, hostId });
      if (!store.removeRunScratchAfterProcesses(run.temporaryDirectory)) {
        deferReason(store, run, "scratch retirement was refused");
        continue;
      }
    }
    // Retain a displaced initial worker's identity for historical sweeps even
    // after its task row moves to another run; support runs also have run rows.
    if (store.getMeta<CleanupRun>(key(run.id))?.pending !== false)
      store.setMeta(key(run.id), {
        id: run.id,
        taskId: run.taskId,
        hostId,
        agentId: run.agentId,
        temporaryDirectory: run.temporaryDirectory,
        pending: false,
      });
  }
  // A tool can start another child while stopping. Re-read before deleting
  // scratch; a bounded pass retains anything still live for retry.
  if (stopped && round < 8)
    await sweep(store, hostId, options, round + 1, startedAt, existed);
}

/** Remember the one stop that makes a same-run respawn "seen again". */
function recordStop(
  store: Store,
  run: CleanupRun,
  hostId: string,
  at: number,
): void {
  const intent = store.getMeta<CleanupRun>(key(run.id)) ?? {
    id: run.id,
    taskId: run.taskId,
    hostId,
    agentId: run.agentId,
    temporaryDirectory: run.temporaryDirectory,
    pending: true,
  };
  store.setMeta(key(run.id), {
    ...intent,
    stoppedAt: new Date(at).toISOString(),
  });
}

/**
 * Record the one process set this run's cleanup left alone, and why. One
 * decision, one record: the same reason over the same processes writes nothing
 * new on a later pass, whatever re-queued the obligation in between. A different
 * decision — another reason, or an added or replaced process — is written; a
 * same-run respawn after a stop keeps its own ten-minute window, so repeated
 * sweeps add nothing to the task timeline (nucleus#1372).
 */
function recordLeftAlone(
  store: Store,
  run: CleanupRun,
  hostId: string,
  reason: string,
  facts: Array<{ pid: number; startIdentity: string }>,
  at: number,
): void {
  const intent = store.getMeta<CleanupRun>(key(run.id));
  const previous = intent?.leftAlone;
  const processes = facts
    .map((fact) => ({ pid: fact.pid, startIdentity: fact.startIdentity }))
    .sort((left, right) => left.pid - right.pid);
  if (
    previous?.reason === reason &&
    sameProcesses(previous.processes, processes) &&
    (reason === "live-ancestor" ||
      at - Date.parse(previous.at) < CLEANUP_RESPAWN_WINDOW_MS)
  ) {
    if (intent?.uncertainty)
      store.setMeta(key(run.id), { ...intent, uncertainty: undefined });
    return;
  }
  store.event(
    run.taskId,
    "run_process_cleanup_left_alone",
    JSON.stringify({
      runId: run.id,
      reason,
      processes,
    }),
  );
  store.setMeta(key(run.id), {
    ...(intent ?? {
      id: run.id,
      taskId: run.taskId,
      hostId,
      agentId: run.agentId,
      temporaryDirectory: run.temporaryDirectory,
    }),
    pending: intent?.pending ?? true,
    uncertainty: undefined,
    leftAlone: { reason, at: new Date(at).toISOString(), processes },
  });
}

/** The same left-alone decision names exactly these processes. */
function sameProcesses(
  recorded: Array<{ pid: number; startIdentity: string }> | undefined,
  current: Array<{ pid: number; startIdentity: string }>,
): boolean {
  // A record written before the process set was kept proves only its reason.
  if (!recorded) return false;
  return (
    recorded.length === current.length &&
    recorded.every(
      (fact, index) =>
        fact.pid === current[index]!.pid &&
        fact.startIdentity === current[index]!.startIdentity,
    )
  );
}

/** A read that answered nothing: it says nothing about this run's processes. */
const UNOBSERVED = new Set([
  "process table observation is unavailable",
  "process executable observation is unavailable",
]);
const unobserved = (uncertainty: string | undefined): boolean => {
  if (!uncertainty) return false;
  try {
    return UNOBSERVED.has(
      (JSON.parse(uncertainty) as { reason?: string }).reason ?? "",
    );
  } catch {
    return false;
  }
};

/**
 * Keep a run's cleanup pending under this uncertainty. The event is written only
 * when the uncertainty differs from the last one recorded, so a sweep that fails
 * the same way again writes nothing. A read that observed nothing never replaces
 * a more specific record: what an earlier observation proved still stands.
 */
function deferCleanup(
  store: Store,
  run: CleanupRun,
  uncertainty: string,
): void {
  const prior = store.getMeta<CleanupRun>(key(run.id));
  if (
    unobserved(uncertainty) &&
    prior?.pending !== false &&
    ((prior?.uncertainty && !unobserved(prior.uncertainty)) ||
      prior?.leftAlone ||
      (prior?.deferred && !unobserved(prior.deferred)))
  )
    return;
  if (prior?.uncertainty === uncertainty && prior.pending === true) return;
  const recorded = prior?.deferred ?? prior?.uncertainty;
  if (recorded !== uncertainty)
    store.event(
      run.taskId,
      "run_process_cleanup_deferred",
      JSON.stringify({ runId: run.id, ...JSON.parse(uncertainty) }),
    );
  store.setMeta(key(run.id), {
    id: run.id,
    taskId: run.taskId,
    hostId: run.hostId,
    agentId: run.agentId,
    temporaryDirectory: run.temporaryDirectory,
    ...prior,
    pending: true,
    uncertainty,
    deferred: uncertainty,
  });
}

/** A named wait retains the same uncertainty format as per-process failures. */
function deferReason(store: Store, run: CleanupRun, reason: string): void {
  deferCleanup(store, run, JSON.stringify({ reason, processes: [] }));
}
