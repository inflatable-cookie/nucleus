/**
 * Spec 056: one operator-invoked repository namespace re-key.
 *
 * The operation re-points every *current* record that names a repository from
 * one identity to another, in one transaction, and leaves every *historical*
 * fact (operation payloads and input hashes, hook events, contract-010 host-run
 * rows, retained shadow-journal history, receipts, legacy papercut rows, proof
 * executions and an outcome's permanent evidence) under the identity it was
 * written under.
 *
 * Two rules keep this from becoming a global text replacement:
 *
 * - Only fields whose meaning is "which repository is this record for now" are
 *   rewritten. Titles, bodies, brief text, review text, PR URLs, commits,
 *   digests and payload bytes are never touched, so their bytes stay identical.
 * - A record is matched by its own identity, never by prose. A record with a
 *   known origin matches only that exact origin; a path matches only a record
 *   with no origin (the same "path-only predecessor" rule `putRepository` uses),
 *   so one repository's re-key can never absorb another repository that shares
 *   a checkout path.
 *
 * The target must be free in every family, including numbering-only history
 * (purged tasks keep their `task_numbers` rows) and a conflicting path-known
 * repository. There is no occupied-target exception for a swap: a two-way swap
 * goes through a deliberately unused temporary namespace, one atomic step at a
 * time. Same origin with a different path is a path-only step, not occupancy of
 * a different repository: numbering stays, every path hint of this origin moves.
 *
 * Every family is described once by the catalogue below: how its rows are read,
 * which record names the source, which record already claims a target path, and
 * how a matched row moves. One read per family feeds the plan, the occupancy
 * checks and the apply, so no family's JSON shape is decoded twice.
 */
import type { DatabaseSync } from "node:sqlite";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import {
  REPOSITORY_REKEY_FAMILIES, REPOSITORY_REKEY_HISTORICAL, repositoryRekeyInputSchema, repositoryRekeyPreviewInputSchema, repositoryRekeyPreviewSchema,
  repositoryRekeyReceiptSchema, type RepositoryRekeyCounts, type RepositoryRekeyFamily, type RepositoryRekeyIdentity, type RepositoryRekeyInput,
  type RepositoryRekeyNumbering, type RepositoryRekeyPreview, type RepositoryRekeyPreviewInput, type RepositoryRekeyReceipt, type RepositoryRekeyRefusal,
  type RepositoryRekeyRefusalCode,
} from "../../shared/repository-rekey";

const emptyCounts = (): RepositoryRekeyCounts => Object.fromEntries(REPOSITORY_REKEY_FAMILIES.map(family => [family, 0]));
const sameCounts = (counts: RepositoryRekeyCounts) => Object.fromEntries(REPOSITORY_REKEY_FAMILIES.map(family => [family, counts[family] ?? 0]));

type Repo = { origin: string | null; path: string };
type Spellings = { origin: string | null; path: string | null };
type Json = Record<string, unknown>;
type RepoList = readonly Repo[];

const spellingsOf = (value: string): Spellings => {
  const origin = normalizeRepositoryOrigin(value);
  return origin ? { origin, path: null } : { origin: null, path: value.trim() || null };
};
const sameText = (value: unknown, spellings: Spellings): boolean => {
  if (typeof value !== "string" || !value) return false;
  const normalized = normalizeRepositoryOrigin(value);
  if (spellings.origin && normalized && normalized === spellings.origin) return true;
  return Boolean(spellings.path && value === spellings.path);
};
/** A stored `{origin, path}` names this identity only when its own identity says so. */
const sameRepo = (repo: Partial<Repo> | null | undefined, spellings: Spellings): boolean => {
  if (!repo) return false;
  if (repo.origin) return Boolean(spellings.origin && repo.origin === spellings.origin);
  return Boolean(spellings.path && repo.path === spellings.path);
};
/** A stored `{origin, path}` already carries `path` for a repository that is not the source. */
const repoClaimsPath = (repo: unknown, path: string, source: Spellings): boolean => {
  const value = repo as Partial<Repo> | null | undefined;
  return Boolean(value && value.path === path && !sameRepo(value, source));
};
/** The same path claim over a stored list of repository identities. */
const listClaimsPath = (list: unknown, path: string, source: Spellings): boolean =>
  Array.isArray(list) && (list as Repo[]).some(repo => repoClaimsPath(repo, path, source));

const targetText = (target: RepositoryRekeyIdentity) => target.origin ?? target.path;
const retarget = (repo: Partial<Repo>, target: RepositoryRekeyIdentity, pathChanged: boolean, from: Spellings): Repo => ({
  origin: target.origin,
  path: pathChanged && target.path && (!from.path || !repo.path || repo.path === from.path)
    ? target.path
    : (repo.path ?? ""),
});
const retargetRepo = (value: unknown, spellings: Spellings, target: RepositoryRekeyIdentity, pathChanged: boolean): boolean => {
  if (!value || typeof value !== "object") return false;
  const repo = value as Partial<Repo>;
  if (!sameRepo(repo, spellings)) return false;
  const next = retarget(repo, target, pathChanged, spellings);
  repo.origin = next.origin;
  repo.path = next.path;
  return true;
};
const retargetText = (holder: Json, key: string, spellings: Spellings, target: RepositoryRekeyIdentity): boolean => {
  if (!sameText(holder[key], spellings)) return false;
  holder[key] = targetText(target);
  return true;
};
/**
 * A path hint moves only when a target path was explicitly requested. Called on
 * already-matched records: an empty source path still rewrites the hint, so a
 * settings row with `path: ""` cannot silently skip tasks whose `repoPath` is
 * the live checkout. A record whose hint is a *different* known path is left
 * alone when this step named the old path.
 */
const retargetPath = (holder: Json, key: string, spellings: Spellings, target: RepositoryRekeyIdentity): boolean => {
  if (!target.path) return false;
  const current = holder[key];
  if (typeof current === "string" && current && spellings.path && current !== spellings.path && !sameText(current, spellings))
    return false;
  holder[key] = target.path;
  return true;
};

const rows = (db: DatabaseSync, sql: string, ...params: Array<string | null>) => db.prepare(sql).all(...params) as Json[];
const parseJson = (value: unknown): Json | null => {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : null;
  } catch { return null; }
};
const clone = (value: Json): Json => parseJson(JSON.stringify(value)) ?? {};

/** One stored row of a re-keyed family: the identity its write uses and its decoded record. */
interface FamilyRow {
  key: string;
  record: Json;
}

/** The identity every matched family moves to. */
interface FamilyMove {
  target: RepositoryRekeyIdentity;
  spellings: Spellings;
  /** True when the step also moves path hints. */
  pathChanged: boolean;
  /** True when the target identity differs from the source text. */
  originChanged: boolean;
}

/**
 * One re-keyed family, described once: its read, its identity rule, the path
 * claim that blocks an adoption, and how a matched row moves. A row whose data
 * does not decode is counted as unreadable and never matched.
 */
interface RekeyFamily {
  read(db: DatabaseSync): FamilyRead;
  /** The row's own current identity names this source. */
  names(row: FamilyRow, spellings: Spellings): boolean;
  /** The row already claims `path` for a repository other than the source. */
  claimsPath?(row: FamilyRow, path: string, source: Spellings): boolean;
  move(db: DatabaseSync, matched: readonly FamilyRow[], move: FamilyMove): void;
}

interface FamilyRead {
  rows: FamilyRow[];
  unreadable: number;
}

/** Stored JSON rows, keyed by one identity column, decoded once. */
function jsonRows(db: DatabaseSync, sql: string): FamilyRead {
  const read: FamilyRead = { rows: [], unreadable: 0 };
  for (const row of rows(db, sql)) {
    const record = parseJson(row.data), key = typeof row.key === "string" ? row.key : null;
    if (!record || !key) { read.unreadable++; continue; }
    read.rows.push({ key, record });
  }
  return read;
}

/** Plain column rows; the named columns are the record. */
function columnRows(db: DatabaseSync, sql: string): FamilyRead {
  const read: FamilyRead = { rows: [], unreadable: 0 };
  for (const row of rows(db, sql)) {
    if (typeof row.key !== "string" || !row.key) { read.unreadable++; continue; }
    read.rows.push({ key: row.key, record: row });
  }
  return read;
}

const writeJson = (db: DatabaseSync, sql: string, record: Json, ...params: string[]) =>
  db.prepare(sql).run(JSON.stringify(record), ...params);

/** A task names the source when its own repository identity says so; a path-only task joins by path. */
function matchesTask(task: Json, spellings: Spellings): boolean {
  if (sameText(task.repository, spellings)) return true;
  return !task.repository && sameText(task.repoPath, spellings);
}

/** The same origin-first rule for a milestone QA run; only a path-only run joins by path or key. */
function matchesQaRun(run: Json, spellings: Spellings): boolean {
  const repo = run.repository as Repo | undefined;
  if (sameRepo(repo, spellings)) return true;
  return !repo?.origin && sameText(run.key, spellings);
}

const FAMILIES = {
  repositorySettings: {
    read: db => jsonRows(db, "SELECT key,data FROM repository_settings ORDER BY rowid"),
    names: (row, spellings) => row.key === (spellings.origin ?? spellings.path) || sameRepo(row.record.repository as Repo, spellings),
    claimsPath: (row, path, source) => repoClaimsPath(row.record.repository, path, source),
    move: (db, matched, move) => {
      for (const row of matched) {
        const { repository, ...rest } = row.record;
        db.prepare("DELETE FROM repository_settings WHERE key=?").run(row.key);
        db.prepare("INSERT INTO repository_settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
          .run(targetText(move.target), JSON.stringify({ ...rest, repository: retarget(repository as Repo, move.target, move.pathChanged, move.spellings) }));
      }
    },
  },
  taskNumberCounters: {
    read: db => columnRows(db, "SELECT repository AS key,next_number FROM task_number_counters"),
    names: (row, spellings) => sameText(row.key, spellings),
    claimsPath: (row, path) => row.key === path,
    // Numbering stays per repository: counters and assignments follow an origin
    // change. A path-only step leaves the numbering rows as they are.
    move: (db, matched, move) => {
      if (!move.originChanged || !matched.length) return;
      const next = Math.max(...matched.map(row => Number(row.record.next_number)));
      for (const row of matched) db.prepare("DELETE FROM task_number_counters WHERE repository=?").run(row.key);
      db.prepare("INSERT INTO task_number_counters(repository,next_number) VALUES(?,?) ON CONFLICT(repository) DO UPDATE SET next_number=excluded.next_number")
        .run(targetText(move.target), next);
    },
  },
  taskNumbers: {
    read: db => columnRows(db, "SELECT task_id AS key,repository,number FROM task_numbers"),
    names: (row, spellings) => sameText(row.record.repository, spellings),
    claimsPath: (row, path) => row.record.repository === path,
    move: (db, matched, move) => {
      if (!move.originChanged) return;
      for (const row of matched) db.prepare("UPDATE task_numbers SET repository=? WHERE task_id=?").run(targetText(move.target), row.key);
    },
  },
  tasks: {
    read: db => jsonRows(db, "SELECT id AS key,data FROM tasks"),
    names: (row, spellings) => matchesTask(row.record, spellings),
    claimsPath: (row, path, source) => row.record.repoPath === path && !sameText(row.record.repository, source),
    // Identity fields only. Brief text, reviews, evidence and PR facts are side
    // storage or untouched payload, so their bytes do not change.
    move: (db, matched, move) => {
      for (const row of matched) {
        const mutation = clone(row.record);
        const matchedByPath = !sameText(mutation.repository, move.spellings) && sameText(mutation.repoPath, move.spellings);
        retargetText(mutation, "repository", move.spellings, move.target);
        // A path-only task whose repository gains an origin takes it, so its numbering
        // and every later lookup resolve the origin rather than the old path.
        if (matchedByPath && !mutation.repository) mutation.repository = targetText(move.target);
        if (move.pathChanged) retargetPath(mutation, "repoPath", move.spellings, move.target);
        const reviewEntry = mutation.reviewEntry as Json | null;
        if (reviewEntry) retargetText(reviewEntry, "repository", move.spellings, move.target);
        for (const pin of (mutation.siblingPins as Json[] | undefined) ?? []) retargetText(pin, "repository", move.spellings, move.target);
        for (const finding of (mutation.siblingFindings as Json[] | undefined) ?? []) retargetText(finding, "repository", move.spellings, move.target);
        writeJson(db, "UPDATE tasks SET data=? WHERE id=?", mutation, row.key);
      }
    },
  },
  outcomes: {
    read: db => jsonRows(db, "SELECT taskId AS key,data FROM outcomes"),
    names: (row, spellings) => sameRepo(row.record.repository as Repo, spellings),
    claimsPath: (row, path, source) => repoClaimsPath(row.record.repository, path, source),
    // The searchable repository identity and sibling pins; every proof field
    // (PR URL, commits, brief, review, validation) stays exactly as written.
    move: (db, matched, move) => {
      for (const row of matched) {
        const mutation = clone(row.record);
        const repo = mutation.repository as Repo | undefined;
        if (repo) {
          mutation.repository = retarget(repo, move.target, move.pathChanged, move.spellings);
          db.prepare("UPDATE outcomes SET repository=? WHERE taskId=?").run(targetText(move.target), row.key);
        }
        for (const sibling of (mutation.siblings as Json[] | undefined) ?? []) retargetText(sibling, "repository", move.spellings, move.target);
        writeJson(db, "UPDATE outcomes SET data=? WHERE taskId=?", mutation, row.key);
      }
    },
  },
  leads: {
    read: db => jsonRows(db, "SELECT id AS key,data FROM leads"),
    names: (row, spellings) => ((row.record.repositories as RepoList | undefined) ?? []).some(repo => sameRepo(repo, spellings))
      || ((row.record.targets as Json[] | undefined) ?? []).some(target => sameText(target.repository, spellings)),
    claimsPath: (row, path, source) => listClaimsPath(row.record.repositories, path, source),
    move: (db, matched, move) => {
      for (const row of matched) {
        const mutation = clone(row.record);
        for (const repo of (mutation.repositories as Repo[] | undefined) ?? []) retargetRepo(repo, move.spellings, move.target, move.pathChanged);
        for (const target of (mutation.targets as Json[] | undefined) ?? []) retargetText(target, "repository", move.spellings, move.target);
        writeJson(db, "UPDATE leads SET data=? WHERE id=?", mutation, row.key);
      }
    },
  },
  lanes: {
    read: db => jsonRows(db, "SELECT key,data FROM lanes"),
    names: (row, spellings) => ((row.record.repositories as RepoList | undefined) ?? []).some(repo => sameRepo(repo, spellings)),
    claimsPath: (row, path, source) => listClaimsPath(row.record.repositories, path, source),
    move: (db, matched, move) => {
      for (const row of matched) {
        const mutation = clone(row.record);
        for (const repo of (mutation.repositories as Repo[] | undefined) ?? []) retargetRepo(repo, move.spellings, move.target, move.pathChanged);
        writeJson(db, "UPDATE lanes SET data=? WHERE key=?", mutation, row.key);
      }
    },
  },
  decisions: {
    read: db => jsonRows(db, "SELECT id AS key,data FROM decisions"),
    names: (row, spellings) => sameRepo(((row.record.askedBy as Json | undefined)?.project) as Repo, spellings),
    claimsPath: (row, path, source) => repoClaimsPath((row.record.askedBy as Json | undefined)?.project, path, source),
    move: (db, matched, move) => {
      for (const row of matched) {
        const mutation = clone(row.record);
        const askedBy = mutation.askedBy as Json | undefined;
        if (askedBy) retargetRepo(askedBy.project, move.spellings, move.target, move.pathChanged);
        writeJson(db, "UPDATE decisions SET data=? WHERE id=?", mutation, row.key);
      }
    },
  },
  projects: {
    read: db => jsonRows(db, "SELECT key,data FROM projects"),
    names: (row, spellings) => ((row.record.repositories as RepoList | undefined) ?? []).some(repo => sameRepo(repo, spellings))
      || sameRepo(row.record.primary as Repo, spellings),
    claimsPath: (row, path, source) => listClaimsPath(row.record.repositories, path, source)
      || repoClaimsPath(row.record.primary, path, source),
    // Project identity itself (key, name, version, owner, plan) is stable: only
    // the repository members and the primary pointer move.
    move: (db, matched, move) => {
      for (const row of matched) {
        const mutation = clone(row.record);
        for (const repo of (mutation.repositories as Repo[] | undefined) ?? []) retargetRepo(repo, move.spellings, move.target, move.pathChanged);
        retargetRepo(mutation.primary, move.spellings, move.target, move.pathChanged);
        writeJson(db, "UPDATE projects SET data=? WHERE key=?", mutation, row.key);
      }
    },
  },
  projectTombstones: {
    read: db => jsonRows(db, "SELECT key,data FROM project_tombstones"),
    names: (row, spellings) => ((row.record.repositories as RepoList | undefined) ?? []).some(repo => sameRepo(repo, spellings)),
    claimsPath: (row, path, source) => listClaimsPath(row.record.repositories, path, source),
    move: (db, matched, move) => {
      for (const row of matched) {
        const mutation = clone(row.record);
        for (const repo of (mutation.repositories as Repo[] | undefined) ?? []) retargetRepo(repo, move.spellings, move.target, move.pathChanged);
        writeJson(db, "UPDATE project_tombstones SET data=? WHERE key=?", mutation, row.key);
      }
    },
  },
  projectQaRuns: {
    read: db => jsonRows(db, "SELECT id AS key,data FROM project_qa_runs"),
    // The scan may reach a run that shares a checkout path with another
    // repository, so the identity decision is the same origin-first rule as every
    // other family, never the path alone.
    names: (row, spellings) => matchesQaRun(row.record, spellings),
    claimsPath: (row, path, source) => repoClaimsPath(row.record.repository, path, source) || row.record.key === path,
    // Finished runs keep their argv, output, digests and times; only the
    // repository they belong to and its one-run key move. The host-run caller was
    // minted from the submitted key and contract-010 history is never rewritten
    // (task 445), so the row records that key as provenance in this same
    // transaction before its current key moves. A second re-key keeps the first.
    move: (db, matched, move) => {
      for (const row of matched) {
        const mutation = clone(row.record);
        const oldKey = String(row.record.key ?? "");
        retargetRepo(mutation.repository, move.spellings, move.target, move.pathChanged);
        if (sameText(mutation.key, move.spellings)) {
          if (!mutation.submittedKey && oldKey) mutation.submittedKey = oldKey;
          mutation.key = targetText(move.target);
        }
        db.prepare("UPDATE project_qa_runs SET repository=?,data=? WHERE id=?").run(targetText(move.target), JSON.stringify(mutation), row.key);
        db.prepare("UPDATE project_qa_latest SET key=? WHERE id=? AND key=?").run(targetText(move.target), row.key, oldKey);
      }
    },
  },
  qaScheduleMerges: {
    read: db => columnRows(db, "SELECT taskId AS key,repository FROM qa_schedule_merges"),
    names: (row, spellings) => sameText(row.record.repository, spellings),
    claimsPath: (row, path) => row.record.repository === path,
    move: (db, matched, move) => {
      for (const row of matched) db.prepare("UPDATE qa_schedule_merges SET repository=? WHERE taskId=?").run(targetText(move.target), row.key);
    },
  },
} satisfies Record<RepositoryRekeyFamily, RekeyFamily>;

interface Plan {
  source: RepositoryRekeyIdentity;
  target: RepositoryRekeyIdentity;
  pathChanged: boolean;
  originChanged: boolean;
  expectedSourceRevision: number | null;
  refusals: RepositoryRekeyRefusal[];
  counts: RepositoryRekeyCounts;
  numbering: RepositoryRekeyNumbering;
  projectKeys: string[];
  laneKeys: string[];
  /** Each family's rows, read once, and those rows that name the source. */
  families: Map<RepositoryRekeyFamily, FamilyRead & { matched: FamilyRow[] }>;
  spellings: Spellings;
}

/** One read of every family; the plan, its occupancy checks and the apply all use it. */
function readFamilies(db: DatabaseSync): Map<RepositoryRekeyFamily, FamilyRead> {
  return new Map(REPOSITORY_REKEY_FAMILIES.map(family => [family, FAMILIES[family].read(db)] as const));
}

/** The rows of each family that name one identity, from the plan's single read. */
function matchFamilies(read: Map<RepositoryRekeyFamily, FamilyRead>, spellings: Spellings) {
  return new Map(REPOSITORY_REKEY_FAMILIES.map(family => {
    const stored = read.get(family)!;
    return [family, { ...stored, matched: stored.rows.filter(row => FAMILIES[family].names(row, spellings)) }] as const;
  }));
}

/**
 * A refused re-key is definite: the transaction rolled back before any row or
 * receipt changed, so the durable operation settles failed, never uncertain.
 */
export class RepositoryRekeyRefused extends Error {
  constructor(readonly refusalCode: RepositoryRekeyRefusalCode, readonly refusals: RepositoryRekeyRefusal[], message: string) {
    super(message);
    this.name = "RepositoryRekeyRefused";
  }
}

class Refusals {
  private readonly list: RepositoryRekeyRefusal[] = [];
  add(code: RepositoryRekeyRefusalCode, explanation: string) { this.list.push({ code, explanation }); }
  value() { return this.list.slice(0, 32); }
}

/**
 * Read the current state and decide whether a fresh apply would be safe. The
 * apply re-runs this exact function inside its transaction, so a preview never
 * authorises a drifted input.
 */
function planRekey(db: DatabaseSync, raw: RepositoryRekeyPreviewInput): Plan {
  const input = repositoryRekeyPreviewInputSchema.parse(raw);
  const refusals = new Refusals();
  const read = readFamilies(db);
  const targetOrigin = normalizeRepositoryOrigin(input.target.origin);
  if (!targetOrigin) refusals.add("invalid_target", `Target origin ${JSON.stringify(input.target.origin)} is not a normalised owner/name repository origin`);
  const resolved = resolveSource(db, input.source);
  let source = resolved.identity;
  if (resolved.ambiguity.length)
    refusals.add("ambiguous_source", `The checkout path ${JSON.stringify(input.source)} is shared by ${resolved.ambiguity.join(" and ")}; name the origin to choose one repository`);
  const explicitPath = input.sourcePath?.trim() ?? "";
  if (explicitPath) {
    if (source.path && source.path !== explicitPath)
      refusals.add("ambiguous_source", `Source settings path ${JSON.stringify(source.path)} disagrees with sourcePath ${JSON.stringify(explicitPath)}; name one checkout`);
    source = { origin: source.origin, path: explicitPath };
  }
  const target: RepositoryRekeyIdentity = { origin: targetOrigin ?? input.target.origin.trim(), path: input.target.path?.trim() ?? "" };
  const counts = emptyCounts();

  let families = matchFamilies(read, source);
  if ((!source.origin && !source.path) || ![...families.values()].some(family => family.matched.length))
    refusals.add("unknown_source", `No Queue record names repository ${JSON.stringify(input.source)}; nothing to re-key`);

  if (!explicitPath && !source.path) {
    const hints = collectPathHints(families);
    if (hints.length === 1) {
      source = { origin: source.origin, path: hints[0] };
      families = matchFamilies(read, source);
    } else if (hints.length > 1 && target.path)
      refusals.add("ambiguous_source", `Source records name ${hints.length} checkout paths (${hints.slice(0, 5).join(", ")}); pass sourcePath to choose the path this step moves`);
  }

  const pathChanged = Boolean(target.path && target.path !== source.path);
  const originChanged = targetText(target) !== (source.origin ?? source.path);
  const sourceOriginChanged = Boolean(targetOrigin && (source.origin ? targetOrigin !== source.origin : true));
  if (targetOrigin && source.origin && targetOrigin === source.origin && !pathChanged)
    refusals.add("source_equals_target", `Source and target are the same repository origin ${targetOrigin}${source.path ? ` at ${source.path}` : ""}`);

  const settings = families.get("repositorySettings")!.matched[0];
  const expectedSourceRevision = settings ? Number(settings.record.revision ?? 0) : null;
  if (expectedSourceRevision !== input.expectedSourceRevision)
    refusals.add("source_revision_changed",
      `Observed source revision ${String(input.expectedSourceRevision)} no longer matches the stored revision ${String(expectedSourceRevision)}; read a fresh preview`);

  if (targetOrigin && sourceOriginChanged) {
    // Occupancy is current ownership. Settled contract-010 host-run rows keep the
    // identity they were written under by design, so they are evidence and never
    // occupy a name: otherwise the documented Full swap could never run past the
    // first step for any repository that ever ran QA. A path-only step keeps the
    // source origin, so that origin is not occupancy of a different repository.
    const occupied = occupiedFamilies(families, { origin: targetOrigin, path: null });
    if (occupied.length) refusals.add("target_occupied", `Target origin ${targetOrigin} is already named by ${occupied.join(", ")}`);
  }
  if (pathChanged && target.path) {
    const occupied = pathClaimants(families, target.path, source);
    if (occupied.length) refusals.add("path_occupied", `Target path ${target.path} is already used by another repository in ${occupied.join(", ")}`);
  }

  // Active writers: a re-key never strands or re-routes work that could still
  // write under the old routing namespace.
  const tasks = families.get("tasks")!.matched.filter(task => !task.record.removedAt && !["done", "cancelled"].includes(String(task.record.phase)));
  if (tasks.length) refusals.add("active_tasks",
    `${tasks.length} unfinished task${tasks.length === 1 ? "" : "s"} still name the source (${tasks.slice(0, 5).map(task => String(task.record.reference ?? task.key)).join(", ")}); finish or dispose of them first`);
  const unsettled = rows(db, "SELECT id,kind,state,json_extract(data,'$.repoPath') AS repoPath,payload FROM operations WHERE state IN ('pending','running','needs_attention')");
  const writers = unsettled.filter(operation => {
    const payload = parseJson(operation.payload);
    const submission = payload?.submission ? payload.submission as Json : payload?.input ? (payload.input as Json).submission as Json | undefined : undefined;
    return sameText(operation.repoPath, source) || sameText(payload?.repository, source) || sameText(submission?.repoPath, source);
  });
  if (writers.length) refusals.add("active_operations",
    `${writers.length} unsettled Queue operation${writers.length === 1 ? "" : "s"} could still write under the source (${[...new Set(writers.map(operation => String(operation.kind)))].join(", ")})`);
  const activeTaskIds = new Set(families.get("tasks")!.matched.map(task => task.key));
  const unreleasedRuns = rows(db, `SELECT runs.taskId AS taskId FROM runs JOIN tasks ON tasks.id=runs.taskId
    WHERE COALESCE(json_extract(runs.data,'$.released'),0)=0 AND json_extract(tasks.data,'$.removedAt') IS NULL`);
  const runs = unreleasedRuns.filter(run => activeTaskIds.has(String(run.taskId)));
  if (runs.length) refusals.add("active_runs", `${runs.length} unreleased worker or reviewer run${runs.length === 1 ? "" : "s"} still belongs to the source`);
  const activeQa = rows(db, `SELECT id FROM project_qa_runs WHERE json_extract(data,'$.state') IN ('queued','running')
      AND (repository=? OR repository=?)`, source.origin, source.path);
  if (activeQa.length) refusals.add("active_qa", `${activeQa.length} milestone QA run${activeQa.length === 1 ? "" : "s"} is still queued or running for the source`);
  const pendingRequests = rows(db, `SELECT key,value FROM meta WHERE key GLOB 'projectQaRequest:*' AND json_valid(value)
      AND json_extract(value,'$.state')='preparing'`)
    .filter(row => sameText((parseJson(row.value)?.input as Json | undefined)?.repository, source));
  if (pendingRequests.length) refusals.add("active_qa", `${pendingRequests.length} unsettled QA request${pendingRequests.length === 1 ? "" : "s"} still names the source`);
  // Unsettled custody, not settled history, blocks the step: a queued, admitted or
  // running run, and a settled run that still holds capacity, are the rows the QA
  // inventory lists as unresolved.
  const activeHostRuns = rows(db, `SELECT id FROM host_run_records
    WHERE (state IN ('queued','admitted','running')
      OR (state='settled' AND json_extract(data,'$.capacityReleasedAt') IS NULL))
      AND (repository=? OR repository=?)`, source.origin, source.path);
  if (activeHostRuns.length) refusals.add("active_host_runs", `${activeHostRuns.length} host run${activeHostRuns.length === 1 ? "" : "s"} is still unsettled for the source`);
  // A row this step cannot decode is never silently skipped: the scan cannot
  // prove it read every current record, so no step is safe on that store.
  const unreadable = [...read.values()].reduce((total, family) => total + family.unreadable, 0);
  if (unreadable)
    refusals.add("concurrent_change", `${unreadable} stored record${unreadable === 1 ? "" : "s"} in a re-keyed family could not be decoded, so this step cannot prove every record it must move; repair the store and read a fresh preview`);

  for (const family of REPOSITORY_REKEY_FAMILIES) counts[family] = families.get(family)!.matched.length;
  const counters = families.get("taskNumberCounters")!.matched;
  const sourceNext = counters.length ? Math.max(...counters.map(counter => Number(counter.record.next_number))) : null;
  const numbering: RepositoryRekeyNumbering = {
    tasks: families.get("taskNumbers")!.matched.length,
    sourceNext,
    // Numbering continues from the same counter: it never restarts at 1.
    targetNext: sourceNext,
  };
  return {
    source, target, pathChanged, originChanged, expectedSourceRevision, refusals: refusals.value(), counts: sameCounts(counts), numbering,
    projectKeys: families.get("projects")!.matched.map(project => project.key),
    laneKeys: families.get("lanes")!.matched.map(lane => lane.key), families, spellings: source,
  };
}

/**
 * The source's whole identity: a settings row's origin and path when one exists.
 * A caller may name either the origin or the checkout path. A path shared by two
 * origin-known settings rows is ambiguous and is refused rather than resolved to
 * whichever row sorts first — that guess is exactly the history merge this
 * feature exists to prevent.
 */
function resolveSource(db: DatabaseSync, query: string): { identity: RepositoryRekeyIdentity; ambiguity: string[] } {
  const candidates = rows(db, "SELECT key,data FROM repository_settings ORDER BY rowid")
    .map(row => ({ key: String(row.key), data: parseJson(row.data) }))
    .filter((row): row is { key: string; data: Json } => row.data !== null);
  const spellings = spellingsOf(query);
  const exact = candidates.find(row => row.key === query.trim())
    ?? candidates.find(row => sameRepo(row.data.repository as Repo, spellings));
  if (exact) {
    const repo = exact.data.repository as Repo | undefined;
    if (repo && (repo.origin || repo.path)) return { identity: { origin: repo.origin, path: repo.path }, ambiguity: [] };
  }
  if (!spellings.origin && spellings.path) {
    const atPath = candidates.map(row => row.data.repository as Repo | undefined)
      .filter((repo): repo is Repo => Boolean(repo?.path === spellings.path && repo.origin));
    const origins = [...new Set(atPath.map(repo => repo.origin!))];
    if (origins.length > 1) return { identity: { origin: null, path: spellings.path }, ambiguity: origins };
    if (origins.length === 1) return { identity: { origin: origins[0], path: spellings.path }, ambiguity: [] };
  }
  return { identity: { origin: spellings.origin, path: spellings.path ?? "" }, ambiguity: [] };
}

/** Which families name exactly this identity today, from the plan's one read. */
function occupiedFamilies(families: Plan["families"], spellings: Spellings): string[] {
  return REPOSITORY_REKEY_FAMILIES.filter(family => families.get(family)!.rows.some(row => FAMILIES[family].names(row, spellings)));
}

/**
 * Which families already use a path that does not belong to the re-keyed
 * source. Unlike the identity match this deliberately sees known-origin records
 * too: a path already claimed by another repository can never be adopted.
 */
function pathClaimants(families: Plan["families"], path: string, source: Spellings): string[] {
  return REPOSITORY_REKEY_FAMILIES.filter(family => FAMILIES[family].claimsPath
    && families.get(family)!.rows.some(row => FAMILIES[family].claimsPath!(row, path, source)));
}

/**
 * Non-empty path hints on the source's own matched records. Used when the
 * settings row has `path: ""` so a path-only step can still name the checkout
 * those rows already carry, without guessing among several.
 */
function collectPathHints(families: Plan["families"]): string[] {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) found.add(value.trim());
  };
  const addRepo = (repo: unknown) => add((repo as Partial<Repo> | null | undefined)?.path);
  const addList = (list: unknown) => {
    if (Array.isArray(list)) for (const repo of list) addRepo(repo);
  };
  const matched = (family: RepositoryRekeyFamily) => families.get(family)!.matched.map(row => row.record);
  for (const settings of matched("repositorySettings")) addRepo(settings.repository);
  for (const task of matched("tasks")) add(task.repoPath);
  for (const outcome of matched("outcomes")) addRepo(outcome.repository);
  for (const lead of matched("leads")) addList(lead.repositories);
  for (const lane of matched("lanes")) addList(lane.repositories);
  for (const decision of matched("decisions")) addRepo((decision.askedBy as Json | undefined)?.project);
  for (const project of matched("projects")) {
    addList(project.repositories);
    addRepo(project.primary);
  }
  for (const tombstone of matched("projectTombstones")) addList(tombstone.repositories);
  for (const run of matched("projectQaRuns")) addRepo(run.repository);
  return [...found];
}

/** Public read-only projection: the same plan, no write. */
export function previewRepositoryRekey(db: DatabaseSync, raw: RepositoryRekeyPreviewInput, inputHash: string, at: string): RepositoryRekeyPreview {
  const plan = planRekey(db, raw);
  return repositoryRekeyPreviewSchema.parse({
    source: plan.source, target: plan.target, pathChanged: plan.pathChanged, ready: plan.refusals.length === 0,
    refusals: plan.refusals, expectedSourceRevision: plan.expectedSourceRevision, counts: plan.counts,
    numbering: plan.numbering, projectKeys: plan.projectKeys, laneKeys: plan.laneKeys,
    historical: [...REPOSITORY_REKEY_HISTORICAL], inputHash, computedAt: at,
  });
}

/**
 * Apply one step inside the caller's transaction. Every precondition is
 * re-checked here, so a refusal leaves no partial source/target, counter,
 * project or cache switch behind: the caller's transaction rolls back.
 */
export function applyRepositoryRekey(db: DatabaseSync, raw: RepositoryRekeyInput, receipt: { id: string; key: string; inputHash: string; at: string }): RepositoryRekeyReceipt {
  const input = repositoryRekeyInputSchema.parse(raw);
  const { author: _author, relayedBy: _relayedBy, ...request } = input;
  const plan = planRekey(db, request);
  if (plan.refusals.length) {
    const first = plan.refusals[0];
    throw new RepositoryRekeyRefused(first.code, plan.refusals, `Repository re-key refused (${first.code}): ${first.explanation}`);
  }
  const { source, target } = plan;
  const move: FamilyMove = { target, spellings: plan.spellings, pathChanged: plan.pathChanged && Boolean(target.path),
    originChanged: plan.originChanged };
  // One family at a time, in the shared family order: each moves exactly the rows
  // the plan matched, through the same rule that matched them.
  for (const family of REPOSITORY_REKEY_FAMILIES) FAMILIES[family].move(db, plan.families.get(family)!.matched, move);

  return repositoryRekeyReceiptSchema.parse({
    id: receipt.id, key: receipt.key, kind: "repository_rekey", source, target, pathChanged: plan.pathChanged,
    reason: input.reason, author: input.author, relayedBy: input.relayedBy ?? null, at: receipt.at, inputHash: receipt.inputHash,
    expectedSourceRevision: plan.expectedSourceRevision, counts: plan.counts, numbering: plan.numbering,
    projectKeys: plan.projectKeys, laneKeys: plan.laneKeys, historical: [...REPOSITORY_REKEY_HISTORICAL],
  });
}
