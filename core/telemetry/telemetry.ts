import type { Task, Run, Notice } from "../../shared/contracts";
import type { QueueEvent } from "./task-facts";
import { mergeReviewerCalibration } from "./reviewer-calibration";
import { liveTelemetryItem, retainedTelemetryItem, type TelemetryBaseItem } from "./telemetry-item";
export { deriveTaskTelemetry, normalizeTelemetryCause } from "./task-facts";
export type { QueueEvent } from "./task-facts";
export { reviewerCalibrationFacts, mergeReviewerCalibration } from "./reviewer-calibration";
export type { ReviewerCalibrationFacts } from "./reviewer-calibration";
export type { ReviewerVerdictFact, ReviewerRoundFact, ReviewerIncidentFact } from "./reviewer-calibration";
export { taskControlTelemetry } from "./task-control";
export { captureRetainedTelemetry, liveTelemetryItem, retainedTelemetryItem, retainedTelemetryRecord } from "./telemetry-item";
export type { TelemetryBaseItem, TelemetryMeasures, TelemetryTaskFacts, QaValidationSample } from "./telemetry-item";
import type { HookRecord } from "../../shared/hooks";
import {
  STAGE_META, headlineFacts, telemetryFilterSchema, telemetrySnapshotSchema,
  type QaValidationAdmission, type RetainedTaskTelemetry, type TaskTelemetry, type TelemetryCoverage,
  type TelemetryHeadline, type TelemetryHeadlineKey, type TelemetrySnapshot, type TelemetryStageKey,
  disabledShadowReviewPlan, type UsageComplexity, TELEMETRY_RETENTION_DAYS, TELEMETRY_RETENTION_MS, TASK_CONTROL_RETENTION_DAYS,
} from "../../shared/telemetry";
import { type Store, type TelemetryFactChunk } from "../store/store";

const ms = (value: string | null | undefined, fallback: number) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

function usageByComplexity(items: TelemetryBaseItem[]): UsageComplexity[] {
  const finished = items.filter(item => item.task.phase === "done");
  const groups = new Map<string, TelemetryBaseItem[]>();
  // An unset complexity is its own bucket: an unrated task is never folded into a level.
  const complexityOf = (item: TelemetryBaseItem) => item.task.complexity ?? "unset";
  for (const item of finished) { const key = complexityOf(item), members = groups.get(key); if (members) members.push(item); else groups.set(key, [item]); }
  return [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([complexity, members]) => {
    const usages = members.map(item => item.telemetry.usage).filter((usage): usage is NonNullable<typeof usage> => usage !== undefined);
    // A task with no usage at all is partial and stays out of the samples: never a zero.
    const measured = usages.filter(usage => usage.evidence !== "none");
    const partialCount = usages.filter(usage => usage.evidence !== "exact").length;
    const dist = (values: number[]) => ({ count: values.length, partialCount, p50: percentile(values, .5), p95: percentile(values, .95) });
    return {
      complexity, finishedCount: members.length,
      // A provider that reported no tokens contributes turns and wall time only.
      effectiveTokens: dist(measured.filter(usage => usage.total.reportedTurns > 0).map(usage => usage.total.effectiveTokens)),
      wallMs: dist(measured.map(usage => usage.total.wallMs)),
      turns: dist(measured.map(usage => usage.total.turns)),
    };
  });
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function distribution(values: number[], partialCount: number) {
  return { count: values.length, partialCount, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95) };
}
/**
 * Aggregate one group's settled project validations into separate queue-wait,
 * wall and CPU distributions from Queue's scheduler record. Queue wait never folds into run time;
 * validations without a value count as partial, never as zero.
 */
function mergeQaValidationAdmission(items: TelemetryBaseItem[]): QaValidationAdmission {
  const settled = items.map(item => item.qaValidation).filter((sample): sample is NonNullable<typeof sample> => sample !== null);
  const distributionOf = (values: (number | null)[]) => {
    const recorded = values.filter((value): value is number => typeof value === "number");
    return { count: recorded.length, partialCount: values.length - recorded.length, p50Ms: percentile(recorded, .5), p95Ms: percentile(recorded, .95) };
  };
  return {
    validations: settled.length,
    queueWaitMs: distributionOf(settled.map(sample => sample.queueWaitMs)),
    wallMs: distributionOf(settled.map(sample => sample.wallMs)),
    cpuMs: distributionOf(settled.map(sample => sample.cpuMs)),
    capacityUnavailable: settled.filter(sample => sample.capacityUnavailable).length,
  };
}

function mergeInterventions(items: TelemetryBaseItem["telemetry"][]) {
  const recovery = new Map<string, TaskTelemetry["interventions"]["recoveries"][number]>(), actions = new Map<string, number>(), incidents = new Map<string, TaskTelemetry["interventions"]["incidents"][number]>();
  const total = { recoveryRuns: 0, uncertainCreations: 0, absentCreations: 0, attentionNotices: 0, escalations: 0, hookHolds: 0, hookRetries: 0, automaticHookReplays: 0, prospectiveMergeHooks: 0, staleCandidateRebuilds: 0, revisions: 0, continuationRevisions: 0, administrativeRevisions: 0, checkpoints: 0, checkpointContinuations: 0, replacements: 0 };
  for (const item of items) {
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += item.interventions[key];
    for (const row of item.interventions.recoveries) { const key = `${row.targetRole}:${row.provider}:${row.profileGroup}:${row.status}:${row.cause}`, prior = recovery.get(key); if (prior) prior.count += row.count; else recovery.set(key, { ...row }); }
    for (const row of item.interventions.incidents) { const key = `${row.role}:${row.provider}:${row.profileGroup}:${row.cause}`, prior = incidents.get(key); if (prior) prior.count += row.count; else incidents.set(key, { ...row }); }
    for (const row of item.interventions.operatorActions) actions.set(row.key, (actions.get(row.key) ?? 0) + row.count);
  }
  return { ...total, recoveries: [...recovery.values()], incidents: [...incidents.values()].sort((a, b) => `${a.role}:${a.cause}`.localeCompare(`${b.role}:${b.cause}`)), operatorActions: [...actions].map(([key, count]) => ({ key, count })) };
}

/**
 * One coalesced task-level base per durable store revision and short age bucket. It holds
 * the current derivation for every live task, the retained contribution of every purged
 * task inside the 90-day window (exactly one contribution per task), and bounded dimension
 * dictionaries; filters and groups are computed in memory from it, so memory never grows
 * with filter cardinality.
 */
export interface TelemetryBase {
  revision: number;
  generatedAt: string;
  builtAt: number;
  items: TelemetryBaseItem[];
  repositories: string[];
  scopes: string[];
  profileGroups: string[];
  interventionProviders: string[];
  reviewerProviders: string[];
  reviewerProfiles: string[];
  reviewerProfileGroups: string[];
  /** Retained-history coverage at build time (see `Store.retainedTelemetryCoverage`). */
  retention: { coverageFrom: string | null; active: boolean };
}

interface FactBundle {
  tasks: Task[];
  eventsByTask: Map<string, QueueEvent[]>;
  runsByTask: Map<string, Run[]>;
  noticesByTask: Map<string, Notice[]>;
  hooksByTask: Map<string, HookRecord[]>;
  retained: RetainedTaskTelemetry[];
}

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

function emptyBundle(): FactBundle {
  return { tasks: [], eventsByTask: new Map(), runsByTask: new Map(), noticesByTask: new Map(), hooksByTask: new Map(), retained: [] };
}

function pushFact<T>(map: Map<string, T[]>, taskId: string, value: T) {
  const list = map.get(taskId);
  if (list) list.push(value); else map.set(taskId, [value]);
}

function applyFactChunk(bundle: FactBundle, chunk: TelemetryFactChunk) {
  if (chunk.kind === "tasks") bundle.tasks.push(...chunk.tasks);
  else if (chunk.kind === "events") for (const row of chunk.events) pushFact(bundle.eventsByTask, row.taskId, row.event);
  else if (chunk.kind === "runs") for (const row of chunk.runs) pushFact(bundle.runsByTask, row.taskId, row.run);
  else if (chunk.kind === "notices") for (const row of chunk.notices) pushFact(bundle.noticesByTask, row.taskId, row.notice);
  else if (chunk.kind === "hooks") for (const row of chunk.hooks) pushFact(bundle.hooksByTask, row.taskId, row.hook);
  else bundle.retained.push(...chunk.records);
}

function deriveItem(bundle: FactBundle, task: Task, generatedAt: Date): TelemetryBaseItem {
  return liveTelemetryItem({ task, events: bundle.eventsByTask.get(task.id) ?? [], runs: bundle.runsByTask.get(task.id) ?? [],
    notices: bundle.noticesByTask.get(task.id) ?? [], hooks: bundle.hooksByTask.get(task.id) ?? [] }, generatedAt);
}

/**
 * Retained contributions for purged tasks only: a task whose detailed history the base
 * read stays live, so a purge committing between bounded page reads never counts twice.
 */
function* retainedItems(bundle: FactBundle): Generator<TelemetryBaseItem> {
  const live = new Set(bundle.tasks.map(task => task.id)), seen = new Set<string>();
  for (const record of bundle.retained) {
    if (live.has(record.taskId) || seen.has(record.taskId)) continue;
    seen.add(record.taskId);
    yield retainedTelemetryItem(record);
  }
}

/**
 * One stable contribution order, by creation time then task identity, so first-seen labels
 * and counter rows come out the same whether a task contributes live or retained.
 */
function orderItems(items: TelemetryBaseItem[]) {
  return items.sort((a, b) => ms(a.task.createdAt, 0) - ms(b.task.createdAt, 0) || (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0));
}

function dimensionValues(items: TelemetryBaseItem[]) {
  const providers = new Set<string>();
  const reviewerProviders = new Set<string>(), reviewerProfileGroups = new Set<string>(), reviewerProfiles = new Set<string>();
  for (const item of items) {
    for (const provider of item.providers) providers.add(provider);
    for (const verdict of item.reviewer.verdicts) {
      if (verdict.reviewer.provider) reviewerProviders.add(verdict.reviewer.provider);
      if (verdict.reviewer.profileGroup) reviewerProfileGroups.add(verdict.reviewer.profileGroup);
      reviewerProfiles.add(verdict.reviewer.profileName ?? verdict.reviewer.agentId ?? verdict.reviewer.profileId ?? "Unattributed reviewer");
    }
  }
  return {
    repositories: [...new Set(items.map(item => item.task.repoPath))].sort(),
    scopes: [...new Set(items.map(item => item.task.scope))].sort(),
    profileGroups: [...new Set(items.map(item => item.task.profileGroup).filter((value): value is string => Boolean(value)))].sort(),
    interventionProviders: [...providers].sort(),
    reviewerProviders: [...reviewerProviders].sort(), reviewerProfileGroups: [...reviewerProfileGroups].sort(), reviewerProfiles: [...reviewerProfiles].sort(),
  };
}

/**
 * Load every telemetry fact in bounded pages, handing the event loop back between pages so
 * concurrent Queue RPC and lifecycle work keep running during a cold build.
 */
export async function buildTelemetryBase(store: Store, generatedAt = new Date(), options: { pageSize?: number; yieldEvery?: number } = {}): Promise<TelemetryBase> {
  const revision = store.telemetryRevision(), retention = store.retainedTelemetryCoverage();
  const bundle = emptyBundle();
  for (const chunk of store.telemetryFactChunks(options.pageSize ?? 500)) { applyFactChunk(bundle, chunk); await yieldToEventLoop(); }
  const yieldEvery = Math.max(1, options.yieldEvery ?? 16);
  const items: TelemetryBaseItem[] = [];
  for (let index = 0; index < bundle.tasks.length; index++) {
    items.push(deriveItem(bundle, bundle.tasks[index], generatedAt));
    if (index % yieldEvery === yieldEvery - 1) await yieldToEventLoop();
  }
  // Retained records are already derived; restoring one is cheap, so they yield in larger steps.
  let restored = 0;
  for (const item of retainedItems(bundle)) {
    items.push(item);
    if (++restored % (yieldEvery * 8) === 0) await yieldToEventLoop();
  }
  orderItems(items);
  return { revision, generatedAt: generatedAt.toISOString(), builtAt: generatedAt.getTime(), items, retention, ...dimensionValues(items) };
}

/** Synchronous construction for direct derivation, tests and small stores. */
export function buildTelemetryBaseSync(store: Store, generatedAt = new Date(), page = 500): TelemetryBase {
  const revision = store.telemetryRevision(), retention = store.retainedTelemetryCoverage();
  const facts = store.telemetryFacts(page);
  const bundle: FactBundle = { tasks: facts.tasks, eventsByTask: facts.eventsByTask, runsByTask: facts.runsByTask, noticesByTask: facts.noticesByTask, hooksByTask: facts.hooksByTask, retained: facts.retained };
  const items = orderItems([...bundle.tasks.map(task => deriveItem(bundle, task, generatedAt)), ...retainedItems(bundle)]);
  return { revision, generatedAt: generatedAt.toISOString(), builtAt: generatedAt.getTime(), items, retention, ...dimensionValues(items) };
}

function headlineCounts(items: TelemetryBaseItem[]): TelemetryHeadline {
  const facts = items.map(item => headlineFacts(item.telemetry.interventions));
  const category = (key: TelemetryHeadlineKey) => {
    const taskCount = facts.filter(row => row[key] > 0).length;
    return { taskCount, factCount: facts.reduce((sum, row) => sum + row[key], 0), rate: items.length ? taskCount / items.length : null };
  };
  return { deliveryExceptions: category("deliveryExceptions"), semanticReview: category("semanticReview"), operatorAdministration: category("operatorAdministration") };
}

/**
 * What a window can honestly claim. Retained records expire past the 90-day cohort window,
 * and history purged before compact capture existed is gone, so the earliest complete
 * creation time is the later of the two. A window starting before it is partial. The
 * separate task-control series keeps 30 days and says so for wider windows.
 */
function telemetryCoverage(base: TelemetryBase, windowMs: number, createdAfter: number | null, data: TelemetryBaseItem[]): TelemetryCoverage {
  const iso = (value: number) => Number.isFinite(value) ? new Date(value).toISOString() : null;
  const windowStart = Math.max(Number.isFinite(windowMs) ? base.builtAt - windowMs : -Infinity, createdAfter ?? -Infinity);
  const horizon = base.retention.active ? base.builtAt - TELEMETRY_RETENTION_MS : -Infinity;
  const captured = base.retention.coverageFrom ? ms(base.retention.coverageFrom, -Infinity) : -Infinity;
  const completeFrom = Math.max(horizon, captured);
  const retained = data.filter(item => item.retained);
  return {
    retentionDays: TELEMETRY_RETENTION_DAYS, windowStart: iso(windowStart), completeFrom: iso(completeFrom),
    partial: windowStart < completeFrom, liveTasks: data.length - retained.length, retainedTasks: retained.length,
    reviewerAttributionUnavailable: retained.reduce((sum, item) => sum + item.reviewerAttributionUnavailable, 0),
    controlsWindowDays: TASK_CONTROL_RETENTION_DAYS, controlsPartial: windowMs > TASK_CONTROL_RETENTION_DAYS * 86_400_000,
  };
}

/** Filter, group and aggregate one already-built base in memory. */
export function telemetrySnapshotFromBase(base: TelemetryBase, input: unknown): TelemetrySnapshot {
  const filters = telemetryFilterSchema.parse(input), nowAt = base.builtAt;
  const windowMs = filters.window === "all" ? Infinity : ({ "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[filters.window] * 86_400_000);
  const createdAfter = filters.createdAfter ? Date.parse(filters.createdAfter) : null;
  const data = base.items.filter(item => nowAt - ms(item.task.createdAt, nowAt) <= windowMs)
    .filter(item => createdAfter === null || ms(item.task.createdAt, 0) >= createdAfter)
    .filter(item => !filters.repoPath || item.task.repoPath === filters.repoPath)
    .filter(item => !filters.scope || item.task.scope === filters.scope)
    .filter(item => !filters.profileGroup || item.task.profileGroup === filters.profileGroup)
    .filter(item => !filters.closeoutAuthority || item.telemetry.closeoutAuthority === filters.closeoutAuthority)
    .filter(item => !filters.reviewerProvider || item.reviewer.verdicts.some(verdict => verdict.reviewer.provider === filters.reviewerProvider))
    .filter(item => !filters.reviewerProfile || item.reviewer.verdicts.some(verdict => {
      // Match the same identity the dimension dictionary advertises: profile name, then agent
      // id, then profile id, with the unattributed fallback matching identity-less verdicts.
      const identity = verdict.reviewer;
      return identity.profileName === filters.reviewerProfile || identity.profileId === filters.reviewerProfile
        || identity.agentId === filters.reviewerProfile
        || (!identity.profileName && !identity.profileId && !identity.agentId && filters.reviewerProfile === "Unattributed reviewer");
    }))
    .filter(item => !filters.reviewerProfileGroup || item.reviewer.verdicts.some(verdict => verdict.reviewer.profileGroup === filters.reviewerProfileGroup))
    .filter(item => !filters.interventionRole || item.telemetry.interventions.recoveries.some(row => row.targetRole === filters.interventionRole) || item.telemetry.interventions.incidents.some(row => row.role === filters.interventionRole))
    .filter(item => !filters.interventionProvider || item.telemetry.interventions.recoveries.some(row => row.provider === filters.interventionProvider) || item.telemetry.interventions.incidents.some(row => row.provider === filters.interventionProvider));
  const grouped = new Map<string, TelemetryBaseItem[]>();
  for (const item of data) {
    const key = filters.groupBy === "repository" ? item.task.repoPath : filters.groupBy === "scope" ? item.task.scope : filters.groupBy === "profile_group" ? item.task.profileGroup ?? "unassigned" : filters.groupBy === "closeout_authority" ? item.telemetry.closeoutAuthority : "all";
    const members = grouped.get(key);
    if (members) members.push(item); else grouped.set(key, [item]);
  }
  const selectedGroups = [...grouped].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 100);
  const groups = selectedGroups.map(([key, items]) => {
    const telemetries = items.map(item => item.telemetry), completed = items.filter(item => item.task.phase === "done").length;
    const interventionTasks = telemetries.filter(item => {
      const value = item.interventions;
      return value.recoveryRuns + value.uncertainCreations + value.absentCreations + value.attentionNotices
        + value.escalations + value.hookHolds + value.hookRetries + value.automaticHookReplays + value.revisions + value.replacements
        + value.operatorActions.reduce((sum, action) => sum + action.count, 0) > 0;
    }).length;
    const stageRows = Object.keys(STAGE_META).map(stage => {
      const key = stage as TelemetryStageKey, samples = telemetries.flatMap(item => item.stages.filter(row => row.stage === key));
      return { stage: key, category: STAGE_META[key].category, supplemental: key === "repository_hook", ...distribution(samples.map(row => row.elapsedMs), samples.filter(row => row.partial).length) };
    }).filter(row => row.count > 0);
    const evidence = telemetries.every(item => item.evidence === "exact") ? "exact" : telemetries.every(item => item.evidence === "partial") ? "partial" : "mixed";
    const label = key === "all" ? "All matching tasks" : filters.groupBy === "closeout_authority" ? key.replaceAll("_", " ") : key.split("/").filter(Boolean).at(-1) ?? key;
    return { key, label, taskCount: items.length, completedCount: completed, completionRate: items.length ? completed / items.length : null,
      interventionTaskCount: interventionTasks, interventionRate: items.length ? interventionTasks / items.length : null,
      total: distribution(telemetries.map(item => item.totalElapsedMs), telemetries.filter(item => item.evidence !== "exact").length),
      waiting: distribution(telemetries.map(item => item.waitingMs), telemetries.filter(item => item.evidence !== "exact").length),
      active: distribution(telemetries.map(item => item.activeMs), telemetries.filter(item => item.evidence !== "exact").length),
      stages: stageRows, interventions: mergeInterventions(telemetries), headline: headlineCounts(items),
      closeoutAuthorities: { repositoryHook: telemetries.filter(item => item.closeoutAuthority === "repository_hook").length,
        agent: telemetries.filter(item => item.closeoutAuthority === "agent").length,
        pending: telemetries.filter(item => item.closeoutAuthority === "pending").length,
        none: telemetries.filter(item => item.closeoutAuthority === "none").length }, evidence,
      qaAdmission: mergeQaValidationAdmission(items),
      reviewerCalibration: mergeReviewerCalibration(items),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
  const dimensions = {
    repositories: base.repositories, scopes: base.scopes, profileGroups: base.profileGroups, interventionProviders: base.interventionProviders,
    reviewerProviders: base.reviewerProviders, reviewerProfiles: base.reviewerProfiles, reviewerProfileGroups: base.reviewerProfileGroups,
  };
  const truncatedDimensions = Object.entries(dimensions).filter(([, values]) => values.length > 100).map(([key]) => key);
  return telemetrySnapshotSchema.parse({ generatedAt: base.generatedAt, filters, coverage: telemetryCoverage(base, windowMs, createdAfter, data), matchingTasks: data.length, groups,
    usageByComplexity: usageByComplexity(data),
    omittedGroups: grouped.size - selectedGroups.length, truncatedDimensions,
    ...Object.fromEntries(Object.entries(dimensions).map(([key, values]) => [key, values.slice(0, 100)])),
    shadowPlan: disabledShadowReviewPlan });
}

/** Direct synchronous aggregate derivation over the whole store. */
export function telemetrySnapshot(store: Store, input: unknown, generatedAt = new Date()): TelemetrySnapshot {
  return telemetrySnapshotFromBase(buildTelemetryBaseSync(store, generatedAt), input);
}

/**
 * Coalescing aggregate cache. One in-flight cold build is shared by every concurrent filter,
 * the base is reused until a durable write advances the store revision, and a fifteen-second
 * maximum age refreshes unfinished current-stage ages even when no write occurs. Only the
 * current base and its bounded dimensions are retained, never one entry per filter.
 */
export function createTelemetrySnapshotCache(
  store: Store,
  options: { maxAgeMs?: number; now?: () => number; pageSize?: number; yieldEvery?: number } = {},
): (input: unknown) => Promise<TelemetrySnapshot> {
  const maxAgeMs = options.maxAgeMs ?? 15_000;
  const now = options.now ?? Date.now;
  let base: TelemetryBase | null = null;
  let building: Promise<TelemetryBase> | null = null;

  const current = () => base !== null && base.revision === store.telemetryRevision() && now() - base.builtAt <= maxAgeMs;
  const ensure = () => {
    if (current()) return Promise.resolve(base!);
    if (building) return building;
    const started = new Date(now());
    building = buildTelemetryBase(store, started, options)
      .then(next => { base = next; return next; })
      .finally(() => { building = null; });
    return building;
  };

  return async (input: unknown) => telemetrySnapshotFromBase(await ensure(), input);
}
