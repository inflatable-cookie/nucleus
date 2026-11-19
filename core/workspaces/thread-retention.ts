import type { Adapter, ArchivedThread } from "../host/adapter";
import {
  historicalWireLabel,
  validateWireLabels,
} from "../../shared/wire-labels";
import { parseAgentId } from "../../shared/agent-identity";
import { capacityAuthorityEffective } from "../dispatch/capacity-changes";
import type { Store } from "../store/store";
import { now } from "../store/store";
import { ArchiveNotDeliveredError } from "./archive-delivery";
import { AdmissionDeferred } from "../host/admission";

/**
 * Archived thread retention (orchestration contract, "Archived thread
 * retention"): one pass, scheduled by the service, that removes the threads
 * Nucleus created for a task that has finished and has stayed archived for longer
 * than the retention window.
 *
 * The pass is deliberately narrow. It reads the host's own archived list, keeps a
 * row only when its launch labels name a task that is `done` or `cancelled` (read
 * fresh from the store, or from the tombstone a finished task's purge leaves),
 * re-reads that one thread's archive stamp immediately before removing it, and
 * removes it through the host's own delete call. A planner or project-agent
 * thread, a thread of an unfinished task, a decider thread of a decision, and a
 * thread the operator unarchived are never in scope, whatever their archive stamp
 * says.
 *
 * One durable intent per thread fences the removal: an unknown delivery is
 * recorded and left for the next pass, which re-reads the thread before it
 * decides anything, so nothing is ever re-sent blind. A confirmed removal drops
 * the intent and asks the adapter to forget the thread's own state.
 */

/** The retention window's default: Tom, 2026-11-19 ("Maybe three days?"). */
export const THREAD_RETENTION_DEFAULT_DAYS = 3;

/** Removals one pass may make per host; the backlog drains over sweeps, never in one burst. */
export const THREAD_RETENTION_BATCH = 200;

/** Resend attempts after an unknown delivery, each only after a fresh archive read. */
export const THREAD_RETENTION_MAX_RETRIES = 3;

/** The pass's own record, read by `service.health` and `nucleus <host> status`. */
export const THREAD_RETENTION_META_KEY = "threadRetention";

/** Per-thread removal intents, by host then native thread; one record so the map stays prunable. */
const THREAD_RETENTION_INTENTS_META_KEY = "threadRetentionIntents";

const DAY_MS = 86_400_000;

/** One host's last retention pass, as `service.health` presents it. */
export interface ThreadRetentionHostFact {
  hostId: string;
  /** Whether this host can prune at all: it must list archived threads and remove one. */
  supported: boolean;
  /**
   * When this host's last pass read it: the archived walk ran and was kept.
   * Null before the first one. A pass that found the host away leaves this at the
   * last real read, so a stale read stays visible; `checkedAt` says when a pass
   * last looked.
   */
  at: string | null;
  /**
   * When a pass last checked this host, whether it read the host or found it away;
   * null before the first pass. An away host therefore always carries the timestamp
   * of the pass that found it away.
   */
  checkedAt: string | null;
  /** Archived Nucleus-created threads the pass read. */
  scanned: number;
  /** Threads in the scanned set that passed every scope rule. */
  eligible: number;
  /** Threads the host proved removed by this pass. */
  deleted: number;
  /** Eligible threads the host already reported absent. */
  absent: number;
  /** Eligible threads this pass could not remove; the next pass reads them again. */
  failed: number;
  /** Eligible threads the pass left because the batch cap was reached. */
  remaining: number;
  /** The archived walk was cut short, so `scanned` is not the whole archived set. */
  truncated: boolean;
  /** Why this host's last pass could not finish; empty when it did. */
  error: string;
}

/** The whole pass's record: the window in force and each host's last outcome. */
export interface ThreadRetentionHealth {
  days: number;
  batch: number;
  hosts: ThreadRetentionHostFact[];
}

/** The durable per-thread removal fence. */
interface RetentionIntent {
  status: "intent" | "uncertain" | "ready";
  at: string;
  retries: number;
  detail?: string;
}

/** The retention window in days: one Settings value, three by default. */
export function threadRetentionDays(store: Store): number {
  return capacityAuthorityEffective(store).threadRetentionDays;
}

/** This host's last pass, or null before one ran; `service.health` reads it. */
export function threadRetentionHealth(
  store: Store,
): ThreadRetentionHealth | null {
  return (
    store.getMeta<ThreadRetentionHealth>(THREAD_RETENTION_META_KEY) ?? null
  );
}

function intentsOf(
  store: Store,
): Record<string, Record<string, RetentionIntent>> {
  return (
    store.getMeta<Record<string, Record<string, RetentionIntent>>>(
      THREAD_RETENTION_INTENTS_META_KEY,
    ) ?? {}
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every thread this pass must never remove, whatever its labels say. A named
 * project agent or a project's planner is the operator's own thread. A thread an
 * unfinished task still owns — its worker, its coordinator or its retained
 * reviewer — is live work, even when the label names a task that has finished (a
 * worker remapped as another task's coordinator keeps the label it was launched
 * with). Read once per pass from the store's own records.
 */
function protectedThreads(store: Store): Set<string> {
  const ids = new Set<string>();
  for (const project of store.projects()) {
    if (project.planner?.agentId) ids.add(project.planner.agentId);
    for (const agent of project.agents ?? []) ids.add(agent.agentId);
  }
  for (const task of store.tasks()) {
    if (["done", "cancelled"].includes(task.phase) || task.removedAt) continue;
    for (const id of [
      task.agentId,
      task.coordinatorAgentId,
      task.resolution.reviewerAgentId,
    ])
      if (id) ids.add(id);
  }
  return ids;
}

/** Whether one archived row is in the retention pass's scope, with the rule that answered. */
export function retentionScope(
  store: Store,
  row: Pick<ArchivedThread, "id" | "labels">,
  cutoff: number,
  protect: ReadonlySet<string> = protectedThreads(store),
): { eligible: boolean; rule: string } {
  try {
    validateWireLabels(row.labels);
  } catch {
    // A split identity is history this pass cannot read; it is never a guess.
    return { eligible: false, rule: "ambiguous-labels" };
  }
  const taskId = historicalWireLabel(row.labels, "task");
  if (!taskId) return { eligible: false, rule: "not-a-task-thread" };
  const role = historicalWireLabel(row.labels, "role");
  if (role === "planner") return { eligible: false, rule: "planner-thread" };
  // A decider thread belongs to a decision; an open one may still need its thread.
  if (role === "decider" || historicalWireLabel(row.labels, "decider"))
    return { eligible: false, rule: "decision-thread" };
  for (const id of protect) {
    // A project agent's recorded identity may be host-qualified; the native id is
    // the one a host row names.
    let native = id;
    try {
      native = parseAgentId(id)?.nativeAgentId ?? id;
    } catch {
      native = id;
    }
    if (native === row.id)
      return { eligible: false, rule: "named-agent-thread" };
  }
  const task = store.taskOrNull(taskId);
  if (task) {
    if (!["done", "cancelled"].includes(task.phase))
      return { eligible: false, rule: "task-unfinished" };
    // A removal that is still in progress is the cancellation path's own work.
    if (
      task.disposition &&
      !["complete", "failed"].includes(task.disposition.status)
    )
      return { eligible: false, rule: "task-disposition-open" };
  } else if (!store.purgedTask(taskId)) {
    // The task is neither live nor purged here. Its thread is not this store's to remove.
    return { eligible: false, rule: "task-unknown" };
  }
  return { eligible: true, rule: "archived-finished-task" };
}

/** What one host's pass needs: its adapter, the store, and the clock the window is read at. */
export interface ThreadRetentionPassInput {
  store: Store;
  adapter: Adapter;
  hostId: string;
  at?: number;
  days?: number;
  batch?: number;
  /** Read between rows: a drain or a stopped engine ends the pass before its next host call. */
  stopped?: () => boolean;
}

/**
 * One host's retention pass. It never throws: a walk, read or removal that fails
 * is this host's recorded failure for the pass, and the other hosts still run.
 *
 * A host that lists its archived threads but cannot remove one (BB, until its
 * own delete proof lands) is read and counted, never reported as clean: its
 * `supported` stays false and its `error` names the missing removal.
 */
export async function runThreadRetentionPass(
  input: ThreadRetentionPassInput,
): Promise<ThreadRetentionHostFact> {
  const { store, adapter, hostId } = input;
  const at = input.at ?? Date.now();
  const days = input.days ?? threadRetentionDays(store);
  const batch = input.batch ?? THREAD_RETENTION_BATCH;
  const fact: ThreadRetentionHostFact = {
    hostId,
    supported: false,
    at: null,
    checkedAt: null,
    scanned: 0,
    eligible: 0,
    deleted: 0,
    absent: 0,
    failed: 0,
    remaining: 0,
    truncated: false,
    error: "",
  };
  const list = adapter.archivedThreads,
    freshRead = adapter.threadArchiveState,
    remove = adapter.deleteAgent;
  if (!list) {
    fact.at = fact.checkedAt = new Date(at).toISOString();
    fact.error =
      "This host does not list its archived threads, so none were read or pruned";
    return fact;
  }
  let rows: ArchivedThread[] | null;
  try {
    rows = await list.call(adapter);
  } catch (error) {
    fact.at = fact.checkedAt = new Date(at).toISOString();
    fact.error = `The archived thread walk failed: ${message(error)}`;
    return fact;
  }
  if (rows === null) {
    fact.at = fact.checkedAt = new Date(at).toISOString();
    fact.truncated = true;
    fact.error =
      "The archived thread walk did not reach its end; nothing was pruned";
    return fact;
  }
  const cutoff = at - days * DAY_MS;
  const protect = protectedThreads(store);
  const candidates: ArchivedThread[] = [];
  for (const row of rows)
    if (
      Date.parse(row.archivedAt) <= cutoff &&
      retentionScope(store, row, cutoff, protect).eligible
    )
      candidates.push(row);
  fact.scanned = rows.length;
  fact.eligible = candidates.length;
  fact.at = fact.checkedAt = new Date(at).toISOString();
  if (!freshRead || !remove) {
    fact.error = `This host cannot remove an archived thread, so ${candidates.length} eligible thread(s) were counted and none were removed`;
    return fact;
  }
  fact.supported = true;
  // Oldest first, so a backlog drains from its far end and a bounded pass is fairly shared.
  candidates.sort((left, right) =>
    left.archivedAt.localeCompare(right.archivedAt),
  );
  const intents = intentsOf(store);
  const hostIntents = intents[hostId] ?? {};
  if (!intents[hostId]) intents[hostId] = hostIntents;
  const writeIntents = () => {
    if (Object.keys(hostIntents).length)
      store.setMeta(THREAD_RETENTION_INTENTS_META_KEY, intents);
    else {
      delete intents[hostId];
      if (Object.keys(intents).length)
        store.setMeta(THREAD_RETENTION_INTENTS_META_KEY, intents);
      else store.deleteMeta(THREAD_RETENTION_INTENTS_META_KEY);
    }
  };
  const removed: string[] = [];
  const left: ArchivedThread[] = [];
  let intentsChanged = false;
  for (const row of candidates) {
    if (fact.deleted >= batch || input.stopped?.()) {
      left.push(row);
      continue;
    }
    const key = row.id;
    const prior = hostIntents[key];
    // A prior unknown delivery is read before anything else: only the host's own
    // fresh answer decides whether this thread still needs a removal.
    let state: { archivedAt: string | null; deleted: boolean } | null;
    try {
      state = await freshRead.call(adapter, row.id);
    } catch (error) {
      fact.failed++;
      fact.error =
        fact.error ||
        `Could not read ${row.id} before removal: ${message(error)}`;
      continue;
    }
    if (!state || state.deleted) {
      fact.absent++;
      if (prior) {
        delete hostIntents[key];
        intentsChanged = true;
      }
      continue;
    }
    // The operator unarchived it, or it was archived again after the walk: keep it.
    if (!state.archivedAt || Date.parse(state.archivedAt) > cutoff) continue;
    if (
      prior &&
      prior.status === "uncertain" &&
      prior.retries >= THREAD_RETENTION_MAX_RETRIES
    ) {
      fact.failed++;
      fact.error =
        fact.error ||
        `${row.id} has an unproved removal after ${prior.retries} attempts`;
      continue;
    }
    // The durable fence is written before the call: a crash or an unknown
    // outcome leaves the intent on record, never a second silent removal.
    hostIntents[key] = {
      status: "intent",
      at: now(),
      retries: prior?.retries ?? 0,
    };
    writeIntents();
    intentsChanged = false;
    try {
      await remove.call(adapter, row.id);
    } catch (error) {
      const retries = (prior?.retries ?? 0) + 1;
      const notDelivered =
        error instanceof ArchiveNotDeliveredError ||
        error instanceof AdmissionDeferred;
      hostIntents[key] = {
        status: notDelivered ? "ready" : "uncertain",
        at: now(),
        retries: notDelivered ? (prior?.retries ?? 0) : retries,
        detail: message(error),
      };
      writeIntents();
      intentsChanged = false;
      fact.failed++;
      fact.error = fact.error || `Removing ${row.id} failed: ${message(error)}`;
      continue;
    }
    let after: { archivedAt: string | null; deleted: boolean } | null;
    try {
      after = await freshRead.call(adapter, row.id);
    } catch (error) {
      hostIntents[key] = {
        status: "uncertain",
        at: now(),
        retries: (prior?.retries ?? 0) + 1,
        detail: message(error),
      };
      writeIntents();
      intentsChanged = false;
      fact.failed++;
      fact.error =
        fact.error ||
        `Could not read ${row.id} after removal: ${message(error)}`;
      continue;
    }
    if (after && !after.deleted && after.archivedAt) {
      hostIntents[key] = {
        status: "uncertain",
        at: now(),
        retries: (prior?.retries ?? 0) + 1,
        detail: "Removal was not observed",
      };
      writeIntents();
      intentsChanged = false;
      fact.failed++;
      fact.error = fact.error || `Removing ${row.id} was not observed`;
      continue;
    }
    fact.deleted++;
    removed.push(row.id);
    delete hostIntents[key];
    intentsChanged = true;
  }
  // Intents for threads this complete walk no longer lists are finished: the
  // thread is gone, so the fence has nothing left to protect.
  const present = new Set(rows.map((row) => row.id));
  for (const key of Object.keys(hostIntents)) {
    if (present.has(key)) continue;
    delete hostIntents[key];
    intentsChanged = true;
  }
  if (intentsChanged) writeIntents();
  if (removed.length) {
    try {
      adapter.forgetThreads?.call(adapter, removed);
    } catch (error) {
      fact.error =
        fact.error || `Forgetting removed threads failed: ${message(error)}`;
    }
  }
  fact.remaining = left.length;
  fact.at = fact.checkedAt = new Date(at).toISOString();
  return fact;
}

/** What one scheduled pass is given: every host it may reach, in the ambient host context. */
export interface ThreadRetentionRunInput {
  store: Store;
  hostIds: readonly string[];
  /**
   * Whether a host is online, read in that host's own context: the engine's
   * availability answer depends on the ambient host, so an unscoped read calls a
   * secondary host away even while it is connected.
   */
  hostAvailable: (hostId: string) => boolean;
  withHost: <T>(hostId: string, work: () => T) => T;
  adapter: Adapter;
  at?: number;
  days?: number;
  batch?: number;
  stopped?: () => boolean;
}

/**
 * The service's one retention pass across every host it can reach. A host that is
 * away is skipped with its own reason, never read; the pass record carries the
 * window in force and one fact per host, so a stale or failing pass is visible in
 * `service.health` instead of silently stopping.
 */
export async function runThreadRetention(
  input: ThreadRetentionRunInput,
): Promise<ThreadRetentionHealth> {
  const at = input.at ?? Date.now();
  const days = input.days ?? threadRetentionDays(input.store);
  const batch = input.batch ?? THREAD_RETENTION_BATCH;
  const previous = input.store.getMeta<ThreadRetentionHealth>(
    THREAD_RETENTION_META_KEY,
  );
  const known = new Map(
    (previous?.hosts ?? []).map((fact) => [fact.hostId, fact]),
  );
  for (const hostId of input.hostIds) {
    if (input.stopped?.()) break;
    const online = input.withHost(hostId, () => input.hostAvailable(hostId));
    if (!online) {
      // An away host is not read. The last real pass stays as it ran — its `at`
      // makes the staleness visible — and this pass's reason is the one thing
      // that changes, so a skipped pass never reads as a clean empty one.
      const last = known.get(hostId);
      known.set(hostId, {
        ...(last ?? {
          hostId,
          supported: false,
          at: null,
          checkedAt: null,
          scanned: 0,
          eligible: 0,
          deleted: 0,
          absent: 0,
          failed: 0,
          remaining: 0,
          truncated: false,
          error: "",
        }),
        hostId,
        checkedAt: new Date(at).toISOString(),
        error: "The host is away; its archived threads were not read",
      });
      continue;
    }
    const fact = await input.withHost(hostId, () =>
      runThreadRetentionPass({
        store: input.store,
        adapter: input.adapter,
        hostId,
        at,
        days,
        batch,
        stopped: input.stopped,
      }),
    );
    known.set(hostId, fact);
  }
  const health: ThreadRetentionHealth = {
    days,
    batch,
    hosts: [...known.values()],
  };
  input.store.setMeta(THREAD_RETENTION_META_KEY, health);
  return health;
}
