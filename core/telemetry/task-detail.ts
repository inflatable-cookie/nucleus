import { missingResult } from '../recovery/missing-result';
import type { Store } from '../store/store';
import { deriveTaskTelemetry } from './telemetry';
import { taskDetailView } from '../../shared/contracts';
import type { HookRecord } from '../../shared/hooks';
import type { Notice, Profile, Run, Task } from '../../shared/contracts';
import { taskWaitStateContext, queuedReason } from '../recovery/wait-context';

/** The task's own recorded rows: everything `task.next` derives a verb from, and nothing remote. */
export type TaskEvidence = {
  /** The task row as it was read for this evidence; callers compare its version before reusing it. */
  task: Task;
  runs: Run[];
  events: Array<{ id: number; taskId: string; at: string; kind: string; detail: string }>;
  notices: Notice[];
  hookRecords: HookRecord[];
};

/**
 * Bounded read cache only. Effect boundaries continue reading Store directly, and
 * `task.next` shares the evidence read here instead of re-reading the selected task's
 * history on its own four-second poll (audit A8).
 */
export function createTaskDetailCache(store: Store, options: { maxEntries?: number; maxBytes?: number; maxAgeMs?: number; now?: () => number; slotAdmissionReason?: (task: Task) => string; externalWait?: (task: Task) => string;
  /** The task host's routing profiles, so its routing policy names why a profile is ineligible there (nucleus#1143). */
  profiles?: (task: Task) => readonly Profile[] } = {}) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 4, maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const maxAgeMs = options.maxAgeMs ?? 15_000;
  const build = (taskId: string, at: number) => {
    const task = store.task(taskId), events = store.eventsAll(taskId), runs = store.runs(taskId), notices = store.notices(taskId), hooks = store.hookEvents(taskId);
    const evidence: TaskEvidence = { task, runs, events, notices, hookRecords: hooks };
    // The display payload keeps its bounded windows; the full lists stay behind
    // `evidence()` so sharing them costs array references, not a second parse.
    return { evidence, value: { task, events: events.slice(-100).reverse(), runs: runs.slice(-200), notices: notices.slice(-200), hooks: hooks.slice(-200),
      messages: store.messages(taskId).slice(-50).reverse(),
      operations: store.operations({ taskId, limit: 50 }), telemetry: deriveTaskTelemetry(task, events, runs, notices, hooks, new Date(at)),
      missingResult: missingResult(task, runs) } };
  };
  const entries = new Map<string, { value: ReturnType<typeof build>['value']; evidence: TaskEvidence; at: number; bytes: number }>();
  let bytes = 0;
  const remove = (id: string) => { const entry = entries.get(id); if (entry) bytes -= entry.bytes; entries.delete(id); };
  store.onTaskChange(taskId => { if (taskId === null) { entries.clear(); bytes = 0; } else remove(taskId); });
  const current = (taskId: string): ReturnType<typeof build> => {
    const at = now();
    let entry = store.db.isTransaction ? undefined : entries.get(taskId);
    if (entry && (at < entry.at || at - entry.at >= maxAgeMs)) { remove(taskId); entry = undefined; }
    if (!entry) {
      const built = build(taskId, at);
      entry = { ...built, at, bytes: Buffer.byteLength(JSON.stringify(built.value)) };
      if (!store.db.isTransaction && entry.bytes <= maxBytes && maxEntries > 0) {
        while (entries.size >= maxEntries || bytes + entry.bytes > maxBytes) remove(entries.keys().next().value!);
        entries.set(taskId, entry); bytes += entry.bytes;
      }
    } else { entries.delete(taskId); entries.set(taskId, entry); }
    return entry;
  };
  /**
   * The evidence behind the detail view for one task, read once and shared with `task.next`.
   * Every write to the task's row, runs, events, notices or hook records removes the entry and
   * a rollback clears it, so a caller that checks `evidence.task.version` never derives a verb
   * from another version's facts; authority, side-effect and eligibility reads still come
   * fresh from the store.
   */
  return Object.assign((taskId: string) => {
    const entry = current(taskId);
    // Waits and dependency status are projections of current facts. Recompute
    // them on each detail read even when the bounded event/telemetry payload is
    // cached; capacity can change because another task moved.
    const task = store.task(taskId);
    const decisionId = store.listDecisions({ status: 'open', task: taskId })[0]?.id ?? null;
    const context = taskWaitStateContext(store, task, decisionId, options.slotAdmissionReason);
    const currentTask = taskDetailView({ ...task, reason: queuedReason(store, task, context, options.externalWait) }, context, store.runs(taskId));
    const dependencyIds = [...new Set([...task.dependsOn, ...(task.prerequisiteWait?.waitsFor ?? [])])];
    // Spec 052: the usage level can expire with no write, so the routing policy is read fresh too.
    return { ...entry.value, task: currentTask, dependencies: dependencyIds.map(id => store.taskReference(id)), routingPolicy: store.routingPolicy(task, now(), options.profiles?.(task) ?? []) };
  }, { evidence: (taskId: string) => current(taskId).evidence });
}
