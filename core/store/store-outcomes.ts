import { realpathSync } from "node:fs";
import { noticeSchema,outcomeSchema,type Notice,type Outcome,type OutcomeSearchInput,type OutcomeSearchResult,type RepositorySettings,type Run,type Task } from "../../shared/contracts";
import { hookRecordSchema,type HookRecord } from "../../shared/hooks";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { currentBrief } from "../planning/brief";
import { addOutcomeToLaneIndex } from "../planning/lanes";
import { digest,now,StoreCore } from "./store-core";
import { VERB_OUTCOME_RETENTION_MS } from "./store-retention";
import { repositoryIdentity,StoreTasks } from "./store-tasks";

/** One recorded task control outcome (round 4 telemetry). */
export interface VerbOutcome { taskId: string; at: string; action: string; outcome: "applied" | "refused"; source: "owner" | "coordinator"; detail: Record<string, unknown> }

/** Read an outcome row; the legacy readers went with schema 54 (task 989) and stored rows are today's shape. */
function readOutcomeRecord(data: string): unknown {
  return JSON.parse(data);
}


/** Stable Spec 025 paging cursor on (finishedAt, taskId); opaque to callers. */
const encodeOutcomeCursor = (cursor: { finishedAt: string | null; taskId: string }) =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

function decodeOutcomeCursor(value: string): { finishedAt: string | null; taskId: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new Error("Invalid outcome search cursor"); }
  const cursor = parsed as { finishedAt?: unknown; taskId?: unknown } | null;
  if (!cursor || typeof cursor !== "object" || (cursor.finishedAt !== null && typeof cursor.finishedAt !== "string") || typeof cursor.taskId !== "string" || !cursor.taskId)
    throw new Error("Invalid outcome search cursor");
  return { finishedAt: cursor.finishedAt ?? null, taskId: cursor.taskId };
}


const originFromPrUrl = (url: string | null): string | null => {
  if (!url) return null;
  const match = url.match(/(?:github\.com[:/])([^/]+\/[^/#?]+)/i);
  return match ? match[1].replace(/\.git$/i, "") : null;
};

const outcomeActors = (profiles: Array<{ id: string; model: string } | null | undefined>) => {
  const seen = new Set<string>(), actors: Outcome["workers"] = [];
  for (const profile of profiles) {
    if (!profile?.id || !profile.model) continue;
    const key = `${profile.id}\0${profile.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actors.push({ profileId: profile.id, model: profile.model });
  }
  return actors;
};

const closeoutAuthorityRecord = (task: Task, runs: Run[], hooks: HookRecord[]): Outcome["closeout"] => {
  // Owner-accepted report-only outcomes have no repository closeout authority.
  if (task.reportAcceptance) return null;
  const published = [...hooks].reverse().find(record =>
    record.event === "task.closeout" && record.delivery === "required" && record.mode === "integration_write"
    && (record.state === "published" || Boolean(record.commit)));
  if (published) return { authority: "hook", commit: published.commit };
  const closeoutRun = [...runs].reverse().find(run => run.role === "closeout");
  if (closeoutRun) return { authority: "agent", commit: closeoutRun.completion?.closeoutCommit ?? null };
  if (task.phase === "done") return { authority: "queue", commit: null };
  return null;
};

export function buildOutcomeRecord(task: Task, runs: Run[], hooks: HookRecord[], backfilled: boolean): Outcome {
  const superseded = task.phase === "cancelled" && task.disposition?.kind === "supersede";
  const prNumber = task.reviewEntry?.prNumber ?? task.resumePrNumber ?? task.completion?.prNumber ?? null;
  const review = task.resolution.review;
  const validation = task.resolution.mechanicalVerification ? `mechanical verification at ${task.resolution.mechanicalVerification.head}` : null;
  return outcomeSchema.parse({
    taskId: task.id, planningSource: task.planningSource, submissionId: task.submissionId, title: task.title,
    repository: { origin: task.repository && normalizeRepositoryOrigin(task.repository) ? task.repository : originFromPrUrl(task.prUrl), path: task.repoPath },
    outcome: task.phase === "done" ? "done" : superseded ? "superseded" : "cancelled",
    replacementTaskId: superseded ? task.disposition?.replacementTaskId ?? null : null,
    reason: task.reason,
    pr: task.prUrl || prNumber || task.prHead ? { url: task.prUrl, number: prNumber, head: task.prHead } : null,
    mergeCommit: task.resolution.mergedCommit, syncedCommit: task.resolution.syncedCommit,
    review: review ? { status: review.status, summary: review.summary, commentId: review.reviewCommentId ?? null, reviewId: review.reviewId ?? null } : null,
    validation: validation || task.resolution.projectValidation ? {
      summary: validation ?? `Project validation ${task.resolution.projectValidation!.state}`,
      ...(task.resolution.projectValidation ? { project: task.resolution.projectValidation } : {}),
    } : null,
    closeout: closeoutAuthorityRecord(task, runs, hooks),
    reportAcceptance: task.reportAcceptance ?? null,
    // The last qualified owner acceptance, recorded beside the reviewer verdict this task merged under.
    ownerAcceptance: task.resolution.ownerAcceptances?.at(-1) ?? null,
    brief: briefOutcome(task),
    workers: outcomeActors([task.profile, ...task.retiredWorkers.map(worker => worker.profile)]),
    reviewers: outcomeActors([task.resolution.reviewerProfile, ...runs.filter(run => run.role === "reviewer").map(run => run.profile)]),
    routing:{scope:task.scope,complexity:task.complexity??null,preferredProfileId:task.preferredProfileId,requirePreferred:task.requirePreferred,thinkingOptionId:task.thinkingOptionId,profileRequests:task.profileRequests},
    siblings: task.siblingPins.map(pin => ({ repository: pin.repository, commit: pin.commit })),
    startedAt: task.createdAt, finishedAt: task.finishedAt, backfilled,
    lanes: task.lanes,
    ...(task.laneDocumentPins?.length ? { laneDocuments: task.laneDocumentPins.map(({ key, version, digest }) => ({ key, version, digest })) } : {}),
  });
}

/** Spec 020: a Queue-held brief records the version it finished under and the digests it replaced. */
function briefOutcome(task: Task): Outcome["brief"] {
  const current = currentBrief(task);
  if (!current) return { digest: `sha256:${digest(task.handoffText)}`, mediaType: task.instruction?.mediaType ?? "text/markdown", text: task.handoffText, source: "handoff", version: null, earlierDigests: [] };
  return { digest: current.digest, mediaType: current.mediaType, text: current.text, source: "queue", version: current.version,
    earlierDigests: [...(task.leadProvenance?.earlierDigests ?? []), ...task.briefVersions.slice(0, -1).map(version => version.digest)],
    ...(task.leadProvenance ? {approval:task.leadProvenance.approval} : {}) };
}

interface QueueEventRow { id: number; taskId: string; at: string; kind: string; detail: string }

export type TelemetryFactChunk =
  | { kind: "tasks"; tasks: Task[] }
  | { kind: "events"; events: { taskId: string; event: QueueEventRow }[] }
  | { kind: "runs"; runs: { taskId: string; run: Run }[] }
  | { kind: "notices"; notices: { taskId: string; notice: Notice }[] }
  | { kind: "hooks"; hooks: { taskId: string; hook: HookRecord }[] };
interface Ports {
  tasksStore: StoreTasks;
  numberFor: (taskId: string) => { number: number; reference: string } | null;
  settledDependents: Set<string>;
  repositorySettingsFor: (repository: { origin: string | null; path: string }) => RepositorySettings | null;
  laneOutcomeIndex: Map<string, Outcome[]> | null;
  outcomeRowsClock: number;
}
export class StoreOutcomes {
  constructor(private readonly core: StoreCore, private readonly ports: Ports) {}
  private get db() { return this.core.db; }
  private transaction<T>(fn: () => T): T { return this.core.transaction(fn); }
  private advanceRevision() { return this.core.advanceRevision(); }
  private readClock(name: string) { return this.core.readClock(name); }
  private get tasksStore() { return this.ports.tasksStore; }
  private numberFor = (...args: Parameters<Ports["numberFor"]>) => this.ports.numberFor(...args);
  private get settledDependents() { return this.ports.settledDependents; }
  private repositorySettingsFor = (...args: Parameters<Ports["repositorySettingsFor"]>) => this.ports.repositorySettingsFor(...args);
  private get laneOutcomeIndex() { return this.ports.laneOutcomeIndex; }
  private set laneOutcomeIndex(value: Ports["laneOutcomeIndex"]) { this.ports.laneOutcomeIndex = value; }
  private get outcomeRowsClock() { return this.ports.outcomeRowsClock; }
  private set outcomeRowsClock(value: Ports["outcomeRowsClock"]) { this.ports.outcomeRowsClock = value; }

  numberedOutcome(data: string): Outcome {
    const outcome = outcomeSchema.parse(readOutcomeRecord(data));
    return { ...outcome, ...this.numberFor(outcome.taskId) };
  }

  /**
   * Bounded bulk reads for the shared telemetry base. Each yielded chunk is one page so a
   * caller can hand the event loop back between pages instead of monopolising it.
   */
  *telemetryFactChunks(page = 500): Generator<TelemetryFactChunk> {
    let taskCursor = 0;
    while (true) {
      const rows = this.db.prepare("SELECT rowid AS k,id FROM tasks WHERE json_extract(data, '$.removedAt') IS NULL AND rowid>? ORDER BY rowid LIMIT ?").all(taskCursor, page) as { k: number; id: string }[];
      if (!rows.length) break;
      taskCursor = Number(rows.at(-1)!.k);
      // Parsed rows come from the incremental projection, not a per-row zod parse.
      yield { kind: "tasks", tasks: rows.map(row => this.tasksStore.projectedTask(String(row.id)) ?? this.tasksStore.snapshotTask(String(row.id))) };
    }
    let eventCursor = 0;
    while (true) {
      const rows = this.db.prepare("SELECT id,taskId,at,kind,detail FROM events WHERE id>? ORDER BY id LIMIT ?").all(eventCursor, page) as unknown as QueueEventRow[];
      if (!rows.length) break;
      eventCursor = Number(rows.at(-1)!.id);
      yield { kind: "events", events: rows.map(row => ({ taskId: String(row.taskId), event: { id: Number(row.id), taskId: String(row.taskId), at: String(row.at), kind: String(row.kind), detail: String(row.detail) } })) };
    }
    let runCursor = 0;
    while (true) {
      const rows = this.db.prepare("SELECT rowid AS k,taskId,data FROM runs WHERE rowid>? ORDER BY rowid LIMIT ?").all(runCursor, page) as { k: number; taskId: string; data: string }[];
      if (!rows.length) break;
      runCursor = Number(rows.at(-1)!.k);
      yield { kind: "runs", runs: rows.map(row => ({ taskId: String(row.taskId), run: JSON.parse(String(row.data)) as Run })) };
    }
    let noticeCursor = 0;
    while (true) {
      const rows = this.db.prepare("SELECT rowid AS k,taskId,data FROM notices WHERE rowid>? ORDER BY rowid LIMIT ?").all(noticeCursor, page) as { k: number; taskId: string; data: string }[];
      if (!rows.length) break;
      noticeCursor = Number(rows.at(-1)!.k);
      yield { kind: "notices", notices: rows.map(row => ({ taskId: String(row.taskId), notice: noticeSchema.parse(JSON.parse(String(row.data))) })) };
    }
    let hookCursor = 0;
    while (true) {
      // Audit B7: hooks join the live tasks the base derives from, so an orphan occurrence
      // whose task the retention purge removed is never parsed into a fact bundle it cannot
      // belong to. A removed task counts as absent exactly as the task chunk does.
      const rows = this.db.prepare(`SELECT h.rowid AS k,h.taskId AS taskId,h.data AS data FROM hook_events AS h
        JOIN tasks AS t ON t.id=h.taskId
        WHERE json_extract(t.data,'$.removedAt') IS NULL AND h.rowid>? ORDER BY h.rowid LIMIT ?`).all(hookCursor, page) as { k: number; taskId: string; data: string }[];
      if (!rows.length) break;
      hookCursor = Number(rows.at(-1)!.k);
      yield { kind: "hooks", hooks: rows.map(row => ({ taskId: String(row.taskId), hook: hookRecordSchema.parse(JSON.parse(String(row.data))) })) };
    }
  }

  telemetryFacts(page = 500) {
    const facts = { tasks: [] as Task[], eventsByTask: new Map<string, QueueEventRow[]>(), runsByTask: new Map<string, Run[]>(), noticesByTask: new Map<string, Notice[]>(), hooksByTask: new Map<string, HookRecord[]>() };
    const push = <T>(map: Map<string, T[]>, taskId: string, value: T) => { const list = map.get(taskId); if (list) list.push(value); else map.set(taskId, [value]); };
    for (const chunk of this.telemetryFactChunks(page)) {
      if (chunk.kind === "tasks") facts.tasks.push(...chunk.tasks);
      else if (chunk.kind === "events") for (const row of chunk.events) push(facts.eventsByTask, row.taskId, row.event);
      else if (chunk.kind === "runs") for (const row of chunk.runs) push(facts.runsByTask, row.taskId, row.run);
      else if (chunk.kind === "notices") for (const row of chunk.notices) push(facts.noticesByTask, row.taskId, row.notice);
      else for (const row of chunk.hooks) push(facts.hooksByTask, row.taskId, row.hook);
    }
    return facts;
  }

  /**
   * Round 4: one applied or refused task control, for telemetry only. Owner
   * controls are recorded by the control path, coordinator actions once when
   * their report settles. A `key` (the durable operation, or the coordinator
   * report) records an outcome at most once, so a replay never counts twice.
   * Outcomes never touch the task's history, so they live outside `events`;
   * rows older than 30 days are pruned on write.
   */
  recordVerbOutcome(taskId: string, action: string, outcome: VerbOutcome["outcome"], source: VerbOutcome["source"], detail: Record<string, unknown>, key: string | null = null): void {
    const at = now();
    this.db.prepare("INSERT OR IGNORE INTO verb_outcomes(taskId,at,action,outcome,source,key,detail) VALUES(?,?,?,?,?,?,?)").run(taskId, at, action, outcome, source, key, JSON.stringify(detail));
    this.db.prepare("DELETE FROM verb_outcomes WHERE at < ?").run(new Date(Date.parse(at) - VERB_OUTCOME_RETENTION_MS).toISOString());
  }


  /** Task control outcomes since `since` (ISO time), oldest first. */
  verbOutcomes(since: string): VerbOutcome[] {
    return (this.db.prepare("SELECT taskId,at,action,outcome,source,detail FROM verb_outcomes WHERE at >= ? ORDER BY id").all(since) as Array<Omit<VerbOutcome, "detail"> & { detail: string }>)
      .map(row => ({ ...row, detail: JSON.parse(row.detail) }));
  }

  /** Permanent outcome row; never rewritten or purged. */
  putOutcome(record: Outcome): Outcome {
    if (!this.db.isTransaction) return this.transaction(() => this.putOutcome(record));
    const existing = this.outcome(record.taskId);
    if (existing) return existing;
    const parsed = outcomeSchema.parse(record);
    this.insertOutcomeRow(parsed);
    this.tasksStore.ensureTaskProjection();
    const dependents = [...(this.tasksStore.dependentIndex.get(parsed.taskId) ?? [])];
    for (const dependent of dependents) this.settledDependents.add(dependent);
    // The search projection is written in the same transaction as the row, so
    // a row is searchable as soon as it exists (Spec 025).
    this.indexOutcome(parsed);
    const task = this.db.prepare("SELECT json_extract(data,'$.baseBranch') AS branch FROM tasks WHERE id=?").get(parsed.taskId);
    // Lean store 2 (task 987): only a repository with a QA schedule reads these rows, so an
    // unscheduled repository never accumulates a backlog.
    const scheduledMerge = parsed.outcome === "done" && parsed.mergeCommit && task?.branch === "main"
      ? this.repositorySettingsFor(parsed.repository) : null;
    if (scheduledMerge?.qa?.schedule)
      this.db.prepare("INSERT OR IGNORE INTO qa_schedule_merges(taskId,repository) VALUES(?,?)").run(parsed.taskId, parsed.repository.origin ?? parsed.repository.path);
    this.indexOutcomeLanes(parsed);
    // A permanent outcome is a board fact — it moves the lane's terminal count and the
    // selected task's outcome view — whether it lands in a terminal task write or later on
    // its own. The lane-index revision moved in `insertOutcomeRow`; the board projection
    // must drop too, or a late outcome would only appear at the next unrelated write.
    this.advanceRevision();
    return parsed;
  }

  insertOutcomeRow(parsed: Outcome): void {
    this.db.prepare("INSERT INTO outcomes(taskId,submissionId,data) VALUES(?,?,?)").run(parsed.taskId, parsed.submissionId, JSON.stringify(parsed));
    // The outcome joins the lane index in place: a finished task used to drop the whole
    // list, so the next board rebuild re-read and re-parsed every permanent outcome (175 ms
    // measured on the live store). A rollback drops the index with the row.
    if (this.laneOutcomeIndex) { addOutcomeToLaneIndex(this.laneOutcomeIndex, parsed); this.outcomeRowsClock = this.readClock("outcomeRows"); }
  }

  /** Searchable projection of one outcome row; never read for anything but search. */
  indexOutcome(parsed: Outcome): void {
    this.db.prepare("UPDATE outcomes SET repository=?,outcome=?,finished_at=?,merge_commit=?,synced_commit=?,pr_head=?,pr_number=? WHERE taskId=?")
      .run(parsed.repository.origin ?? parsed.repository.path, parsed.outcome, parsed.finishedAt, parsed.mergeCommit, parsed.syncedCommit, parsed.pr?.head ?? null, parsed.pr?.number ?? null, parsed.taskId);

  }

  /** Spec 019 revision: one index row per task and lane, rebuilt from the outcome row. */
  indexOutcomeLanes(parsed: Outcome): void {
    this.db.prepare("DELETE FROM outcome_lane_index WHERE taskId=?").run(parsed.taskId);
    for (const lane of parsed.lanes) this.db.prepare("INSERT OR IGNORE INTO outcome_lane_index(taskId,lane) VALUES(?,?)").run(parsed.taskId, lane);
  }

  /**
   * The projection is rebuildable from the rows, which stay the source of truth.
   * Returns the number of indexed outcome rows.
   */
  rebuildOutcomeSearchIndex(): number {
    return this.transaction(() => {
      this.db.exec("INSERT INTO outcomes_fts(outcomes_fts) VALUES ('rebuild')");
      this.db.prepare("DELETE FROM outcome_lane_index").run();
      const rows = this.db.prepare("SELECT taskId,data FROM outcomes").all();
      for (const row of rows) {
        const parsed = outcomeSchema.parse(readOutcomeRecord(String(row.data)));
        this.indexOutcome(parsed);
        this.indexOutcomeLanes(parsed);
      }
      return rows.length;
    });
  }

  /**
   * Spec 025 outcome search: read-only, AND-combined optional filters, newest
   * first, bounded page with a stable (finishedAt, taskId) cursor. Brief text
   * never leaves the store outside a text-search excerpt.
   */
  searchOutcomes(input: OutcomeSearchInput): OutcomeSearchResult {
    const filters = ["o.outcome = ?"];
    const params: (string | number)[] = [input.outcome ?? "done"];
    if (input.repository) {
      // An origin-shaped input matches directly; a checkout path resolves
      // through its origin remote, and the resolved path stays a candidate so
      // rows recorded without an origin still match.
      const identities = new Set<string>();
      identities.add(normalizeRepositoryOrigin(input.repository) ?? repositoryIdentity(input.repository));
      try { identities.add(realpathSync(input.repository)); } catch { /* An unresolvable path matches by its resolved origin alone. */ }
      filters.push(`o.repository IN (${[...identities].map(() => "?").join(",")})`);
      params.push(...identities);
    }
    if (input.lane) { filters.push("o.taskId IN (SELECT taskId FROM outcome_lane_index WHERE lane=?)"); params.push(input.lane); }
    if (input.since !== undefined) { filters.push("o.finished_at >= ?"); params.push(new Date(input.since).toISOString()); }
    if (input.until !== undefined) { filters.push("o.finished_at <= ?"); params.push(new Date(input.until).toISOString()); }
    if (input.commit !== undefined) {
      const prefix = `${input.commit.toLowerCase()}%`;
      filters.push("(o.merge_commit LIKE ? OR o.synced_commit LIKE ? OR o.pr_head LIKE ?)");
      params.push(prefix, prefix, prefix);
    }
    if (input.pr !== undefined) { filters.push("o.pr_number = ?"); params.push(input.pr); }
    let match: string | null = null;
    if (input.text !== undefined) {
      const terms = input.text.split(/\s+/).filter(term => /(\p{L}|\p{N})/u.test(term)).map(term => `"${term.replace(/"/g, "\"\"")}"`);
      if (terms.length) match = terms.join(" ");
    }
    const cursor = input.cursor !== undefined ? decodeOutcomeCursor(input.cursor) : null;
    if (cursor) {
      if (cursor.finishedAt === null) { filters.push("o.finished_at IS NULL AND o.taskId < ?"); params.push(cursor.taskId); }
      else { filters.push("(o.finished_at IS NULL OR o.finished_at < ? OR (o.finished_at = ? AND o.taskId < ?))"); params.push(cursor.finishedAt, cursor.finishedAt, cursor.taskId); }
    }
    const limit = input.limit ?? 20;
    // The page identity is chosen first over small columns, so the sorter never
    // materialises outcome JSON for the whole match set; payloads and excerpts
    // are then fetched for the page only.
    const order = "ORDER BY (o.finished_at IS NULL) ASC,o.finished_at DESC,o.taskId DESC";
    const idRows = (match
      ? this.db.prepare(`SELECT o.taskId AS taskId,o.finished_at AS finishedAt FROM outcomes_fts f JOIN outcomes o ON o.taskId=f.taskId WHERE outcomes_fts MATCH ? AND ${filters.join(" AND ")} ${order} LIMIT ?`)
        .all(match, ...params, limit + 1)
      : this.db.prepare(`SELECT o.taskId AS taskId,o.finished_at AS finishedAt FROM outcomes o WHERE ${filters.join(" AND ")} ${order} LIMIT ?`)
        .all(...params, limit + 1)) as { taskId: string; finishedAt: string | null }[];
    const hasMore = idRows.length > limit;
    const page = hasMore ? idRows.slice(0, limit) : idRows;
    const ids = page.map(row => row.taskId);
    const placeholders = ids.map(() => "?").join(",");
    const dataById = new Map<string, string>();
    if (ids.length)
      for (const row of this.db.prepare(`SELECT taskId,data FROM outcomes WHERE taskId IN (${placeholders})`).all(...ids) as { taskId: string; data: string }[])
        dataById.set(String(row.taskId), String(row.data));
    const snippetsById = new Map<string, Record<string, string>>();
    if (match && ids.length) {
      for (const row of this.db.prepare(`SELECT taskId,snippet(outcomes_fts,0,'[',']','…',16) AS title, snippet(outcomes_fts,1,'[',']','…',16) AS brief, snippet(outcomes_fts,2,'[',']','…',16) AS review, snippet(outcomes_fts,3,'[',']','…',16) AS reason FROM outcomes_fts WHERE outcomes_fts MATCH ? AND taskId IN (${placeholders})`).all(match, ...ids) as { taskId: string; title: string; brief: string; review: string; reason: string }[])
        snippetsById.set(String(row.taskId), row);
    }
    const excerptFor = (taskId: string): OutcomeSearchResult["results"][number]["excerpt"] => {
      const snippets = snippetsById.get(taskId);
      if (!snippets) return null;
      for (const field of ["title", "brief", "review", "reason"] as const)
        if (snippets[field]?.includes("[")) return { field, text: snippets[field] };
      return null;
    };
    const results = page.map(row => {
      const data = dataById.get(row.taskId);
      if (!data) throw new Error(`Outcome row disappeared during search: ${row.taskId}`);
      const outcome = outcomeSchema.parse(readOutcomeRecord(data));
      return {
        taskId: outcome.taskId,
        reference: this.numberFor(outcome.taskId)?.reference ?? null,
        title: outcome.title,
        repository: outcome.repository.origin ?? outcome.repository.path,
        outcome: outcome.outcome,
        lanes: outcome.lanes,
        prNumber: outcome.pr?.number ?? null,
        prUrl: outcome.pr?.url ?? null,
        mergeCommit: outcome.mergeCommit,
        finishedAt: outcome.finishedAt,
        backfilled: outcome.backfilled,
        replacementTaskId: outcome.replacementTaskId,
        excerpt: excerptFor(outcome.taskId),
      };
    });
    const last = page.at(-1);
    return {
      results,
      cursor: hasMore && last ? encodeOutcomeCursor({ finishedAt: last.finishedAt, taskId: last.taskId }) : null,
      hasMore,
    };
  }

  outcome(taskId: string): Outcome | null {
    const row = this.db.prepare("SELECT data FROM outcomes WHERE taskId=?").get(taskId);
    return row ? this.numberedOutcome(String(row.data)) : null;
  }

  outcomeBySubmission(submissionId: string): Outcome | null {
    const row = this.db.prepare("SELECT data FROM outcomes WHERE submissionId=?").get(submissionId);
    return row ? this.numberedOutcome(String(row.data)) : null;
  }

  outcomes(): Outcome[] {
    return this.db.prepare("SELECT data FROM outcomes ORDER BY rowid").all().map(row => this.numberedOutcome(String(row.data)));
  }
}
