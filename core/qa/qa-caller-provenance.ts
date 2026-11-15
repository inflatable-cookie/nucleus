/**
 * Resolve the key an exact milestone QA run caller may name after repository
 * re-keying (tasks 444/445; Spec 056). The caller is immutable history, while a
 * re-key changes the QA row's current key. Resolution therefore checks the
 * current key, the transaction-recorded submitted key, then bounded applied
 * receipts in reverse order. Every candidate must match the exact caller/run
 * pair and the host-run repository evidence; ambiguous or incomplete history
 * refuses instead of guessing. Path-changing submitted keys bind by repository
 * identity because the old checkout path is not durable in the receipt.
 */
import type { ProjectQaRun } from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import type { RepositoryRekeyReceipt } from "../../shared/repository-rekey";
import { qaCallerRunId } from "./qa-caller";

/** The longest chain of applied moves this check follows; beyond it the evidence is ambiguous, not guessed. */
export const QA_CALLER_LINEAGE_MAX_STEPS = 8;

export interface QaCallerRepositoryIdentity {
  origin: string | null;
  path: string;
}

/** One applied re-key step, as the durable receipt states it. */
export interface QaCallerLineageStep {
  receiptId: string;
  /** The identity the row held before the step. */
  from: string;
  /** The identity the row held after it. */
  to: string;
  at: string;
}

/** A resolved key: the caller's exact key, and the repository identity that key names. */
export interface QaCallerKeyResolution {
  key: string;
  /** Where the accepted key came from, so the evidence can say how it was established. */
  source: "current" | "row_provenance" | "rekey_lineage";
  /**
   * The repository identity the accepted key names, reconstructed from the row
   * and the verified moves. The immutable host-run record must name this same
   * repository; it never names the post-re-key identity.
   */
  repository: QaCallerRepositoryIdentity;
  /** The verified moves between the accepted key and the row's current key, newest first. */
  lineage: QaCallerLineageStep[];
}

export type QaCallerKeyRefusal = {
  reason: string;
  /** Which positive fact could not be established: the caller's key, or the repository it names. */
  cause: "caller" | "repository";
};

const identityText = (identity: QaCallerRepositoryIdentity): string => identity.origin ?? identity.path;
const sameIdentityText = (left: string, right: string): boolean => {
  const leftOrigin = normalizeRepositoryOrigin(left);
  const rightOrigin = normalizeRepositoryOrigin(right);
  if (leftOrigin && rightOrigin) return leftOrigin === rightOrigin;
  return left.trim() === right.trim();
};
const atMs = (receipt: RepositoryRekeyReceipt): number => Date.parse(receipt.at);

/**
 * Whether two records name the same repository: the same normalised origin and
 * the same checkout path, or — when one of them has no origin — the same path.
 * A path-only predecessor never matches an origin-known record of another
 * repository, so a shared checkout cannot merge two repositories' evidence.
 */
export function qaSameRepository(left: QaCallerRepositoryIdentity, right: QaCallerRepositoryIdentity): boolean {
  const canonical = (value: string | null): string | null => {
    if (!value) return null;
    const normalized = normalizeRepositoryOrigin(value);
    return (normalized ?? value).toLowerCase();
  };
  const leftOrigin = canonical(left.origin);
  const rightOrigin = canonical(right.origin);
  if (leftOrigin && rightOrigin) return leftOrigin === rightOrigin && left.path === right.path;
  return left.path !== "" && left.path === right.path;
}

/**
 * Whether the immutable host-run record names the repository an ancestor key
 * belongs to. A receipt whose step did not move the checkout reconstructs it
 * exactly, so the comparison is the full identity-and-checkout one; a step that
 * moved the checkout leaves the pre-move checkout unrecorded, and then the
 * identity the caller names — not a guessed path — is what must agree.
 */
function namesAncestorRepository(runRepository: QaCallerRepositoryIdentity, ancestor: QaCallerKeyLevel): boolean {
  if (ancestor.repository.path) return qaSameRepository(runRepository, ancestor.repository);
  return qaKeyNamesRepository(ancestor.key, runRepository);
}

/** The checkout a repository identity names, for a refusal that has to say what disagreed. */
const describeRepository = (repository: QaCallerRepositoryIdentity): string =>
  repository.path ? `${identityText(repository)} at ${repository.path}` : identityText(repository);

/** Does this stored key text still name the row's own repository identity? */
export function qaKeyNamesRepository(key: string, repository: QaCallerRepositoryIdentity): boolean {
  if (repository.path && key.trim() === repository.path) return true;
  return Boolean(repository.origin && sameIdentityText(key, repository.origin));
}

/** The submitted key's identity: an origin when it has one, else the checkout path. */
function repositoryForKey(key: string, currentPath: string): QaCallerRepositoryIdentity {
  const origin = normalizeRepositoryOrigin(key);
  return origin ? { origin, path: currentPath } : { origin: null, path: key.trim() };
}

interface QaCallerKeyLevel {
  key: string;
  repository: QaCallerRepositoryIdentity;
  step: QaCallerLineageStep | null;
  /** The step that produced this level moved the checkout. */
  pathMoved?: boolean;
}

/**
 * The identities the QA row held before its current one, newest first, from the
 * applied re-key receipts alone. A step joins only when its target is the
 * identity the row held, it happened while the row existed, it moved at least
 * one QA row, and it is the single latest such step; anything else refuses with
 * the reason it could not be established.
 */
function lineageLevels(input: {
  qaRun: ProjectQaRun;
  receipts: readonly RepositoryRekeyReceipt[];
  submittedMs: number;
}): { levels: QaCallerKeyLevel[] } | { reason: string } {
  const { qaRun, receipts, submittedMs } = input;
  const levels: QaCallerKeyLevel[] = [];
  const seen = new Set<string>([qaRun.key.trim()]);
  let identity = qaRun.key.trim();
  let repository: QaCallerRepositoryIdentity = { origin: qaRun.repository.origin, path: qaRun.repository.path };
  let before = Number.POSITIVE_INFINITY;
  // `Store.repositoryRekeys()` returns durable insertion order (oldest first).
  // Receipts can share a millisecond, so use that order to walk a chain while
  // retaining ambiguity when multiple receipts claim the same destination.
  let beforeIndex = Number.POSITIVE_INFINITY;
  for (let step = 0; step < QA_CALLER_LINEAGE_MAX_STEPS; step++) {
    const candidates = receipts.flatMap((receipt, index) => {
      const target = identityText(receipt.target);
      const when = atMs(receipt);
      const earlier = when < before || (when === before && index < beforeIndex);
      return target !== "" && sameIdentityText(target, identity)
        && (receipt.counts.projectQaRuns ?? 0) > 0
        && Number.isFinite(when) && when >= submittedMs && earlier
        ? [{ receipt, index, when }] : [];
    });
    if (candidates.length === 0) return { levels };
    const latest = Math.max(...candidates.map(candidate => candidate.when));
    const chosen = candidates.filter(candidate => candidate.when === latest);
    if (chosen.length > 1)
      return { reason: `the re-key history records ${chosen.length} different moves into ${identity} at ${new Date(latest).toISOString()}, so the original key is ambiguous` };
    const { receipt, index } = chosen[0];
    const from = identityText(receipt.source);
    if (from === "") return { reason: `an applied re-key receipt names no source identity for ${identity}` };
    if (seen.has(from.trim())) {
      // An out-and-back move (A to B, then B to A, as a temporary namespace does) is
      // a net no-op: the row held `from` before it and holds it again after. Drop
      // the round trip and keep walking from `from` at the time the trip began.
      // The pre-trip checkout of a trip that moved it is not recorded, so then the
      // path is left unclaimed and the identity alone is compared; a trip that
      // moved nothing leaves the reconstruction exact.
      const anchor = levels.findIndex(level => level.key.trim() === from.trim());
      const anchored = anchor >= 0 ? levels[anchor].repository : { origin: qaRun.repository.origin, path: qaRun.repository.path };
      const moved = receipt.pathChanged || levels.slice(anchor + 1).some(level => level.pathMoved);
      levels.length = anchor + 1;
      repository = { origin: anchored.origin, path: moved ? "" : anchored.path };
      if (anchor >= 0) levels[anchor] = { ...levels[anchor], repository };
      identity = from.trim();
      seen.clear();
      seen.add(qaRun.key.trim());
      for (const level of levels) seen.add(level.key.trim());
      before = atMs(receipt);
      beforeIndex = index;
      continue;
    }
    // A step that moved the checkout rewrote this row's path to its target, and the
    // receipt records the *settings* source path rather than this row's previous
    // checkout — so the pre-move checkout is not recorded and is never guessed.
    // The identity is, and it is what the caller's key names; keeping the path only
    // when the step did not move it keeps that comparison exact where it can be.
    const pathMoved = receipt.pathChanged && Boolean(receipt.target.path) && repository.path === receipt.target.path;
    repository = { origin: receipt.source.origin, path: pathMoved ? "" : repository.path };
    const step: QaCallerLineageStep = { receiptId: receipt.id, from, to: identityText(receipt.target), at: receipt.at };
    levels.push({ key: from, repository, step, pathMoved: receipt.pathChanged });
    identity = from.trim();
    seen.add(identity);
    before = atMs(receipt);
    beforeIndex = index;
  }
  return { reason: `the re-key history is longer than the ${QA_CALLER_LINEAGE_MAX_STEPS} moves this check follows` };
}

/**
 * The key this host run's caller may name, and the repository identity that key
 * belongs to. `rekeys` is read only when the row's current key cannot answer, so
 * an ordinary run costs no receipt read at all.
 */
export function resolveQaCallerKey(input: {
  runId: string;
  caller: string;
  qaRun: ProjectQaRun;
  /**
   * The immutable host-run record's own repository identity, when the caller has
   * it: the accepted key must agree with it (`qaSameRepository`, or the identity
   * binding for a recorded submitted key). Omitted, only which key the caller may
   * name is resolved — the retained-output classification always supplies it.
   */
  runRepository?: QaCallerRepositoryIdentity;
  rekeys?: () => readonly RepositoryRekeyReceipt[];
}): QaCallerKeyResolution | QaCallerKeyRefusal {
  const { runId, caller, qaRun } = input;
  const runRepository = input.runRepository;
  const rowRepository: QaCallerRepositoryIdentity = { origin: qaRun.repository.origin, path: qaRun.repository.path };
  // The row's own key is the ordinary case, and only counts while it still names
  // the row's own repository: a vacated name is not this run's current identity.
  if (qaKeyNamesRepository(qaRun.key, qaRun.repository) && qaCallerRunId(caller, qaRun.key, runId) !== null) {
    if (!runRepository || qaSameRepository(runRepository, rowRepository))
      return { key: qaRun.key, source: "current", repository: rowRepository, lineage: [] };
    // The caller names the row's current key but the run records another
    // repository: that contradiction is the repository's, not the caller's.
    return { cause: "repository", reason: `its key ${qaRun.key} names ${describeRepository(rowRepository)}, which the host run does not name` };
  }
  // Per-run provenance written by the re-key that moved this row's key. The key is
  // bound by identity: an explicit-path move (and a checkout that had already
  // moved) leaves the run's historical path legitimately different.
  const submittedKey = qaRun.submittedKey && qaRun.submittedKey.trim() !== qaRun.key.trim() ? qaRun.submittedKey : null;
  const provenanceRepository = submittedKey ? repositoryForKey(submittedKey, qaRun.repository.path) : null;
  const provenanceNamed = submittedKey !== null && qaCallerRunId(caller, submittedKey, runId) !== null;
  if (submittedKey && provenanceNamed && (!runRepository || qaKeyNamesRepository(submittedKey, runRepository)))
    return { key: submittedKey, source: "row_provenance", repository: provenanceRepository!, lineage: [] };
  // Pre-receipt renames: the applied receipts are the only durable evidence of
  // which identity this row held before the move.
  const submittedAt = qaRun.submittedAt ?? qaRun.startedAt;
  const submittedMs = Date.parse(submittedAt);
  if (!Number.isFinite(submittedMs))
    return { cause: "caller", reason: `the Project QA record has no readable submission time to order its re-key history by` };
  // The caller names the recorded submitted key, so the run was minted under it
  // and must name that identity; a receipt could only reconstruct that same
  // identity, so nothing later could place the caller's key.
  if (provenanceNamed)
    return { cause: "repository", reason: `its recorded submitted key ${submittedKey} names ${describeRepository(provenanceRepository!)}, which the host run does not name` };
  let receipts: readonly RepositoryRekeyReceipt[];
  try { receipts = input.rekeys ? input.rekeys() : []; }
  catch (error) { return { cause: "caller", reason: `the repository re-key receipts could not be read (${error instanceof Error ? error.message : String(error)})` }; }
  if (receipts.length === 0)
    return { cause: "caller", reason: `no applied repository re-key explains why its caller's key differs from ${qaRun.key}` };
  const derived = lineageLevels({ qaRun, receipts, submittedMs });
  if ("reason" in derived) return { cause: "caller", reason: derived.reason };
  let rejected: QaCallerKeyLevel | null = null;
  for (let index = 0; index < derived.levels.length; index++) {
    const ancestor = derived.levels[index];
    if (qaCallerRunId(caller, ancestor.key, runId) === null) continue;
    if (runRepository && !namesAncestorRepository(runRepository, ancestor)) { rejected ??= ancestor; continue; }
    // Newest move first: the step that moved the row into its current identity,
    // then each earlier one down to the ancestor.
    const lineage = derived.levels.slice(0, index + 1).map(level => level.step!);
    return { key: ancestor.key, source: "rekey_lineage", repository: ancestor.repository, lineage };
  }
  if (rejected)
    return { cause: "repository", reason: `its caller names ${rejected.key}, whose checkout the receipt reconstructs as ${describeRepository(rejected.repository)}, and the host run names another` };
  return {
    cause: "caller",
    reason: derived.levels.length === 0
      ? `no applied repository re-key moved ${qaRun.key} after the run was submitted`
      : `the caller names no key this run's repository held before it moved (${derived.levels.map(level => level.key).join(", ")})`,
  };
}
