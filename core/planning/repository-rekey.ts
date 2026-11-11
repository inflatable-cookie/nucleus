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
 */
import type { DatabaseSync } from "node:sqlite";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import {
  REPOSITORY_REKEY_FAMILIES, REPOSITORY_REKEY_HISTORICAL, repositoryRekeyInputSchema, repositoryRekeyPreviewInputSchema, repositoryRekeyPreviewSchema,
  repositoryRekeyReceiptSchema, type RepositoryRekeyCounts, type RepositoryRekeyIdentity, type RepositoryRekeyInput,
  type RepositoryRekeyNumbering, type RepositoryRekeyPreview, type RepositoryRekeyPreviewInput, type RepositoryRekeyReceipt, type RepositoryRekeyRefusal,
  type RepositoryRekeyRefusalCode,
} from "../../shared/repository-rekey";

const emptyCounts = (): RepositoryRekeyCounts => Object.fromEntries(REPOSITORY_REKEY_FAMILIES.map(family => [family, 0]));
const sameCounts = (counts: RepositoryRekeyCounts) => Object.fromEntries(REPOSITORY_REKEY_FAMILIES.map(family => [family, counts[family] ?? 0]));

type Repo = { origin: string | null; path: string };
type Spellings = { origin: string | null; path: string | null };
type Json = Record<string, unknown>;

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

interface Plan {
  source: RepositoryRekeyIdentity;
  target: RepositoryRekeyIdentity;
  pathChanged: boolean;
  expectedSourceRevision: number | null;
  refusals: RepositoryRekeyRefusal[];
  counts: RepositoryRekeyCounts;
  numbering: RepositoryRekeyNumbering;
  projectKeys: string[];
  laneKeys: string[];
  matches: Record<string, Json[]>;
  spellings: Spellings;
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

  const matches: Record<string, Json[]> = {};
  const scan = (spellings: Spellings) => {
    for (const family of REPOSITORY_REKEY_FAMILIES) matches[family] = matchFamily(db, family, spellings);
  };
  scan(source);
  if ((!source.origin && !source.path) || !REPOSITORY_REKEY_FAMILIES.some(family => matches[family].length))
    refusals.add("unknown_source", `No Queue record names repository ${JSON.stringify(input.source)}; nothing to re-key`);

  if (!explicitPath && !source.path) {
    const hints = collectPathHints(matches);
    if (hints.length === 1) {
      source = { origin: source.origin, path: hints[0] };
      scan(source);
    } else if (hints.length > 1 && target.path)
      refusals.add("ambiguous_source", `Source records name ${hints.length} checkout paths (${hints.slice(0, 5).join(", ")}); pass sourcePath to choose the path this step moves`);
  }

  const pathChanged = Boolean(target.path && target.path !== source.path);
  const originChanged = Boolean(targetOrigin && (source.origin ? targetOrigin !== source.origin : true));
  if (targetOrigin && source.origin && targetOrigin === source.origin && !pathChanged)
    refusals.add("source_equals_target", `Source and target are the same repository origin ${targetOrigin}${source.path ? ` at ${source.path}` : ""}`);

  const settings = matches.repositorySettings[0];
  const expectedSourceRevision = settings ? Number(settings.revision ?? 0) : null;
  if (expectedSourceRevision !== input.expectedSourceRevision)
    refusals.add("source_revision_changed",
      `Observed source revision ${String(input.expectedSourceRevision)} no longer matches the stored revision ${String(expectedSourceRevision)}; read a fresh preview`);

  if (targetOrigin && originChanged) {
    // Occupancy is current ownership. Settled contract-010 host-run rows keep the
    // identity they were written under by design, so they are evidence and never
    // occupy a name: otherwise the documented Full swap could never run past the
    // first step for any repository that ever ran QA. A path-only step keeps the
    // source origin, so that origin is not occupancy of a different repository.
    const occupied = occupiedFamilies(db, { origin: targetOrigin, path: null });
    if (occupied.length) refusals.add("target_occupied", `Target origin ${targetOrigin} is already named by ${occupied.join(", ")}`);
  }
  if (pathChanged && target.path) {
    const occupied = REPOSITORY_REKEY_FAMILIES.filter(family => pathBelongsToAnother(db, family, target.path!, source));
    if (occupied.length) refusals.add("path_occupied", `Target path ${target.path} is already used by another repository in ${occupied.join(", ")}`);
  }

  // Active writers: a re-key never strands or re-routes work that could still
  // write under the old routing namespace.
  const tasks = matches.tasks.filter(task => !task.removedAt && !["done", "cancelled"].includes(String(task.phase)));
  if (tasks.length) refusals.add("active_tasks",
    `${tasks.length} unfinished task${tasks.length === 1 ? "" : "s"} still name the source (${tasks.slice(0, 5).map(task => String(task.reference ?? task.id)).join(", ")}); finish or dispose of them first`);
  const unsettled = rows(db, "SELECT id,kind,state,json_extract(data,'$.repoPath') AS repoPath,payload FROM operations WHERE state IN ('pending','running','needs_attention')");
  const writers = unsettled.filter(operation => {
    const payload = parseJson(operation.payload);
    const submission = payload?.submission ? payload.submission as Json : payload?.input ? (payload.input as Json).submission as Json | undefined : undefined;
    return sameText(operation.repoPath, source) || sameText(payload?.repository, source) || sameText(submission?.repoPath, source);
  });
  if (writers.length) refusals.add("active_operations",
    `${writers.length} unsettled Queue operation${writers.length === 1 ? "" : "s"} could still write under the source (${[...new Set(writers.map(operation => String(operation.kind)))].join(", ")})`);
  const activeTaskIds = new Set(matches.tasks.map(task => String(task.id)));
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

  for (const family of REPOSITORY_REKEY_FAMILIES) counts[family] = matches[family].length;
  const counters = matches.taskNumberCounters;
  const sourceNext = counters.length ? Math.max(...counters.map(counter => Number(counter.next_number))) : null;
  const numbering: RepositoryRekeyNumbering = {
    tasks: matches.taskNumbers.length,
    sourceNext,
    // Numbering continues from the same counter: it never restarts at 1.
    targetNext: sourceNext,
  };
  return {
    source, target, pathChanged, expectedSourceRevision, refusals: refusals.value(), counts: sameCounts(counts), numbering,
    projectKeys: matches.projects.map(project => String(project.key)).filter(Boolean),
    laneKeys: matches.lanes.map(lane => String(lane.key)).filter(Boolean), matches, spellings: source,
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

/** Which families name exactly this identity today. */
function occupiedFamilies(db: DatabaseSync, spellings: Spellings): string[] {
  return REPOSITORY_REKEY_FAMILIES.filter(family => matchFamily(db, family, spellings).length > 0);
}

/**
 * True when a path is used by a record that does not belong to the re-keyed
 * source. Unlike the identity match this deliberately sees known-origin records
 * too: a path already claimed by another repository can never be adopted.
 */
function pathBelongsToAnother(db: DatabaseSync, family: string, path: string, source: Spellings): boolean {
  const repoHasPath = (repo: unknown) => {
    const value = repo as Partial<Repo> | null | undefined;
    return Boolean(value && value.path === path && !sameRepo(value, source));
  };
  const listHasPath = (list: unknown) => Array.isArray(list) && (list as Repo[]).some(repoHasPath);
  const parsed = (sql: string, ...params: Array<string | null>) => rows(db, sql, ...params).map(row => parseJson(row.data) ?? {});
  switch (family) {
    case "repositorySettings": return parsed("SELECT data FROM repository_settings").some(record => repoHasPath(record.repository));
    case "tasks": return parsed("SELECT data FROM tasks").some(record => record.repoPath === path && !sameText(record.repository, source));
    case "outcomes": return parsed("SELECT data FROM outcomes").some(record => repoHasPath(record.repository));
    case "leads": return parsed("SELECT data FROM leads").some(record => listHasPath(record.repositories));
    case "lanes": return parsed("SELECT data FROM lanes").some(record => listHasPath(record.repositories));
    case "projects": return parsed("SELECT data FROM projects").some(record => listHasPath(record.repositories) || repoHasPath(record.primary));
    case "projectTombstones": return parsed("SELECT data FROM project_tombstones").some(record => listHasPath(record.repositories));
    case "decisions": return parsed("SELECT data FROM decisions").some(record => repoHasPath((record.askedBy as Json | undefined)?.project));
    case "projectQaRuns": return parsed("SELECT data FROM project_qa_runs").some(record => repoHasPath(record.repository) || record.key === path);
    case "taskNumberCounters": return rows(db, "SELECT repository FROM task_number_counters WHERE repository=?", path).length > 0;
    case "taskNumbers": return rows(db, "SELECT repository FROM task_numbers WHERE repository=? LIMIT 1", path).length > 0;
    case "qaScheduleMerges": return rows(db, "SELECT repository FROM qa_schedule_merges WHERE repository=? LIMIT 1", path).length > 0;
    default: return false;
  }
}

/**
 * Non-empty path hints on the source's own matched records. Used when the
 * settings row has `path: ""` so a path-only step can still name the checkout
 * those rows already carry, without guessing among several.
 */
function collectPathHints(matches: Record<string, Json[]>): string[] {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) found.add(value.trim());
  };
  const addRepo = (repo: unknown) => add((repo as Partial<Repo> | null | undefined)?.path);
  const addList = (list: unknown) => {
    if (Array.isArray(list)) for (const repo of list) addRepo(repo);
  };
  for (const row of matches.repositorySettings ?? []) addRepo(row.repository);
  for (const task of matches.tasks ?? []) add(task.repoPath);
  for (const outcome of matches.outcomes ?? []) addRepo(outcome.repository);
  for (const lead of matches.leads ?? []) addList(lead.repositories);
  for (const lane of matches.lanes ?? []) addList(lane.repositories);
  for (const decision of matches.decisions ?? []) addRepo((decision.askedBy as Json | undefined)?.project);
  for (const project of matches.projects ?? []) {
    addList(project.repositories);
    addRepo(project.primary);
  }
  for (const tombstone of matches.projectTombstones ?? []) addList(tombstone.repositories);
  for (const run of matches.projectQaRuns ?? []) addRepo(run.repository);
  return [...found];
}

/**
 * A task names the source when its own repository identity says so. A record
 * that already has a known origin is never claimed through its checkout path:
 * that is the same distinction `putRepository` keeps when it refuses to let a
 * reused path absorb another repository's settings. Only a task with no origin
 * of its own (a path-only predecessor) can be matched by its path.
 */
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

/** The stored rows of one family that name this identity, read without rewriting anything. */
function matchFamily(db: DatabaseSync, family: string, spellings: Spellings): Json[] {
  const key = spellings.origin ?? spellings.path;
  switch (family) {
    case "repositorySettings":
      return rows(db, "SELECT key,data FROM repository_settings ORDER BY rowid").map(row => ({ key: String(row.key), ...(parseJson(row.data) ?? {}) }) as Json)
        .filter(row => row.key === key || sameRepo(row.repository as Repo, spellings));
    case "taskNumberCounters":
      return rows(db, "SELECT repository,next_number FROM task_number_counters WHERE repository=? OR repository=?", spellings.origin, spellings.path);
    case "taskNumbers":
      return rows(db, "SELECT task_id,repository,number FROM task_numbers WHERE repository=? OR repository=?", spellings.origin, spellings.path);
    case "tasks":
      return rows(db, "SELECT id,data FROM tasks").map(row => ({ id: String(row.id), ...(parseJson(row.data) ?? {}) }) as Json)
        .filter(task => matchesTask(task, spellings));
    case "outcomes":
      return rows(db, "SELECT taskId,data FROM outcomes").map(row => ({ taskId: String(row.taskId), ...(parseJson(row.data) ?? {}) }) as Json)
        .filter(outcome => sameRepo(outcome.repository as Repo, spellings));
    case "leads":
      return rows(db, "SELECT id,data FROM leads").map(row => ({ id: String(row.id), ...(parseJson(row.data) ?? {}) }) as Json)
        .filter(lead => ((lead.repositories as Repo[] | undefined) ?? []).some(repo => sameRepo(repo, spellings))
          || ((lead.targets as Json[] | undefined) ?? []).some(target => sameText(target.repository, spellings)));
    case "lanes":
      return rows(db, "SELECT id,key,data FROM lanes").map(row => ({ id: String(row.id), key: String(row.key), ...(parseJson(row.data) ?? {}) }) as Json)
        .filter(lane => ((lane.repositories as Repo[] | undefined) ?? []).some(repo => sameRepo(repo, spellings)));
    case "decisions":
      return rows(db, "SELECT id,data FROM decisions").map(row => ({ id: String(row.id), ...(parseJson(row.data) ?? {}) }) as Json)
        .filter(decision => sameRepo(((decision.askedBy as Json | undefined)?.project) as Repo, spellings));
    case "projects":
      return rows(db, "SELECT key,data FROM projects").map(row => ({ key: String(row.key), ...(parseJson(row.data) ?? {}) }) as Json)
        .filter(project => ((project.repositories as Repo[] | undefined) ?? []).some(repo => sameRepo(repo, spellings))
          || sameRepo(project.primary as Repo, spellings));
    case "projectTombstones":
      return rows(db, "SELECT key,data FROM project_tombstones").map(row => ({ key: String(row.key), ...(parseJson(row.data) ?? {}) }) as Json)
        .filter(tombstone => ((tombstone.repositories as Repo[] | undefined) ?? []).some(repo => sameRepo(repo, spellings)));
    case "projectQaRuns":
      // The candidate scan may reach a run that shares a checkout path with
      // another repository, so the identity decision is made by the same
      // origin-first rule as every other family, never by the path alone.
      return rows(db, `SELECT id,data FROM project_qa_runs WHERE repository=? OR repository=?
          OR json_extract(data,'$.repository.origin')=? OR json_extract(data,'$.repository.path')=?
          OR json_extract(data,'$.key')=?`, spellings.origin, spellings.path, spellings.origin, spellings.path, key)
        .map(row => ({ id: String(row.id), ...(parseJson(row.data) ?? {}) }) as Json)
        .filter(run => matchesQaRun(run, spellings));
    case "qaScheduleMerges":
      return rows(db, "SELECT taskId,repository FROM qa_schedule_merges WHERE repository=? OR repository=?", spellings.origin, spellings.path);
    default:
      return [];
  }
}

/** Public read-only projection: the same scan, no write. */
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
  const { source, target, spellings, matches } = plan;
  const newText = targetText(target);
  const pathChanged = plan.pathChanged && Boolean(target.path);
  const originChanged = newText !== (source.origin ?? source.path);

  // repository_settings: the row moves to the target key with all of its content.
  for (const settings of matches.repositorySettings) {
    const { key: storedKey, ...rest } = settings;
    db.prepare("DELETE FROM repository_settings WHERE key=?").run(String(storedKey));
    db.prepare("INSERT INTO repository_settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(newText, JSON.stringify({ ...rest, repository: retarget(rest.repository as Repo, target, pathChanged, spellings) }));
  }

  // Numbering stays per repository: counters and assignments follow an origin
  // change. A path-only step leaves the numbering rows as they are.
  if (originChanged) {
    const counters = matches.taskNumberCounters;
    if (counters.length) {
      const next = Math.max(...counters.map(counter => Number(counter.next_number)));
      for (const counter of counters) db.prepare("DELETE FROM task_number_counters WHERE repository=?").run(String(counter.repository));
      db.prepare("INSERT INTO task_number_counters(repository,next_number) VALUES(?,?) ON CONFLICT(repository) DO UPDATE SET next_number=excluded.next_number").run(newText, next);
    }
    for (const number of matches.taskNumbers)
      db.prepare("UPDATE task_numbers SET repository=? WHERE task_id=?").run(newText, String(number.task_id));
  }

  // Tasks: identity fields only. Brief text, reviews, evidence and PR facts are
  // side storage or untouched payload, so their bytes do not change.
  for (const task of matches.tasks) {
    const mutation = clone(task);
    const matchedByPath = !sameText(mutation.repository, spellings) && sameText(mutation.repoPath, spellings);
    retargetText(mutation, "repository", spellings, target);
    // A path-only task whose repository gains an origin takes it, so its numbering
    // and every later lookup resolve the origin rather than the old path.
    if (matchedByPath && !mutation.repository) mutation.repository = targetText(target);
    if (pathChanged) retargetPath(mutation, "repoPath", spellings, target);
    const reviewEntry = mutation.reviewEntry as Json | null;
    if (reviewEntry) retargetText(reviewEntry, "repository", spellings, target);
    for (const pin of (mutation.siblingPins as Json[] | undefined) ?? []) retargetText(pin, "repository", spellings, target);
    for (const finding of (mutation.siblingFindings as Json[] | undefined) ?? []) retargetText(finding, "repository", spellings, target);
    db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(mutation), String(task.id));
  }

  // Outcomes: the searchable repository identity and sibling pins; every proof
  // field (PR URL, commits, brief, review, validation) stays exactly as written.
  for (const outcome of matches.outcomes) {
    const mutation = clone(outcome);
    const repo = mutation.repository as Repo | undefined;
    if (repo) {
      mutation.repository = retarget(repo, target, pathChanged, spellings);
      db.prepare("UPDATE outcomes SET repository=? WHERE taskId=?").run(newText, String(outcome.taskId));
    }
    for (const sibling of (mutation.siblings as Json[] | undefined) ?? []) retargetText(sibling, "repository", spellings, target);
    db.prepare("UPDATE outcomes SET data=? WHERE taskId=?").run(JSON.stringify(mutation), String(outcome.taskId));
  }

  for (const lead of matches.leads) {
    const mutation = clone(lead);
    for (const repo of (mutation.repositories as Repo[] | undefined) ?? []) retargetRepo(repo, spellings, target, pathChanged);
    for (const leadTarget of (mutation.targets as Json[] | undefined) ?? []) retargetText(leadTarget, "repository", spellings, target);
    db.prepare("UPDATE leads SET data=? WHERE id=?").run(JSON.stringify(mutation), String(lead.id));
  }

  for (const lane of matches.lanes) {
    const mutation = clone(lane);
    for (const repo of (mutation.repositories as Repo[] | undefined) ?? []) retargetRepo(repo, spellings, target, pathChanged);
    db.prepare("UPDATE lanes SET data=? WHERE key=?").run(JSON.stringify(mutation), String(lane.key));
  }


  for (const decision of matches.decisions) {
    const mutation = clone(decision);
    const askedBy = mutation.askedBy as Json | undefined;
    if (askedBy) retargetRepo(askedBy.project, spellings, target, pathChanged);
    db.prepare("UPDATE decisions SET data=? WHERE id=?").run(JSON.stringify(mutation), String(decision.id));
  }

  // Project identity itself (key, name, version, owner, plan) is stable: only
  // the repository members and the primary pointer move.
  for (const project of matches.projects) {
    const mutation = clone(project);
    for (const repo of (mutation.repositories as Repo[] | undefined) ?? []) retargetRepo(repo, spellings, target, pathChanged);
    retargetRepo(mutation.primary, spellings, target, pathChanged);
    db.prepare("UPDATE projects SET data=? WHERE key=?").run(JSON.stringify(mutation), String(project.key));
  }
  for (const tombstone of matches.projectTombstones) {
    const mutation = clone(tombstone);
    for (const repo of (mutation.repositories as Repo[] | undefined) ?? []) retargetRepo(repo, spellings, target, pathChanged);
    db.prepare("UPDATE project_tombstones SET data=? WHERE key=?").run(JSON.stringify(mutation), String(tombstone.key));
  }

  // Milestone QA: finished runs keep their argv, output, digests and times; only
  // the repository they belong to and its one-run key move. The host-run caller
  // was minted from the submitted key and contract-010 history is never rewritten
  // (task 445), so the row records that key as provenance in this same transaction
  // before its current key moves. A second re-key keeps the first recorded key.
  for (const run of matches.projectQaRuns) {
    const mutation = clone(run);
    const oldKey = String(run.key ?? "");
    retargetRepo(mutation.repository, spellings, target, pathChanged);
    if (sameText(mutation.key, spellings)) {
      if (!mutation.submittedKey && oldKey) mutation.submittedKey = oldKey;
      mutation.key = newText;
    }
    db.prepare("UPDATE project_qa_runs SET repository=?,data=? WHERE id=?").run(newText, JSON.stringify(mutation), String(run.id));
    db.prepare("UPDATE project_qa_latest SET key=? WHERE id=? AND key=?").run(newText, String(run.id), oldKey);
  }
  for (const merge of matches.qaScheduleMerges)
    db.prepare("UPDATE qa_schedule_merges SET repository=? WHERE taskId=?").run(newText, String(merge.taskId));

  return repositoryRekeyReceiptSchema.parse({
    id: receipt.id, key: receipt.key, kind: "repository_rekey", source, target, pathChanged,
    reason: input.reason, author: input.author, relayedBy: input.relayedBy ?? null, at: receipt.at, inputHash: receipt.inputHash,
    expectedSourceRevision: plan.expectedSourceRevision, counts: plan.counts, numbering: plan.numbering,
    projectKeys: plan.projectKeys, laneKeys: plan.laneKeys, historical: [...REPOSITORY_REKEY_HISTORICAL],
  });
}
