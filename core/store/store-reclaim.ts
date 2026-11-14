import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { digest, StoreCore } from "./store-core";

/** Auto-vacuum modes as `PRAGMA auto_vacuum` reports them. */
export const AUTO_VACUUM_NONE = 0, AUTO_VACUUM_INCREMENTAL = 2;

/** The durable one-shot compaction record and the last bounded reclamation record (Queue-internal meta). */
export const STORE_COMPACTION_META_KEY = "storeCompaction";

export const STORE_MAINTENANCE_META_KEY = "storeMaintenance";

/** The last page release that failed, with its time and reason (task 987). */
export const STORE_MAINTENANCE_ERROR_META_KEY = "storeMaintenanceError";

/**
 * A freed-page pass releases at most this many pages, in chunks, inside this time budget.
 *
 * Task 987: a chunk is one short write transaction, so it holds the writer for a fraction of the
 * time a whole pass does. At 250 ms a pass stopped after two 512-page chunks (about 8 MB), so the
 * freelist left by a prune drained over a dozen hourly ticks; 1 s clears up to 16 MB a tick.
 */
export const RECLAIM_MAX_PAGES = 4096, RECLAIM_CHUNK_PAGES = 256, RECLAIM_BUDGET_MS = 1000;

/**
 * Lean store 4 (task 989): the release drain for a large freelist. While free pages exceed the
 * threshold, every maintenance tick (the 20 s engine sweep) runs one bounded pass, so a freelist
 * the size of a prune's backlog drains in minutes instead of the days the hourly-only passes
 * took (about 6 pages a minute after task 987 rolled). Below the threshold only the passes
 * after the hourly and daily prunes release, so an idle store is not touched every sweep.
 * Sized from a measured live-equivalent copy: a 256-page chunk takes about 40–90 ms, so a 2 s
 * budget clears several thousand pages a tick and 30k pages in well under an hour.
 */
export const RECLAIM_DRAIN_FREE_PAGES = 4096, RECLAIM_DRAIN_MAX_PAGES = 8192, RECLAIM_DRAIN_BUDGET_MS = 2000;

/** The store's own file and page facts: what compaction decisions and records are made from. */
export interface StoreFacts {
  fileBytes: number; walBytes: number; pageSize: number; pageCount: number; freePages: number; autoVacuum: number;
}

/** One table's contribution to `Store.contentFingerprint()`: logical rows, exact stored bytes and an order-independent row digest. */
interface ContentTableDigest { table: string; rows: number; bytes: number; sum: string; xor: string; digest: string }

/** The whole store's canonical content digest (Spec 028 revision "truthful preservation"). */
export interface ContentFingerprint { digest: string; rows: number; bytes: number; tables: number; ms: number }

/** The 64-bit accumulation mask used to combine row hashes order-independently. */
const MASK64 = (BigInt(1) << BigInt(64)) - BigInt(1);

/** One bounded freed-page reclamation pass (Spec 028: free pages after the prune passes). */
export interface ReclaimResult {
  pages: number; freePagesBefore: number; freePagesAfter: number;
  fileBytesBefore: number; fileBytesAfter: number; durationMs: number;
  /** Why this pass did nothing, or null when it reclaimed (or found nothing to reclaim). */
  skipped: string | null; error: string | null;
}

/**
 * A stored value's exact bytes with a type tag and its length, so two values of different type
 * or different length can never encode alike, and a same-length edit always differs. Text is
 * hashed as its UTF-8 bytes (what SQLite stores and returns), a blob as its bytes, an integer
 * or real as its exact SQLite text form, and NULL as its own tag.
 *
 * This is the store's one notion of a value's canonical bytes: the content fingerprint and the
 * migration snapshot comparison both read values through it.
 */
export function encodeStoredValue(value: unknown): Buffer {
  if (value === null || value === undefined) return Buffer.from("n", "latin1");
  if (typeof value === "string") { const body = Buffer.from(value, "utf8"); return Buffer.concat([Buffer.from(`s${body.length}:`, "latin1"), body]); }
  if (typeof value === "number" || typeof value === "bigint") { const text = String(value); return Buffer.from(`i${text.length}:${text}`, "latin1"); }
  if (value instanceof Uint8Array) { const body = Buffer.from(value); return Buffer.concat([Buffer.from(`b${body.length}:`, "latin1"), body]); }
  const text = String(value); return Buffer.from(`u${text.length}:${text}`, "latin1");
}

/**
 * One table's canonical content digest: every column value of every row, hashed from its exact
 * stored bytes, combined as count + 64-bit sum + 64-bit xor so row order and rowid are not part
 * of the answer but multiplicity, content and stored width are.
 */
function contentTableDigest(db: DatabaseSync, table: string): ContentTableDigest {
  const names = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(column => String(column.name));
  const statement = db.prepare(`SELECT ${names.length ? names.map(name => `"${name}"`).join(",") : "1 AS empty"} FROM "${table}"`);
  let rows = 0, bytes = 0, sum = BigInt(0), xor = BigInt(0);
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    const hash = createHash("sha256");
    for (const name of names) {
      const encoded = encodeStoredValue(row[name]);
      hash.update(encoded); bytes += encoded.length;
    }
    const value = hash.digest().readBigUInt64BE(0);
    sum = (sum + value) & MASK64; xor ^= value; rows++;
  }
  return { table, rows, bytes, sum: sum.toString(16), xor: xor.toString(16),
    digest: digest(JSON.stringify([table, rows, sum.toString(16), xor.toString(16)])) };
}

/**
 * The store's file and page facts, the canonical content digest, and the bounded freed-page
 * reclamation. One owner for "what the file physically is": compaction decisions and their
 * records read here, and no other module issues a vacuum or a checkpoint.
 */
export class StoreReclaim {
  constructor(private readonly core: StoreCore, private readonly path: () => string) {}
  private get db() { return this.core.db; }

  /** The store's auto-vacuum mode as SQLite reports it (0 none, 2 incremental). */
  autoVacuumMode(): number {
    return Number((this.db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined)?.auto_vacuum ?? AUTO_VACUUM_NONE);
  }

  /** The store's file and page facts, from one stat and three cheap pragmas. */
  storeFacts(): StoreFacts {
    const size = (file: string) => { try { return statSync(file).size; } catch { return 0; } };
    const page = (name: string) => Number((this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined)?.[name] ?? 0);
    return {
      fileBytes: this.path() === ":memory:" ? 0 : size(this.path()),
      walBytes: this.path() === ":memory:" ? 0 : size(`${this.path()}-wal`),
      pageSize: page("page_size"), pageCount: page("page_count"), freePages: page("freelist_count"),
      autoVacuum: this.autoVacuumMode(),
    };
  }

  /**
   * Spec 028 revision "truthful preservation": the canonical content digest of the store's
   * authoritative logical rows and settings.
   *
   * Every column value of every row of every authoritative table is hashed from its exact
   * stored bytes, and one table's rows are combined order-independently, so a digest is a
   * function of the stored content alone: a rewrite that moves pages, changes rowids or
   * reorders rows leaves it identical, and a same-length edit inside a value changes it. The
   * per-table combination is a count plus the sum and xor of the row hashes (64-bit), so
   * duplicate rows still count and the read needs no sort, no temp file and bounded memory.
   *
   * Excluded, with the reason: SQLite's own `sqlite_*` bookkeeping (`sqlite_sequence` holds an
   * AUTOINCREMENT high-water mark derived from the rows, and the other `sqlite_*` names are
   * internal); FTS5's shadow tables (`<fts>_data`, `_idx`, `_content`, `_docsize`, `_config`),
   * whose page and segment layout is the index's representation of the text the virtual table
   * itself returns, so the virtual table's own logical rows are hashed instead; and this
   * module's own two maintenance records in `meta`, which change around the window by design.
   * Every other table, and every other `meta` row (pause, limits, pool, availability, usage,
   * retention marks, every Queue-internal fact), is hashed exactly.
   */
  contentFingerprint(): ContentFingerprint {
    const started = performance.now();
    const internal = new Set([STORE_COMPACTION_META_KEY, STORE_MAINTENANCE_META_KEY]);
    const tableRows = this.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    const virtualTables = tableRows.filter(row => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(row.sql ?? ""))).map(row => String(row.name));
    const shadow = new Set(virtualTables.flatMap(name => ["data", "idx", "content", "docsize", "config"].map(suffix => `${name}_${suffix}`)));
    const tables: ContentTableDigest[] = [];
    let rows = 0, bytes = 0;
    for (const { name } of tableRows) {
      // `meta` is hashed row by row below so this module's own two records can be left out.
      if (shadow.has(name) || name === "meta") continue;
      const digest = contentTableDigest(this.db, name);
      tables.push(digest);
      rows += digest.rows; bytes += digest.bytes;
    }
    // `meta` is hashed row by row rather than as a table so this module's own records can be
    // left out; every other key is a setting or a Queue-internal fact and is hashed exactly.
    const meta: Array<[string, string]> = [];
    for (const row of this.db.prepare("SELECT key,value FROM meta ORDER BY key").all() as Array<{ key: string; value: string }>) {
      const key = String(row.key);
      if (internal.has(key)) continue;
      const value = String(row.value);
      meta.push([key, digest(value)]);
      rows++; bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    }
    return { digest: digest(JSON.stringify({ schema: this.core.getMeta("schema") ?? null, tables, meta })), rows, bytes, tables: tables.length, ms: Math.round(performance.now() - started) };
  }

  /**
   * Spec 028: return freed pages after a prune pass, bounded rather than a full rewrite.
   *
   * Incremental auto-vacuum keeps deleted pages on the store's freelist; this asks SQLite to
   * release at most `maxPages` of them, in chunks, and stops after `budgetMs`, so an hourly or
   * daily prune pays one short write pass instead of an unbounded writer stall. `pages` is what
   * the file actually gave back (a truncation can take a few pages more than the chunk it was
   * asked for). The WAL is then checkpointed to `journal_size_limit`. A pass that finds nothing
   * to reclaim writes nothing, so an idle store is not rewritten every hour.
   */
  reclaimFreedPages(options: { maxPages?: number; budgetMs?: number } = {}): ReclaimResult {
    const started = performance.now();
    const before = this.storeFacts();
    const result: ReclaimResult = { pages: 0, freePagesBefore: before.freePages, freePagesAfter: before.freePages,
      fileBytesBefore: before.fileBytes, fileBytesAfter: before.fileBytes, durationMs: 0, skipped: null, error: null };
    const finish = () => { result.durationMs = Math.round(performance.now() - started); return result; };
    if (this.core.maintenanceOpen) { result.skipped = "a maintenance window is open"; return finish(); }
    if (before.autoVacuum !== AUTO_VACUUM_INCREMENTAL) { result.skipped = `the store is not in incremental auto-vacuum (mode ${before.autoVacuum})`; return finish(); }
    if (before.freePages === 0) { result.skipped = "no free pages"; return finish(); }
    const maxPages = Math.max(1, Math.trunc(options.maxPages ?? RECLAIM_MAX_PAGES));
    const budgetMs = Math.max(1, options.budgetMs ?? RECLAIM_BUDGET_MS);
    try {
      let remaining = Math.min(before.freePages, maxPages);
      for (let pass = 0; remaining > 0 && performance.now() - started < budgetMs && pass < maxPages; pass++) {
        const free = this.storeFacts().freePages;
        if (free === 0) break;
        const chunk = Math.min(remaining, RECLAIM_CHUNK_PAGES, free);
        this.core.transaction(() => this.db.exec(`PRAGMA incremental_vacuum(${chunk})`));
        remaining -= chunk;
        // A freelist whose pages cannot be released from the end stops the pass; the next
        // pass retries with the same bound instead of spinning here.
        if (this.storeFacts().freePages >= free) break;
      }
      // The WAL is bounded after the rewrite; a concurrent reader (a snapshot child) can
      // make the truncating checkpoint return busy, which leaves the file as it was.
      this.checkpointWal();
    } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
    const after = this.storeFacts();
    result.pages = Math.max(0, before.pageCount - after.pageCount);
    result.freePagesAfter = after.freePages;
    result.fileBytesAfter = after.fileBytes;
    // Task 987: a failed release is recorded, not only returned. The hourly and daily passes
    // ignore the result, so before this a refused pass left no trace on the live store.
    const durationMs = Math.round(performance.now() - started);
    if (result.pages > 0 && !result.error) {
      try { this.core.setMeta(STORE_MAINTENANCE_META_KEY, { at: new Date().toISOString(), pages: result.pages,
        freePagesBefore: result.freePagesBefore, freePagesAfter: result.freePagesAfter,
        fileBytesBefore: result.fileBytesBefore, fileBytesAfter: result.fileBytesAfter, durationMs }); }
      catch { /* the release still happened; the record is retried by the next pass */ }
    }
    if (result.error) { try { this.core.setMeta(STORE_MAINTENANCE_ERROR_META_KEY, { at: new Date().toISOString(), error: result.error }); } catch { /* the store refused the write too */ } }
    return finish();
  }

  /** One truncating WAL checkpoint; `busy` reports a reader that kept the WAL in place. */
  checkpointWal(): { busy: number; log: number; checkpointed: number } {
    const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number; log?: number; checkpointed?: number } | undefined;
    return { busy: Number(row?.busy ?? 0), log: Number(row?.log ?? 0), checkpointed: Number(row?.checkpointed ?? 0) };
  }
}
