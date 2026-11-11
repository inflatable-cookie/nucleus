import type { BriefVersion } from "../../shared/contracts";
import { laneDocumentPinSchema,submissionRecordFromLegacy,taskSchema,type LaneDocumentPin,type LaneDocumentVersion,type Run,type Task } from "../../shared/contracts";
import { briefDigest } from "../planning/brief";
import { digest,StoreCore } from "./store-core";
import { StoreTasks } from "./store-tasks";


/** One stored task's detached parts; a bulk read supplies the side stores for its page. */
export interface StoredTaskParts {
  briefVersions?: BriefVersion[];
  reviews?: Pick<Task["resolution"], "review" | "reviews">;
  /** The stored observation row, or null when the task has none; absent means look it up. */
  observation?: string | null;
}

/** The observation-only fields: an observation pass may move them without changing a board fact. */
export const STORED_OBSERVATION_FIELDS = ["lastObservedAt", "agentActive", "lastAgentStatus", "idleSince"] as const;

/** One detached part's stored entries, keyed as its table keys them. */
export type DetachedEntries = ReadonlyArray<readonly [number, unknown]>;

const briefVersionEntries = (task: Pick<Task, "briefVersions"> | null): DetachedEntries =>
  (task?.briefVersions ?? []).map(version => [version.version, version] as const);

/** `task_reviews` keeps the current review at seq 0 and the review records at 1..n, oldest first. */
const reviewEntries = (task: Pick<Task, "resolution"> | null): DetachedEntries => [
  ...(task?.resolution.review ? [[0, task.resolution.review] as const] : []),
  ...(task?.resolution.reviews ?? []).map((record, i) => [i + 1, record] as const)];

function reviewsFromRows(rows: ReadonlyArray<{ seq: number; data: string }>): Pick<Task["resolution"], "review" | "reviews"> {
  return { review: rows[0]?.seq === 0 ? JSON.parse(rows[0].data) : null,
    reviews: rows.filter(row => row.seq > 0).map(row => JSON.parse(row.data)) };
}

/**
 * Read a task row. The pre-`lanes` single-lane shape went with schema 54 (task 989); rows
 * parse through the wire rename so a submission written by an older client still reconciles.
 */
function readTaskRecord(data: string): unknown {
  return submissionRecordFromLegacy(JSON.parse(data), "task");
}
interface Ports {
  tasksStore: StoreTasks;
  laneDocument: (key: string, version?: number) => LaneDocumentVersion | null;
}
export class StoreTaskWrites {
  constructor(private readonly core: StoreCore, private readonly ports: Ports) {}
  private get db() { return this.core.db; }
  private get tasksStore() { return this.ports.tasksStore; }
  private laneDocument = (...args: Parameters<Ports["laneDocument"]>) => this.ports.laneDocument(...args);

  /**
   * Fresh observation times for the board's 45 s unsettled counters. The counters must not read
   * the cached board projection: an observation-only write intentionally leaves that projection
   * in place, and elapsed time crosses the boundary with no write at all. Point reads of one
   * extracted field per id keep this far cheaper than re-projecting the whole board.
   */
  observationTimes(kind: "task" | "run", ids: Iterable<string>): Map<string, string | null> {
    const wanted = [...new Set(ids)], times = new Map<string, string | null>();
    for (let start = 0; start < wanted.length; start += 400) {
      const chunk = wanted.slice(start, start + 400);
      const placeholders = chunk.map(() => "?").join(",");
      // Audit B6: an observation-only task write lands in `task_observations`, so the
      // counters read it there. An inline value on the row is the form a row written
      // before schema 45 carries and still wins, exactly as it reads.
      const rows = kind === "task"
        ? this.db.prepare(`SELECT t.id AS id, COALESCE(json_extract(t.data,'$.lastObservedAt'), json_extract(o.data,'$.lastObservedAt')) AS at
            FROM tasks t LEFT JOIN task_observations o ON o.taskId=t.id WHERE t.id IN (${placeholders})`).all(...chunk)
        : this.db.prepare(`SELECT id, json_extract(data,'$.lastObservedAt') AS at FROM runs WHERE id IN (${placeholders})`).all(...chunk);
      for (const row of rows) times.set(String(row.id), row.at == null ? null : String(row.at));
    }
    return times;
  }

  /**
   * One task's stored parts. Brief versions and reviews come from their own tables; the
   * referenced text comes from brief versions, and the observation-only fields
   * from `task_observations`. A bulk reader supplies those two side stores for its page so
   * a projection build looks none of them up per task.
   */
  resolveStoredTask(raw: Record<string, unknown>, parts?: StoredTaskParts): Task {
    const id = String(raw.id);
    const record: Record<string, unknown> = { ...raw };
    const versions = parts?.briefVersions ?? this.storedBriefVersions(id);
    const texts = new Map(versions.map(version => [briefDigest(version.text), version.text]));
    // Schema 54 rows still refer to the detached table during the backed-up migration.
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_texts'").get())
      for (const row of this.db.prepare("SELECT digest,text FROM task_texts WHERE taskId=?").all(id))
        texts.set(String(row.digest), String(row.text));
    const textFor = (value: unknown, label: string): string => {
      const digest = String(value ?? "");
      const text = texts.get(digest);
      if (text === undefined) throw new Error(`Task ${id} has no stored ${label} text for ${digest || "an unnamed digest"}; refusing to derive it`);
      if (briefDigest(text) !== digest) throw new Error(`Task ${id} has a stored ${label} text that does not match ${digest}; refusing to derive it`);
      return text;
    };
    // Audit B6: the row names its handoff text by digest instead of copying it. A row that
    // still carries the text inline is one written before schema 45 and is read as written.
    if (!("handoffText" in record)) {
      if (record.handoffDigest === undefined) throw new Error(`Task ${id} has neither stored handoff text nor a digest; refusing to derive it`);
      record.handoffText = textFor(record.handoffDigest, "handoff");
    }
    delete record.handoffDigest;
    const brief = record.brief;
    if (brief && typeof brief === "object" && !Array.isArray(brief) && !("text" in brief)) {
      const briefRecord = brief as Record<string, unknown>;
      record.brief = { ...briefRecord, text: textFor(briefRecord.digest, "brief") };
    }
    if (Array.isArray(record.laneDocumentPins)) record.laneDocumentPins = record.laneDocumentPins.map(pin => this.resolvedPin(id, pin));
    // An observation-only field present on the row is an inline form (schema 44 or a
    // deliberately written fixture); otherwise the values are the ones last observed.
    const inlineObservation = STORED_OBSERVATION_FIELDS.some(field => field in record);
    if (!inlineObservation) {
      const storedRaw = parts && "observation" in parts ? parts.observation : this.storedObservationRow(id);
      const stored = storedRaw ? JSON.parse(storedRaw) as Record<string, unknown> : {};
      for (const field of STORED_OBSERVATION_FIELDS) record[field] = stored[field] ?? null;
      // An observation-only write moves the task's write time without rewriting its row,
      // so the newer of the two is the time every reader saw before the fields moved.
      const seen = stored.updatedAt;
      if (typeof seen === "string" && String(record.updatedAt ?? "") < seen) record.updatedAt = seen;
    }
    const resolution = (record.resolution ?? {}) as Record<string, unknown>;
    const complete = {
      ...record,
      ...("briefVersions" in record ? {} : { briefVersions: versions }),
      ...("review" in resolution || "reviews" in resolution ? {} : { resolution: { ...resolution, ...(parts?.reviews ?? this.storedReviews(id)) } }),
    };
    return taskSchema.parse(complete);
  }

  /**
   * The exact text a lane-document pin names. A pin is resolved from the stored version it
   * was taken from and its digest is checked on every read, so a later document edit cannot
   * change it. A missing version, or bytes that do not match the pin, refuses: the current
   * document is never substituted. A legacy pin that still carries its own text keeps those
   * recorded bytes, which is what every reader saw before the pin was slimmed.
   */
  resolvedPin(taskId: string, value: unknown): LaneDocumentPin {
    if (value && typeof value === "object" && "text" in value) return laneDocumentPinSchema.parse(value);
    const pin = value as { key?: unknown; version?: unknown; digest?: unknown };
    const key = String(pin?.key ?? ""), version = Number(pin?.version ?? 0), digest = String(pin?.digest ?? "");
    const document = key && version ? this.laneDocument(key, version) : null;
    if (!document) throw new Error(`Task ${taskId} pins lane document ${key} v${version}, which is not stored; refusing to resolve its text`);
    if (document.key !== key || document.version !== version || document.digest !== digest || briefDigest(document.text) !== digest)
      throw new Error(`Task ${taskId} pins lane document ${key} v${version} but its stored bytes do not match ${digest}; refusing to resolve its text`);
    return { key, version, digest, text: document.text };
  }

  storedObservationRow(taskId: string): string | null {
    const row = this.db.prepare("SELECT data FROM task_observations WHERE taskId=?").get(taskId);
    return row ? String(row.data) : null;
  }

  /** The observation-only fields and the write time that moved them, as one small row. */
  syncTaskObservation(taskId: string, task: Task) {
    const data = JSON.stringify({ updatedAt: task.updatedAt, lastObservedAt: task.lastObservedAt,
      agentActive: task.agentActive, lastAgentStatus: task.lastAgentStatus, idleSince: task.idleSince });
    if (this.storedObservationRow(taskId) === data) return;
    this.db.prepare("INSERT INTO task_observations(taskId,data) VALUES(?,?) ON CONFLICT(taskId) DO UPDATE SET data=excluded.data").run(taskId, data);
  }

  /**
   * A pin as the row stores it: identity only when the lane document's stored version proves
   * the same bytes. A pin whose version cannot be proven keeps its recorded text inline rather
   * than being resolved to content it never named.
   */
  storablePin(pin: LaneDocumentPin): LaneDocumentPin | Omit<LaneDocumentPin, "text"> {
    const document = this.laneDocument(pin.key, pin.version);
    if (document && document.digest === pin.digest && document.text === pin.text) return { key: pin.key, version: pin.version, digest: pin.digest };
    return pin;
  }

  numberedTask(data: string, parts?: StoredTaskParts): Task {
    const task = this.resolveStoredTask(readTaskRecord(data) as Record<string, unknown>, parts);
    const number = this.tasksStore.numberForCached(task.id);
    return number ? { ...task, ...number } : task;
  }

  storedBriefVersions(taskId: string): BriefVersion[] {
    return this.db.prepare("SELECT data FROM task_brief_versions WHERE taskId=? ORDER BY version").all(taskId).map(row => JSON.parse(String(row.data)));
  }

  storedReviews(taskId: string): Pick<Task["resolution"], "review" | "reviews"> {
    return this.resolveReviewRows(this.db.prepare("SELECT seq,data FROM task_reviews WHERE taskId=? ORDER BY seq").all(taskId)
      .map(row => ({ seq: Number(row.seq), data: String(row.data) })));
  }

  resolveReviewRows(rows: Array<{ seq: number; data: string }>): Pick<Task["resolution"], "review" | "reviews"> {
    return reviewsFromRows(rows.map(row => {
      const value = JSON.parse(row.data) as Record<string, unknown>;
      if (typeof value.reviewTextDigest === "string") {
        const found = this.db.prepare("SELECT json_extract(data,'$.completion.reviewText') AS text FROM runs WHERE id=? AND taskId=?")
          .get(String(value.runId), String(value.taskId));
        if (typeof found?.text !== "string" || digest(found.text) !== value.reviewTextDigest)
          throw new Error(`Review ${String(value.runId)} has missing or changed findings text`);
        value.reviewText = found.text;
        delete value.reviewTextDigest;
      }
      return { ...row, data: JSON.stringify(value) };
    }));
  }

  storedReviewValue(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    const review = value as Record<string, unknown>;
    if (typeof review.reviewText !== "string") return value;
    const found = this.db.prepare("SELECT json_extract(data,'$.completion.reviewText') AS text FROM runs WHERE id=? AND taskId=?")
      .get(String(review.runId), String(review.taskId));
    if (found?.text !== review.reviewText) return value;
    const { reviewText, ...rest } = review;
    return { ...rest, reviewTextDigest: digest(String(reviewText)) };
  }

  /**
   * Writes one detached part's entries that differ from `before` and deletes the
   * ones `after` dropped. An ordinary update carries the same objects, so it
   * writes none.
   */
  syncDetached(table: "task_brief_versions" | "task_reviews", column: "version" | "seq", taskId: string, before: DetachedEntries, after: DetachedEntries) {
    const stored = new Map(before);
    for (const [key, value] of after) {
      const prior = stored.get(key);
      if (value !== prior && JSON.stringify(value) !== JSON.stringify(prior))
        this.db.prepare(`INSERT INTO ${table}(taskId,${column},data) VALUES(?,?,?) ON CONFLICT(taskId,${column}) DO UPDATE SET data=excluded.data`)
          .run(taskId, key, JSON.stringify(table === "task_reviews" ? this.storedReviewValue(value) : value));
    }
    if (before.some(([key]) => !after.some(([next]) => next === key)))
      this.db.prepare(`DELETE FROM ${table} WHERE taskId=? AND ${column} NOT IN (SELECT value FROM json_each(?))`)
        .run(taskId, JSON.stringify(after.map(([key]) => key)));
  }

  /**
   * The task row as stored: everything but its brief versions and reviews (their own tables),
   * its referenced text and its observation-only
   * fields (`task_observations`). Audit B6: the row is the task's state, not its documents.
   */
  taskRow(task: Task, before: Task | null = null): string {
    this.syncDetached("task_brief_versions", "version", task.id, briefVersionEntries(before), briefVersionEntries(task));
    this.syncDetached("task_reviews", "seq", task.id, reviewEntries(before), reviewEntries(task));
    const handoffDigest = briefDigest(task.handoffText);
    const versionTexts = new Set(task.briefVersions.map(version => version.text));
    this.syncTaskObservation(task.id, task);
    const { briefVersions: _briefVersions, resolution: { review: _review, reviews: _reviews, ...resolution }, handoffText: _handoffText,
      lastObservedAt: _observedAt, agentActive: _active, lastAgentStatus: _agentStatus, idleSince: _idleSince, ...row } = task;
    if (row.completionNotificationAgentIds.length === 0) delete (row as Partial<Task>).completionNotificationAgentIds;
    // Defaults are restored by the resolution schema on read; empty histories
    // need not consume space in every task row.
    for (const key of ["buildOutputCleanups", "runtimeRetirements", "externalWorkspaceArchives", "ownerAcceptances", "reviewSupersessions"] as const) {
      if (resolution[key].length === 0) delete (resolution as Partial<Task["resolution"]>)[key];
    }
    if (resolution.ownerSettlements.length === 0) delete (resolution as Partial<Task['resolution']>).ownerSettlements;
    if (resolution.ownerCloseoutParticipants.length === 0) delete (resolution as Partial<Task['resolution']>).ownerCloseoutParticipants;
    return JSON.stringify({
      ...row,
      ...(versionTexts.has(task.handoffText) ? { handoffDigest } : { handoffText: task.handoffText }),
      // The brief keeps its identity; its text is in a brief version. One whose digest
      // does not name its bytes stays inline so no reader loses the bytes it recorded.
      ...(task.brief ? { brief: task.brief.digest === briefDigest(task.brief.text) && versionTexts.has(task.brief.text) ? { ...task.brief, text: undefined } : task.brief } : {}),
      ...(task.laneDocumentPins ? { laneDocumentPins: task.laneDocumentPins.map(pin => this.storablePin(pin)) } : {}),
      resolution,
    });
  }

  /**
   * True when the write differs from the stored row only in `lastObservedAt`, so no
   * board fact moves and the projection need not rebuild (audit A1: observations were
   * about 0.93 of the rebuilds a second). Nested values compare by serialized bytes
   * because every read hands back freshly parsed objects.
   */
  runObservationOnly(run: Run): boolean {
    const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(run.id);
    if (!row) return false;
    const stored = JSON.parse(String(row.data)) as Record<string, unknown>;
    const next = run as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(stored), ...Object.keys(next)])) {
      if (key === "lastObservedAt") continue;
      const before = stored[key], after = next[key];
      if (before === after) continue;
      if (before && after && typeof before === "object" && typeof after === "object" && JSON.stringify(before) === JSON.stringify(after)) continue;
      return false;
    }
    return true;
  }
}
