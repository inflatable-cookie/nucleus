/**
 * Spec 026 planning-history storage (audit B1, 2026-10-25; Tom's "Lead version
 * storage" ruling a1a817c3). A lead's or lane document's latest version is stored
 * in full; every older version is a reverse line delta against the version above
 * it, with a full snapshot every `SNAPSHOT_INTERVAL` versions. Each stored delta
 * rebuilds one version byte for byte and its digest is checked on every rebuild,
 * cache hits included, so corruption, truncation, a missing base or an unsupported
 * format refuses the read instead of serving different bytes.
 *
 * The delta format is Queue-local. It never reaches the contract 008 export, whose
 * versions stay full with the same digests, and a restored backup is the same
 * SQLite file, so the format boundary is the store schema.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const DELTA_FORMAT = "queue.reverse-lines";
export const DELTA_FORMAT_VERSION = 1;
/** A full body every this many versions, and always for the latest version. */
export const SNAPSHOT_INTERVAL = 32;
/** The most reverse deltas one rebuild may apply before it refuses a history with no snapshot. */
export const MAX_DELTA_CHAIN = SNAPSHOT_INTERVAL - 1;

export type PlanningHistoryKind = "lead" | "laneDocument";

interface HistoryTables {
  full: string;
  delta: string;
  key: string;
  /** The JSON field that carries the exact text of a version. */
  bodyField: string;
}

export const HISTORY_TABLES: Record<PlanningHistoryKind, HistoryTables> = {
  lead: { full: "lead_versions", delta: "lead_version_deltas", key: "leadId", bodyField: "body" },
  laneDocument: { full: "lane_documents", delta: "lane_document_deltas", key: "lane", bodyField: "text" },
};

export const CREATE_HISTORY_TABLES = `CREATE TABLE IF NOT EXISTS lead_version_deltas(
    leadId TEXT NOT NULL, version INTEGER NOT NULL, baseVersion INTEGER NOT NULL,
    bodyDigest TEXT NOT NULL, data TEXT NOT NULL, delta TEXT NOT NULL, PRIMARY KEY(leadId,version));
  CREATE TABLE IF NOT EXISTS lane_document_deltas(
    lane TEXT NOT NULL, version INTEGER NOT NULL, baseVersion INTEGER NOT NULL,
    bodyDigest TEXT NOT NULL, data TEXT NOT NULL, delta TEXT NOT NULL, PRIMARY KEY(lane,version));`;

export const historyDigest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** Split into lines that keep their own terminators, so joining them reproduces the exact bytes. */
export function splitHistoryLines(text: string): string[] {
  return text === "" ? [] : text.split(/(?<=\n)/);
}

export function isSnapshotVersion(version: number, latest: number): boolean {
  return version === latest || version % SNAPSHOT_INTERVAL === 0;
}

const refuse = (where: string, reason: string): never => {
  throw new Error(`${where}: ${reason}`);
};

// ---------- Reverse line deltas ----------

/** kind 0 copies `count` lines from the base body at line `start`; kind 1 inserts stored lines. */
export type HistoryDeltaOp = [kind: 0 | 1, start: number, count: number];

export interface HistoryDelta {
  format: typeof DELTA_FORMAT;
  formatVersion: number;
  baseVersion: number;
  targetVersion: number;
  baseDigest: string;
  targetDigest: string;
  baseBytes: number;
  targetBytes: number;
  /** Lines the older version has that the newer one does not, in insertion order. */
  lines: string[];
  ops: HistoryDeltaOp[];
}

type Block = { base: number; target: number; size: number };

/**
 * Matching blocks between the newer (base) lines and the older (target) lines, the
 * same shape difflib produces: increasing in both inputs and never overlapping, so
 * the gaps between them are exactly the lines the older version inserted.
 *
 * Lines that appear in more than one percent of a target of 200 lines or more are
 * treated as junk by the index, the way difflib's autojunk rule does. Repeated
 * blank lines therefore cannot make the search quadratic; they simply travel in the
 * inserted-line pool, which is still byte-exact and only slightly larger.
 */
function matchingBlocks(base: string[], target: string[]): Block[] {
  const index = new Map<string, number[]>();
  for (let j = 0; j < target.length; j++) {
    const positions = index.get(target[j]);
    if (positions) positions.push(j); else index.set(target[j], [j]);
  }
  if (target.length >= 200) {
    const popular = target.length / 100 + 1;
    for (const [line, positions] of index) if (positions.length > popular) index.delete(line);
  }
  const longest = (alo: number, ahi: number, blo: number, bhi: number): Block => {
    let bestBase = alo, bestTarget = blo, bestSize = 0;
    let previous = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const positions = index.get(base[i]);
      const current = new Map<number, number>();
      if (positions) for (const j of positions) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const size = (previous.get(j - 1) ?? 0) + 1;
        current.set(j, size);
        if (size > bestSize) { bestBase = i - size + 1; bestTarget = j - size + 1; bestSize = size; }
      }
      previous = current;
    }
    return { base: bestBase, target: bestTarget, size: bestSize };
  };
  const blocks: Block[] = [];
  const pending: Array<[number, number, number, number]> = [[0, base.length, 0, target.length]];
  while (pending.length) {
    const [alo, ahi, blo, bhi] = pending.pop()!;
    const block = longest(alo, ahi, blo, bhi);
    if (block.size === 0) continue;
    blocks.push(block);
    if (alo < block.base && blo < block.target) pending.push([alo, block.base, blo, block.target]);
    const baseEnd = block.base + block.size, targetEnd = block.target + block.size;
    if (baseEnd < ahi && targetEnd < bhi) pending.push([baseEnd, ahi, targetEnd, bhi]);
  }
  return blocks.sort((left, right) => left.base - right.base || left.target - right.target);
}

/** Encode `target` (the older body) as a reverse delta against `base` (the newer body). */
export function encodeHistoryDelta(base: string, target: string,
  versions: { baseVersion: number; targetVersion: number }, where: string): HistoryDelta {
  const baseLines = splitHistoryLines(base), targetLines = splitHistoryLines(target);
  const lines: string[] = [];
  const ops: HistoryDeltaOp[] = [];
  let cursor = 0;
  for (const block of matchingBlocks(baseLines, targetLines)) {
    if (block.target > cursor) {
      ops.push([1, lines.length, block.target - cursor]);
      lines.push(...targetLines.slice(cursor, block.target));
    }
    if (block.size) ops.push([0, block.base, block.size]);
    cursor = block.target + block.size;
  }
  if (cursor < targetLines.length) {
    ops.push([1, lines.length, targetLines.length - cursor]);
    lines.push(...targetLines.slice(cursor));
  }
  const delta: HistoryDelta = {
    format: DELTA_FORMAT, formatVersion: DELTA_FORMAT_VERSION,
    baseVersion: versions.baseVersion, targetVersion: versions.targetVersion,
    baseDigest: historyDigest(base), targetDigest: historyDigest(target),
    baseBytes: Buffer.byteLength(base), targetBytes: Buffer.byteLength(target), lines, ops,
  };
  // Never store a delta this build cannot rebuild: the encoder proves itself once.
  if (applyHistoryDelta(base, delta, where) !== target) refuse(where, "a reverse delta did not rebuild its own version; refusing to store it");
  return delta;
}

const DELTA_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Read a stored delta, refusing an unreadable, truncated or unsupported one by name. */
export function parseHistoryDelta(raw: string, where: string): HistoryDelta {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return refuse(where, "the stored reverse delta is not readable JSON; the stored history is truncated or corrupt"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return refuse(where, "the stored reverse delta is not a delta object; the stored history is corrupt");
  const delta = parsed as Partial<HistoryDelta>;
  if (delta.format !== DELTA_FORMAT)
    return refuse(where, `unsupported reverse delta format ${JSON.stringify(delta.format)}; this build cannot rebuild the version`);
  if (delta.formatVersion !== DELTA_FORMAT_VERSION)
    return refuse(where, `unsupported reverse delta format version ${JSON.stringify(delta.formatVersion)}; this build cannot rebuild the version`);
  for (const field of ["baseDigest", "targetDigest"] as const)
    if (typeof delta[field] !== "string" || !DELTA_DIGEST.test(delta[field]!))
      return refuse(where, `the stored reverse delta has no valid ${field}; the stored history is corrupt`);
  for (const field of ["baseVersion", "targetVersion", "baseBytes", "targetBytes"] as const)
    if (!Number.isInteger(delta[field]) || (delta[field] as number) < 0)
      return refuse(where, `the stored reverse delta has no valid ${field}; the stored history is corrupt`);
  if (!Array.isArray(delta.lines) || delta.lines.some(line => typeof line !== "string"))
    return refuse(where, "the stored reverse delta has no valid inserted lines; the stored history is corrupt");
  if (!Array.isArray(delta.ops))
    return refuse(where, "the stored reverse delta has no valid operations; the stored history is corrupt");
  return delta as HistoryDelta;
}

/** Rebuild the older body from the newer one and the stored reverse delta. */
export function applyHistoryDelta(base: string, delta: HistoryDelta, where: string): string {
  if (delta.format !== DELTA_FORMAT) return refuse(where, `unsupported reverse delta format ${JSON.stringify(delta.format)}`);
  if (delta.formatVersion !== DELTA_FORMAT_VERSION)
    return refuse(where, `unsupported reverse delta format version ${JSON.stringify(delta.formatVersion)}`);
  if (historyDigest(base) !== delta.baseDigest)
    return refuse(where, `base version ${delta.baseVersion} does not match the delta's recorded base digest; a stored snapshot is corrupt`);
  const baseLines = splitHistoryLines(base);
  const out: string[] = [];
  let copiedTo = 0;
  for (const op of delta.ops) {
    if (!Array.isArray(op) || op.length !== 3 || (op[0] !== 0 && op[0] !== 1)
      || !Number.isInteger(op[1]) || !Number.isInteger(op[2]) || op[1] < 0 || op[2] < 0)
      return refuse(where, "the stored reverse delta has a malformed operation; the stored history is corrupt");
    const [, start, count] = op;
    if (op[0] === 0) {
      if (start < copiedTo || start + count > baseLines.length)
        return refuse(where, "the stored reverse delta copies outside its base version; the stored history is corrupt");
      copiedTo = start + count;
      out.push(...baseLines.slice(start, start + count));
    } else {
      if (start + count > delta.lines.length)
        return refuse(where, "the stored reverse delta inserts lines it does not store; the stored history is truncated");
      out.push(...delta.lines.slice(start, start + count));
    }
  }
  const body = out.join("");
  if (historyDigest(body) !== delta.targetDigest)
    return refuse(where, `version ${delta.targetVersion} rebuilt bytes do not match the delta's recorded digest; the stored history is corrupt`);
  return body;
}

// ---------- Stored histories ----------

export interface StoredHistoryVersion {
  version: number;
  /** The stored JSON without its text field for a reverse delta, complete for a full snapshot. */
  data: Record<string, unknown>;
  /** The full text, present only for a full or snapshot version. */
  body?: string;
  delta?: string;
  bodyDigest?: string;
  baseVersion?: number;
}

/** The bounded reconstruction cache: rebuilds stay cheap without hiding a digest check. */
export class HistoryBodyCache {
  private readonly entries = new Map<string, string>();
  private bytes = 0;
  constructor(private readonly maxEntries = 64, private readonly maxBytes = 8 * 1024 * 1024) {}
  get(key: string): string | undefined {
    const found = this.entries.get(key);
    if (found === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, found);
    return found;
  }
  set(key: string, body: string): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) { this.entries.delete(key); this.bytes -= existing.length; }
    this.entries.set(key, body);
    this.bytes += body.length;
    for (const [oldKey, oldBody] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.entries.delete(oldKey);
      this.bytes -= oldBody.length;
    }
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
  get size(): number { return this.entries.size; }
  get storedBytes(): number { return this.bytes; }
}

/** Every stored version of one record, oldest first, from the full and delta tables. */
export function readStoredHistory(db: DatabaseSync, kind: PlanningHistoryKind, id: string): StoredHistoryVersion[] {
  const tables = HISTORY_TABLES[kind];
  const full = (db.prepare(`SELECT version,data FROM ${tables.full} WHERE ${tables.key}=? ORDER BY version`).all(id) as Array<{ version: number; data: string }>)
    .map(row => {
      const data = JSON.parse(String(row.data)) as Record<string, unknown>;
      const { [tables.bodyField]: body, ...rest } = data;
      return typeof body === "string" ? { version: Number(row.version), data: rest, body } : { version: Number(row.version), data: rest };
    });
  const deltas = (db.prepare(`SELECT version,baseVersion,bodyDigest,data,delta FROM ${tables.delta} WHERE ${tables.key}=? ORDER BY version`).all(id) as
    Array<{ version: number; baseVersion: number; bodyDigest: string; data: string; delta: string }>)
    .map(row => ({ version: Number(row.version), baseVersion: Number(row.baseVersion), bodyDigest: String(row.bodyDigest),
      data: JSON.parse(String(row.data)) as Record<string, unknown>, delta: String(row.delta) }));
  return [...full, ...deltas].sort((left, right) => left.version - right.version);
}

/** Every stored history of one kind, in two reads, for a whole-store export. */
export function readAllStoredHistories(db: DatabaseSync, kind: PlanningHistoryKind): Map<string, PlanningHistory> {
  const tables = HISTORY_TABLES[kind];
  const grouped = new Map<string, StoredHistoryVersion[]>();
  const add = (id: string, version: StoredHistoryVersion) => {
    const list = grouped.get(id);
    if (list) list.push(version); else grouped.set(id, [version]);
  };
  for (const row of db.prepare(`SELECT ${tables.key} AS id,version,data FROM ${tables.full} ORDER BY ${tables.key},version`).all() as
    Array<{ id: string; version: number; data: string }>) {
    const data = JSON.parse(String(row.data)) as Record<string, unknown>;
    const { [tables.bodyField]: body, ...rest } = data;
    add(String(row.id), typeof body === "string" ? { version: Number(row.version), data: rest, body } : { version: Number(row.version), data: rest });
  }
  for (const row of db.prepare(`SELECT ${tables.key} AS id,version,baseVersion,bodyDigest,data,delta FROM ${tables.delta} ORDER BY ${tables.key},version`).all() as
    Array<{ id: string; version: number; baseVersion: number; bodyDigest: string; data: string; delta: string }>) {
    add(String(row.id), { version: Number(row.version), baseVersion: Number(row.baseVersion), bodyDigest: String(row.bodyDigest),
      data: JSON.parse(String(row.data)) as Record<string, unknown>, delta: String(row.delta) });
  }
  return new Map([...grouped].map(([id, rows]) => [id, new PlanningHistory(rows.sort((left, right) => left.version - right.version), id)]));
}

/** One record's version history: which version is full, and how a delta one rebuilds. */
export class PlanningHistory {
  private readonly byVersion: Map<number, StoredHistoryVersion>;
  constructor(readonly rows: StoredHistoryVersion[], readonly where: string) {
    this.byVersion = new Map(rows.map(row => [row.version, row]));
  }
  get latest(): number { return this.rows.at(-1)?.version ?? 0; }
  row(version: number): StoredHistoryVersion | null { return this.byVersion.get(version) ?? null; }
  /**
   * The exact bytes of one version. A full row is returned as stored; a reverse delta
   * is rebuilt from the nearest snapshot and its stored digest is checked on every
   * rebuild and again on every cache hit.
   */
  body(version: number, cache?: HistoryBodyCache): string {
    const row = this.byVersion.get(version);
    if (!row) return refuse(this.where, `version ${version} is not stored`);
    if (row.body !== undefined) return row.body;
    const key = `${this.where}\0${version}\0${this.latest}`;
    const cached = cache?.get(key);
    if (cached !== undefined) { this.verify(version, cached); return cached; }
    const body = this.rebuild(version);
    this.verify(version, body);
    cache?.set(key, body);
    return body;
  }
  /**
   * Every version's exact bytes, rebuilt in one downward pass: one delta application per
   * stored delta, each with the digest check a single-version rebuild makes. A whole-store
   * export uses this so a 541-version history costs one pass, not one walk per version.
   */
  allBodies(): Map<number, string> {
    const bodies = new Map<number, string>();
    for (const row of this.rows) if (row.body !== undefined) bodies.set(row.version, row.body);
    for (let index = this.rows.length - 1; index >= 0; index--) {
      const row = this.rows[index];
      if (bodies.has(row.version)) continue;
      if (row.delta === undefined) return refuse(this.where, `version ${row.version} is stored without its text or a reverse delta`);
      if (row.baseVersion !== row.version + 1)
        return refuse(this.where, `version ${row.version} is a reverse delta against ${row.baseVersion}; version ${row.version + 1} is its only base`);
      const newer = bodies.get(row.version + 1);
      if (newer === undefined) return refuse(this.where, `version ${row.version} is missing its base version ${row.version + 1}`);
      const where = `${this.where} version ${row.version}`;
      const body = applyHistoryDelta(newer, parseHistoryDelta(row.delta, where), where);
      this.verify(row.version, body);
      bodies.set(row.version, body);
    }
    return bodies;
  }
  private rebuild(version: number): string {
    let base = this.byVersion.get(version)!;
    let steps = 0;
    while (base.delta !== undefined) {
      if (base.baseVersion !== base.version + 1)
        return refuse(this.where, `version ${base.version} is a reverse delta against ${base.baseVersion}; version ${base.version + 1} is its only base`);
      if (++steps > MAX_DELTA_CHAIN)
        return refuse(this.where, `version ${version} needs more than ${MAX_DELTA_CHAIN} reverse deltas; its snapshot base is missing`);
      const next = this.byVersion.get(base.version + 1);
      if (!next) return refuse(this.where, `version ${version} is missing its base version ${base.version + 1}`);
      base = next;
    }
    let body = base.body!;
    for (let step = base.version - 1; step >= version; step--) {
      const deltaRow = this.byVersion.get(step);
      if (deltaRow?.delta === undefined) return refuse(this.where, `version ${step} is missing its reverse delta`);
      const where = `${this.where} version ${step}`;
      body = applyHistoryDelta(body, parseHistoryDelta(deltaRow.delta, where), where);
    }
    return body;
  }
  private verify(version: number, body: string): void {
    const row = this.byVersion.get(version)!;
    const computed = historyDigest(body);
    if (row.bodyDigest !== undefined && row.bodyDigest !== computed)
      return refuse(this.where, `version ${version} rebuilt bytes do not match the stored digest; the stored history is corrupt`);
    const recorded = row.data.digest;
    if (typeof recorded === "string" && recorded.startsWith("sha256:") && recorded !== computed)
      return refuse(this.where, `version ${version} rebuilt bytes do not match its recorded digest; the stored history is corrupt`);
  }
}

// ---------- Writes ----------

export interface HistoryVersionInput {
  version: number;
  /** The exact text; a caller passes the complete stored record for `data`. */
  body: string;
  data: Record<string, unknown>;
}

function metadataOf(kind: PlanningHistoryKind, data: Record<string, unknown>): Record<string, unknown> {
  const { [HISTORY_TABLES[kind].bodyField]: _body, ...metadata } = data;
  return metadata;
}

/**
 * Write one record's whole history: descending, so each older version has the newer
 * body it differs from. A version is stored in full when it is the latest or a
 * snapshot point, and otherwise as a reverse delta against the version above it.
 */
export function writeStoredHistory(db: DatabaseSync, kind: PlanningHistoryKind, id: string, versions: HistoryVersionInput[]): void {
  const tables = HISTORY_TABLES[kind];
  const sorted = [...versions].sort((left, right) => right.version - left.version);
  const latest = sorted[0]?.version ?? 0;
  deleteStoredHistory(db, kind, id);
  const insertFull = db.prepare(`INSERT INTO ${tables.full}(${tables.key},version,data) VALUES(?,?,?)`);
  const insertDelta = db.prepare(`INSERT INTO ${tables.delta}(${tables.key},version,baseVersion,bodyDigest,data,delta) VALUES(?,?,?,?,?,?)`);
  for (const item of sorted) {
    const newer = sorted.find(candidate => candidate.version === item.version + 1);
    if (newer && !isSnapshotVersion(item.version, latest)) {
      insertDelta.run(id, item.version, item.version + 1, historyDigest(item.body), JSON.stringify(metadataOf(kind, item.data)),
        JSON.stringify(encodeHistoryDelta(newer.body, item.body, { baseVersion: item.version + 1, targetVersion: item.version },
          `${tables.full} ${id} version ${item.version}`)));
    } else {
      insertFull.run(id, item.version, JSON.stringify({ ...metadataOf(kind, item.data), [tables.bodyField]: item.body }));
    }
  }
}

/** Append one full version and, unless it is a snapshot point, demote the version it supersedes. */
export function appendStoredHistoryVersion(db: DatabaseSync, kind: PlanningHistoryKind, id: string,
  previous: { version: number; body: string; data: Record<string, unknown> } | null,
  next: HistoryVersionInput, latest: number): void {
  const tables = HISTORY_TABLES[kind];
  // A delta is only ever against the immediately next version; a history that skips a
  // version number keeps the older row in full so it still reads.
  if (previous && previous.version === next.version - 1 && !isSnapshotVersion(previous.version, latest)) {
    const where = `${tables.full} ${id} version ${previous.version}`;
    db.prepare(`INSERT INTO ${tables.delta}(${tables.key},version,baseVersion,bodyDigest,data,delta) VALUES(?,?,?,?,?,?)`)
      .run(id, previous.version, previous.version + 1, historyDigest(previous.body), JSON.stringify(metadataOf(kind, previous.data)),
        JSON.stringify(encodeHistoryDelta(next.body, previous.body, { baseVersion: previous.version + 1, targetVersion: previous.version }, where)));
    db.prepare(`DELETE FROM ${tables.full} WHERE ${tables.key}=? AND version=?`).run(id, previous.version);
  }
  db.prepare(`INSERT INTO ${tables.full}(${tables.key},version,data) VALUES(?,?,?)`)
    .run(id, next.version, JSON.stringify({ ...metadataOf(kind, next.data), [tables.bodyField]: next.body }));
}

export function deleteStoredHistory(db: DatabaseSync, kind: PlanningHistoryKind, id: string): void {
  const tables = HISTORY_TABLES[kind];
  db.prepare(`DELETE FROM ${tables.full} WHERE ${tables.key}=?`).run(id);
  db.prepare(`DELETE FROM ${tables.delta} WHERE ${tables.key}=?`).run(id);
}

/** Update one stored version's record without touching its text, in either table. */
export function updateStoredHistoryMetadata(db: DatabaseSync, kind: PlanningHistoryKind, id: string, version: number,
  patch: Record<string, unknown>): boolean {
  const tables = HISTORY_TABLES[kind];
  const full = db.prepare(`SELECT data FROM ${tables.full} WHERE ${tables.key}=? AND version=?`).get(id, version) as { data: string } | undefined;
  if (full) {
    db.prepare(`UPDATE ${tables.full} SET data=? WHERE ${tables.key}=? AND version=?`)
      .run(JSON.stringify({ ...JSON.parse(String(full.data)) as Record<string, unknown>, ...patch }), id, version);
    return true;
  }
  const delta = db.prepare(`SELECT data FROM ${tables.delta} WHERE ${tables.key}=? AND version=?`).get(id, version) as { data: string } | undefined;
  if (!delta) return false;
  db.prepare(`UPDATE ${tables.delta} SET data=? WHERE ${tables.key}=? AND version=?`)
    .run(JSON.stringify({ ...JSON.parse(String(delta.data)) as Record<string, unknown>, ...patch }), id, version);
  return true;
}
