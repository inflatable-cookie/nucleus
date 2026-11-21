import { existsSync } from "node:fs";
import { doublingDelay } from "../../shared/backoff";
import { HOST_KIND_LABELS, hostKindOf } from "../../shared/host-kind";
import { AdmissionDeferred } from "../host/admission";
import type { Adapter, ExternalWorkspaceArchiveOutcome, ExternalWorkspaceCatalogEntry } from "../host/adapter";
import { now, type Store } from "../store/store";
import { threadServesAnotherTask } from "./thread-ownership";
import {
  type ExternalWorkspaceArchive, type Run, type Task, externalWorkspaceArchiveSettled, externalArchiveOccurrence, ownerSettlementMatches, holdsOf,
} from "../../shared/contracts";

/**
 * Spec 017: archive a merged review-entry task's external workspace *catalog
 * entries* (Tom, 2026-10-25).
 *
 * Queue never archived a workspace it did not create, so a done review-entry
 * task in an external workspace stayed in the Paseo sidebar forever. The ruling
 * allows one effect: when the registrations at the task's exact folder hold only
 * that task's own idle threads, Paseo's catalog entries are archived. The
 * original ruling kept every folder; Tom's same-day amendment allows Paseo's own
 * teardown to remove a *worktree* folder after a fresh clean, published source
 * proof, because a verified published head loses nothing. A non-worktree
 * external folder keeps the no-removal rule, and Queue itself never removes,
 * cleans, resets, stashes, rewrites or pushes anything.
 *
 * This record is the durable at-most-once identity of that catalog operation,
 * one per catalog registration. It is separate from `archivedWorkspaceIds`
 * (Queue-owned teardown), from `runtimeRetirements` (the checkout's Effigy scope
 * proof), from source publication and from `workspaceRetirement` (an owner's
 * later authorization to remove a preserved workspace). Unknown native delivery
 * is observed, never replayed blindly.
 *
 * One pass is three reads of one fact: whether the task still owes the archive
 * (`owesCatalogArchive`), what this exact folder's complete inventory is
 * (`readCatalogRegistrations`), and what one registration's attempt established
 * (`archiveOneRegistration`). Every decision switches on the typed record and the
 * typed observation; no state is read from a `detail` line's words.
 */

const RETRY_BASE_MS = 60_000, RETRY_MAX_MS = 60 * 60_000;
/** The wrapper the catch puts around an adapter throw so the record says what happened. */
const CATALOG_REQUEST_WRAPPER = "Catalog archive could not be requested: ";

export interface ExternalWorkspaceArchivePorts {
  store: Store;
  adapter: Adapter;
  paused(): boolean;
  resolution: { update(task: Task, changes: Partial<Task["resolution"]>, patch?: Partial<Task>, event?: string, detail?: string): Task };
}

/** The exactly-bound external workspace of one preserved review-entry task. */
export function preservedExternalWorkspace(task: Task): { workspaceId: string; directory: string } | null {
  const entry = task.reviewEntry;
  if (!entry || entry.preserveWorkspace !== true) return null;
  if (!task.workspaceId || !task.directory) return null;
  // An external workspace identity is a single exact bind: the task's workspace
  // is the review entry's workspace and the recorded checkout directory.
  if (entry.workspaceId !== task.workspaceId) return null;
  if (entry.directory && entry.directory !== task.directory) return null;
  return { workspaceId: task.workspaceId, directory: task.directory };
}

/** Every thread identity this task may own: attached roles, runs and retired workers. */
export function taskThreadIdentities(task: Task, runs: Run[]): Set<string> {
  return new Set([task.agentId, task.coordinatorAgentId, task.resolution.reviewerAgentId,
    ...task.retiredWorkers.map(worker => worker.agentId), ...runs.map(run => run.agentId)]
    .filter((id): id is string => Boolean(id)));
}

/** The stable native idempotency identity of one entry's catalog operation. */
export const externalWorkspaceArchiveRequestId = (taskId: string, workspaceId: string) => `ns-catalog-archive-${taskId}-${workspaceId}`;

/** The recorded catalog archive for this task's workspace, or null. */
export const recordedExternalArchive = (task: Task, workspaceId: string) =>
  task.resolution.externalWorkspaceArchives.find(record => record.workspaceId === workspaceId) ?? null;
const settledByOwner = (task: Task, workspaceId: string) => ownerSettlementMatches(task, `external_workspace_archive.${workspaceId}`,
  externalArchiveOccurrence(workspaceId, recordedExternalArchive(task, workspaceId)));

/** The bounded automatic retry after a hold or an unknown answer. */
export const externalArchiveRetryDelay = (attempts: number) => doublingDelay(RETRY_BASE_MS, RETRY_MAX_MS, attempts);

/**
 * The opening every cleanup line this effect writes begins with. The shared
 * `cleanupReason` field carries several owners' causes, so this effect rewrites
 * it only while it still holds a line under this opening. Nothing else in Queue
 * writes a cleanup cause under it, and older releases' wordings start here too,
 * so a line left by a previous version stays this effect's to clear.
 */
const CLEANUP_REASON_OPENING = "External workspace";

/** The one visible cause this effect records for each unsettled state. */
const HOLD_REASON = {
  failed: "archive failed",
  uncertain: "archive is uncertain; observe before retrying",
  held: "catalog entry held",
} as const;

/** The recorded cause of an unresolved catalog archive, for the task's cleanup line. */
export function externalArchiveHoldReason(task: Task): string {
  const record = task.resolution.externalWorkspaceArchives.find(item => (item.state === "held" || item.state === "uncertain" || item.state === "failed") && !settledByOwner(task, item.workspaceId));
  if (!record) return "";
  const cause = record.state === "failed" ? HOLD_REASON.failed : record.state === "uncertain" ? HOLD_REASON.uncertain : HOLD_REASON.held;
  return `${CLEANUP_REASON_OPENING} ${cause} for ${record.workspaceId}: ${record.detail}`;
}

/** Whether a stored cleanup cause is one this effect wrote. */
const ownsCleanupReason = (reason: string) => reason.startsWith(CLEANUP_REASON_OPENING);

/** Replace this workspace's record and keep every other one. */
const upsert = (task: Task, record: ExternalWorkspaceArchive): ExternalWorkspaceArchive[] =>
  [...task.resolution.externalWorkspaceArchives.filter(item => item.workspaceId !== record.workspaceId), record];

/** Every recorded registration at the task's exact preserved folder. */
const samePathArchives = (task: Task, directory: string) =>
  task.resolution.externalWorkspaceArchives.filter(record => record.directory === directory);

/**
 * Whether the task still owes its preserved catalog archive: not removed, done,
 * merged and synced, and not held from dispatch. It is the one guard every pass,
 * every attempt and the intent writer re-proves, so it is written once.
 */
function owesCatalogArchive(task: Task): boolean {
  return !task.removedAt && task.phase === "done" && Boolean(task.resolution.mergedCommit)
    && Boolean(task.resolution.syncedCommit) && !holdsOf(task).dispatch;
}

/**
 * Whether a recorded entry is a breaker deferral and nothing more: `allowed()` is
 * the only intent writer and runs immediately before `workspace.archive`, so an
 * entry admission deferred never reached Paseo and owes no backoff. The typed
 * flag replaces reading the deferral's words from `detail`.
 */
const isDeferralOnlyRecord = (record: ExternalWorkspaceArchive) => record.deferredByAdmission;

/** An unknown native answer that must be observed, never auto-replayed. */
const isUnknownNativeAnswer = (record: ExternalWorkspaceArchive) =>
  (record.state === "intent" || record.state === "uncertain") && !isDeferralOnlyRecord(record);

/**
 * Whether a recorded entry still waits on its backoff. A record that holds only
 * a breaker deferral never reached Paseo, so it is due on the next admitted pass.
 */
const backedOff = (record: ExternalWorkspaceArchive) =>
  Boolean(record.nextAttemptAt && Date.parse(record.nextAttemptAt) > Date.now())
  && !isDeferralOnlyRecord(record);

/** Whether a recorded entry still owes an attempt now (its own backoff respected). */
const retryIsDue = (record: ExternalWorkspaceArchive | null) =>
  !record || !externalWorkspaceArchiveSettled(record) && !backedOff(record);

/**
 * Whether this pass owes any preserved catalog archive: no recorded outcome for
 * the bound entry, a held/uncertain record whose bounded retry is due, a
 * registration the last complete inventory named without a settled record, or
 * the owner's explicit retry for exactly one workspace. It reads the task
 * record only - no catalog read, adapter call or Git work - so a lifecycle pass
 * with nothing due can decide that before paying for any of it.
 */
export function externalWorkspaceArchiveDue(task: Task, retryWorkspaceId?: string): boolean {
  const bound = preservedExternalWorkspace(task);
  if (!bound) return false;
  if (!owesCatalogArchive(task)) return false;
  const records = task.resolution.externalWorkspaceArchives;
  const samePath = samePathArchives(task, bound.directory);
  // An unknown native answer on this shared path is the only thing that may move:
  // no sibling registration is ever due while one entry's effect is unsettled,
  // and only that entry's bounded observation can settle it.
  const unknown = samePath.filter(record => isUnknownNativeAnswer(record) && !settledByOwner(task, record.workspaceId));
  if (retryWorkspaceId) {
    if (settledByOwner(task, retryWorkspaceId)) return false;
    if (retryWorkspaceId !== bound.workspaceId && !samePath.some(record => record.workspaceId === retryWorkspaceId)) return false;
    // The owner's explicit retry ignores the recorded backoff; every proof below
    // still applies. Another entry's unknown answer still blocks it, because the
    // shared folder's state is not positively known.
    if (unknown.some(record => record.workspaceId !== retryWorkspaceId)) return false;
    const record = records.find(item => item.workspaceId === retryWorkspaceId) ?? null;
    return !record || !externalWorkspaceArchiveSettled(record);
  }
  if (unknown.length) {
    // Only the bounded observation of an unknown entry is owed; one whose
    // recorded backoff has not expired owes nothing at all.
    return unknown.some(record => !(record.nextAttemptAt && Date.parse(record.nextAttemptAt) > Date.now()));
  }
  const boundRecord = records.find(record => record.workspaceId === bound.workspaceId) ?? null;
  if (!boundRecord && !settledByOwner(task, bound.workspaceId)) return true;
  // Every registration the last complete inventory observed must be settled;
  // one entry's archive is never another registration's success.
  const observed = new Set([bound.workspaceId, ...samePath.flatMap(record => record.samePathRegistrations)]);
  for (const workspaceId of observed) {
    const record = records.find(item => item.workspaceId === workspaceId) ?? null;
    if (!settledByOwner(task, workspaceId) && retryIsDue(record)) return true;
  }
  return false;
}

/** One pass's fixed facts: the task, its bound folder and the complete inventory. */
interface ArchivePass {
  ports: ExternalWorkspaceArchivePorts;
  taskId: string;
  bound: { workspaceId: string; directory: string };
  ownedAgentIds: ReadonlySet<string>;
  /** The complete inventory's registrations, or null when the host has no catalog. */
  catalog: ExternalWorkspaceCatalogEntry[] | null;
  /** Every registration this pass may call, the bound entry first. */
  order: string[];
  /** Whether every listed registration sits on a worktree placement, so a folder removal is possible. */
  worktreePath: boolean;
  /** The workspace an owner's explicit `retry_effect` named, or null. */
  ownerRetry: string | null;
}

/** What one registration's turn established: carry on with the next, or stop the pass. */
interface RegistrationTurn {
  task: Task;
  /** True when nothing else at this shared folder may be called this pass. */
  stop: boolean;
}

/**
 * One pass over the catalog registrations at a merged review-entry task's
 * preserved external folder.
 *
 * `retryWorkspaceId` is the owner's explicit `retry_effect`: it ignores the
 * automatic backoff, but every identity, membership and source proof still
 * applies, and an unknown prior answer is observed before anything is replayed.
 */
export async function settleExternalWorkspaceArchive(ports: ExternalWorkspaceArchivePorts, taskId: string, retryWorkspaceId?: string): Promise<Task> {
  const { store, adapter } = ports;
  let task = store.task(taskId);
  const bound = preservedExternalWorkspace(task);
  if (!bound) return task;
  if (!externalWorkspaceArchiveDue(task, retryWorkspaceId)) return task;
  if (ports.paused() || !owesCatalogArchive(task)) return task;
  if (!adapter.archiveExternalWorkspace) return task;
  const ownerRetry = retryWorkspaceId ?? null;
  const runs = store.runs(task.id);
  const ownedAgentIds = taskThreadIdentities(task, runs);

  const inventory = await readCatalogRegistrations(ports, task, bound, runs, ownerRetry);
  if ("task" in inventory) return inventory.task;
  const { entries: catalog } = inventory;
  const listed = new Set((catalog ?? []).map(entry => entry.workspaceId));
  const order = [...new Set([bound.workspaceId, ...(catalog ?? []).map(entry => entry.workspaceId)])];
  if (ownerRetry && !order.includes(ownerRetry)) return task;
  const pass: ArchivePass = {
    ports, taskId, bound, ownedAgentIds, catalog, order,
    worktreePath: Boolean(catalog?.length) && catalog!.every(entry => entry.placement?.kind === "worktree"),
    ownerRetry,
  };

  // The bound entry first, so a folder decision exists before any other
  // registration's call; the rest keep their catalog order.
  for (const workspaceId of [bound.workspaceId, ...order.filter(id => id !== bound.workspaceId)]) {
    const turn = await archiveOneRegistration(pass, workspaceId, listed);
    task = turn.task;
    if (turn.stop) return task;
  }
  return store.task(taskId);
}

/**
 * The complete same-path catalog inventory, or the settled task that stops the
 * pass. Queue must know every registration that points at this exact folder
 * before any call that might remove shared backing; without a complete inventory
 * nothing is called, and the gap is a visible hold rather than a guess.
 */
async function readCatalogRegistrations(
  ports: ExternalWorkspaceArchivePorts, task: Task, bound: { workspaceId: string; directory: string }, runs: Run[], ownerRetry: string | null,
): Promise<{ entries: ExternalWorkspaceCatalogEntry[] | null } | { task: Task }> {
  const { adapter } = ports;
  if (!adapter.externalWorkspaceCatalog) return { entries: null };
  let catalog: ExternalWorkspaceCatalogEntry[] | null = null;
  let unreadableReason: string | null = null;
  try {
    const read = await adapter.externalWorkspaceCatalog(bound.directory);
    if (read.ok) catalog = read.entries; else unreadableReason = read.reason;
  } catch (error) { unreadableReason = error instanceof Error ? error.message : String(error); }
  if (!catalog) {
    if (ownerRetry && ownerRetry !== bound.workspaceId) return { task };
    const record = recordedExternalArchive(task, bound.workspaceId);
    if (record && externalWorkspaceArchiveSettled(record)) return { task };
    return { task: hold(ports, task, record, bound, {
      detail: `The complete same-path catalog inventory could not be established: ${unreadableReason}` }, runs) };
  }
  // An entry whose placement cannot be read may be one Paseo can remove.
  const unreadable = catalog.find(entry => !entry.placement);
  if (unreadable) {
    const detail = `Workspace ${unreadable.workspaceId} at this exact folder has an unreadable placement: ${unreadable.reason ?? "no reason was reported"}`;
    const own = recordedExternalArchive(task, unreadable.workspaceId);
    if (own && externalWorkspaceArchiveSettled(own)) {
      const boundRecord = recordedExternalArchive(task, bound.workspaceId);
      if (boundRecord && externalWorkspaceArchiveSettled(boundRecord)) return { task };
      return { task: hold(ports, task, boundRecord, bound, { detail }, runs) };
    }
    return { task: hold(ports, task, own, { workspaceId: unreadable.workspaceId, directory: bound.directory },
      { detail }, runs, [bound.workspaceId, ...catalog.map(entry => entry.workspaceId)]) };
  }
  // Removal permission is a property of the shared path, not of one entry: a
  // non-worktree registration for this folder keeps the no-removal rule, and a
  // mixed set is never guessed into an archive that could remove the backing.
  const kinds = new Set(catalog.map(entry => entry.placement!.kind));
  if (kinds.size > 1) {
    // The visible cause lands on the first registration that still owes an
    // attempt; a settled entry's history is never rewritten.
    const target = [bound.workspaceId, ...catalog.map(entry => entry.workspaceId)]
      .find(workspaceId => {
        const record = recordedExternalArchive(task, workspaceId);
        return !record || !externalWorkspaceArchiveSettled(record);
      });
    if (!target) return { task };
    return { task: hold(ports, task, recordedExternalArchive(task, target), { workspaceId: target, directory: bound.directory },
      { detail: `Catalog registrations at this folder disagree on placement (${[...kinds].sort().join(", ")}); the no-removal rule keeps the entries` },
      runs, [bound.workspaceId, ...catalog.map(entry => entry.workspaceId)]) };
  }
  return { entries: catalog };
}

/**
 * One registration's turn: skip what is settled or not this pass's, observe an
 * unknown answer before anything else, then re-prove every fence and send at
 * most one native request. A fence, an unknown answer or a failure stops the
 * pass because the shared folder's state is then not positively known.
 */
async function archiveOneRegistration(pass: ArchivePass, workspaceId: string, listed: Set<string>): Promise<RegistrationTurn> {
  const { ports, taskId, bound, catalog, ownerRetry, worktreePath } = pass;
  const { store, adapter } = ports;
  let task = store.task(taskId);
  if (task.removedAt || ports.paused()) return { task, stop: true };
  if (!owesCatalogArchive(task)) return { task, stop: true };
  const record = recordedExternalArchive(task, workspaceId);
  if (settledByOwner(task, workspaceId)) return { task, stop: false };
  if (record && externalWorkspaceArchiveSettled(record)) return { task, stop: false };
  if (ownerRetry && workspaceId !== ownerRetry) return { task, stop: false };
  if (!ownerRetry && record && backedOff(record)) return { task, stop: false };

  // An unknown native answer - a request whose reply never arrived, or one the
  // platform answered ambiguously - is observed against the same catalog
  // operation before anything else. Positively absent means the archive landed;
  // record that and send nothing. Still present proves the earlier request did
  // not take effect, but only an explicit owner retry may replay it; an
  // automatic pass keeps the uncertainty visible instead.
  if (record && isUnknownNativeAnswer(record)) {
    const observation = await observeCatalogEntry(adapter, workspaceId);
    const folderPresent = existsSync(bound.directory);
    if (observation.kind === "absent") {
      return { stop: false, task: settle(ports, task, {
        ...record, state: "archived", folderPresent, settledAt: now(), nextAttemptAt: null, deferredByAdmission: false,
        folderRemovedBy: folderPresent ? null : record.folderRemovedBy ?? (record.folderRemovalAuthorized ? workspaceId : null),
        detail: `${record.detail}; observed absent from the catalog after an unconfirmed answer${!folderPresent && record.folderRemovalAuthorized ? `; the folder is absent under the recorded worktree removal` : ""}`,
      }, "external_workspace_archive_archived") };
    }
    if (!ownerRetry || observation.kind !== "present") {
      const detail = observation.kind === "present"
        ? `A prior catalog archive request (${record.state}) still appears in the catalog; inspect before retrying`
        : `A prior catalog archive request (${record.state}) could not be observed: ${observation.reason}; inspect before retrying`;
      // An unknown answer on this shared path ends the pass: no sibling
      // registration is called until an observation settles it.
      return { stop: true, task: settle(ports, task, { ...record, state: "uncertain", folderPresent, detail, nextAttemptAt: retryAt(record.attempts) }, "external_workspace_archive_uncertain") };
    }
    // The owner's retry observed the same entry still present, so the earlier
    // request provably did not take effect; a fresh attempt below re-proves
    // placement, membership and source and reuses the stable request id.
  }

  if (catalog && !listed.has(workspaceId)) {
    // The complete inventory positively names what the catalog currently
    // lists; an entry it no longer lists is observed absent, not inferred.
    return { stop: false, task: settle(ports, task, observedAbsentRecord(pass, workspaceId), "external_workspace_archive_archived") };
  }

  // Another registration's unknown native answer blocks this call: the shared
  // folder's state is not positively known, so this entry cannot be proven safe
  // to archive (and a worktree removal could destroy the pending effect's
  // evidence). Only its own observation may settle it, on its own pass.
  if (samePathArchives(task, bound.directory).some(other => other.workspaceId !== workspaceId
    && isUnknownNativeAnswer(other) && !settledByOwner(task, other.workspaceId))) return { task: store.task(taskId), stop: true };

  // The task-level fences: every run released, no other live task's run or
  // ownership on this workspace, no host run in the folder, and no thread this
  // task owns serving another task. A hold here protects the folder and stops
  // the pass; the visible cause names it.
  const currentRuns = store.runs(task.id);
  // The cause is recorded against the entry this pass was inspecting, so a
  // sibling registration's hold is never written over the bound entry's
  // settled history (and never silently dropped).
  const target = { workspaceId, directory: bound.directory };
  const fence = heldFence(pass, task, workspaceId, currentRuns);
  if (fence) return { task: hold(ports, task, record, target, { detail: fence }, currentRuns, pass.order), stop: true };

  // The durable removal of this shared folder by an earlier authorized entry:
  // later same-path cleanup rests on that exact chain, never on a new
  // inference that absent files were clean.
  const chain = worktreePath ? removalChain(task, bound.directory, workspaceId) : null;
  const requestId = record?.requestId ?? externalWorkspaceArchiveRequestId(task.id, workspaceId);
  let outcome: ExternalWorkspaceArchiveOutcome;
  try {
    outcome = await adapter.archiveExternalWorkspace!({
      taskId: task.id, workspaceId, directory: bound.directory, ownedAgentIds: pass.ownedAgentIds, requestId,
      expected: { branch: task.branch, baseBranch: task.baseBranch, repository: task.repository ?? null, repoPath: task.repoPath },
      samePathWorkspaceIds: pass.order.filter(id => id !== workspaceId),
      folderRemoval: chain ? { workspaceId: chain.workspaceId, head: chain.source!.head } : null,
      allowed: (observed, participants, source) => {
        const current = store.task(task.id);
        if (ports.paused() || !owesCatalogArchive(current)) return false;
        const latest = preservedExternalWorkspace(current);
        if (!latest || latest.workspaceId !== bound.workspaceId || latest.directory !== bound.directory) return false;
        if (current.workspaceId !== task.workspaceId || current.directory !== task.directory) return false;
        if (store.runs(current.id).some(run => !run.released)) return false;
        if (store.workspaceUsedByOtherTaskRun(current.id, workspaceId)) return false;
        if (store.hostRunHoldingWorkspace(bound.directory)) return false;
        const prior = recordedExternalArchive(current, workspaceId);
        const intent: ExternalWorkspaceArchive = {
          workspaceId, directory: bound.directory, requestId, state: "intent",
          observed, participants, native: null, folderPresent: null,
          source, folderRemovalAuthorized: Boolean(source) || Boolean(chain),
          folderRemovedBy: chain?.workspaceId ?? null,
          samePathRegistrations: pass.order,
          detail: source
            ? "Native catalog archive requested under a freshly proved clean, published worktree source"
            : chain
              ? `Native catalog archive requested under the recorded removal of this shared folder by ${chain.workspaceId}`
              : "Native catalog archive requested",
          attempts: (prior?.attempts ?? 0) + 1, intentAt: now(), settledAt: null, nextAttemptAt: null, deferredByAdmission: false,
        };
        ports.resolution.update(current, { externalWorkspaceArchives: upsert(current, intent) }, {}, "external_workspace_archive_intent", JSON.stringify(intent));
        return true;
      },
    });
  } catch (error: unknown) {
    // Admission throws before allowed() runs, so no native request was sent.
    // A wrapped or ordinary throw stays uncertain: its text is not a classifier.
    if (error instanceof AdmissionDeferred)
      return { stop: true, task: hold(ports, store.task(taskId), record, { workspaceId, directory: bound.directory },
        { detail: error.message, deferred: true }, currentRuns, pass.order) };
    outcome = { status: "uncertain", reason: `${CATALOG_REQUEST_WRAPPER}${error instanceof Error ? error.message : String(error)}` };
  }

  return settleNativeOutcome(pass, task, workspaceId, requestId, outcome);
}

/** The one pre-effect fence that holds this registration's attempt, or null. */
function heldFence(pass: ArchivePass, task: Task, workspaceId: string, runs: Run[]): string | null {
  const { store } = pass.ports;
  if (runs.some(run => !run.released)) return "Waiting for all task runs to release before archiving the catalog entry";
  if (store.workspaceUsedByOtherTaskRun(task.id, workspaceId)) return "Workspace is referenced by another task";
  if (store.hostRunHoldingWorkspace(pass.bound.directory)) return "A host run still holds the preserved workspace";
  const foreign = [...pass.ownedAgentIds].filter(agentId => threadServesAnotherTask(store, task, agentId));
  return foreign.length ? `Thread ${foreign[0]} now serves another task` : null;
}

/** The record of a registration the complete inventory no longer lists. */
function observedAbsentRecord(pass: ArchivePass, workspaceId: string): ExternalWorkspaceArchive {
  const { ports, taskId, bound } = pass;
  const folderPresent = existsSync(bound.directory);
  const chain = removalChain(ports.store.task(taskId), bound.directory, workspaceId);
  return {
    workspaceId, directory: bound.directory, requestId: externalWorkspaceArchiveRequestId(taskId, workspaceId),
    state: "archived", observed: null, participants: [], native: null, folderPresent,
    source: null, folderRemovalAuthorized: Boolean(chain), folderRemovedBy: chain?.workspaceId ?? null,
    samePathRegistrations: pass.order,
    detail: folderPresent
      ? "The catalog entry was already absent when Queue observed it; no archive request was sent and the folder is preserved"
      : chain
        ? `The catalog entry was already absent when Queue observed it; no archive request was sent and the folder is absent under the recorded worktree removal by ${chain.workspaceId}`
        : "The catalog entry was already absent when Queue observed it; no archive request was sent and the folder is also absent",
    attempts: 0, intentAt: null, settledAt: now(), nextAttemptAt: null, deferredByAdmission: false,
  };
}

/**
 * Record the native answer and say whether the pass may carry on: an archived
 * entry settles its own registration, so the next one is called; a failure, a
 * decline and an unsettled answer leave the shared folder not positively known
 * and end the pass.
 */
function settleNativeOutcome(pass: ArchivePass, sent: Task, workspaceId: string, requestId: string, outcome: ExternalWorkspaceArchiveOutcome): RegistrationTurn {
  const { ports, bound } = pass;
  const latest = ports.store.task(sent.id);
  // A decline means a task fence changed between the proofs and the effect;
  // nothing else at this shared folder is called on that state.
  if (outcome.status === "declined") return { task: latest, stop: true };
  const base = recordedExternalArchive(latest, workspaceId) ?? {
    workspaceId, directory: bound.directory, requestId, state: "held" as const, observed: null, participants: [],
    native: null, folderPresent: null, source: null, folderRemovalAuthorized: false, folderRemovedBy: null,
    samePathRegistrations: pass.order, detail: "", attempts: 0, intentAt: null, settledAt: null, nextAttemptAt: null,
    deferredByAdmission: false,
  };
  const attempts = Math.max(base.attempts, 1);
  if (outcome.status === "archived") {
    const removed = !outcome.folderPresent && base.folderRemovalAuthorized;
    const host = HOST_KIND_LABELS[hostKindOf(latest.hostId)];
    return { stop: false, task: settle(ports, latest, {
      ...base, state: "archived", observed: outcome.observed, participants: outcome.participants, native: outcome.native,
      folderPresent: outcome.folderPresent, deferredByAdmission: false,
      folderRemovedBy: removed ? base.folderRemovedBy ?? workspaceId : null,
      detail: outcome.folderPresent
        ? `${host} archived the catalog entry; the folder, its files, the worktree registration and the branch are preserved`
        : removed
          ? `${host} archived the catalog entry and its teardown removed the folder under the freshly proved clean, published worktree permission${base.folderRemovedBy ? ` recorded by ${base.folderRemovedBy}` : ""}`
          : `${host} archived the catalog entry; the folder's state was observed as absent`,
      samePathRegistrations: base.samePathRegistrations.length ? base.samePathRegistrations : pass.order,
      attempts, settledAt: now(), nextAttemptAt: null,
    }, "external_workspace_archive_archived") };
  }
  if (outcome.status === "failed") {
    // A hard, visible failure with no success or preserved-folder claim. It is
    // terminal: a replay cannot undo a removal, so no automatic retry is owed.
    // A failure or an unknown answer stops the pass: the shared folder's state
    // is not positively known, so no sibling registration is called on it.
    return { stop: true, task: settle(ports, latest, {
      ...base, state: "failed", observed: outcome.observed ?? base.observed, participants: outcome.participants ?? base.participants,
      native: outcome.native ?? base.native, folderPresent: existsSync(bound.directory), detail: outcome.reason,
      attempts, settledAt: now(), nextAttemptAt: null, deferredByAdmission: false,
    }, "external_workspace_archive_failed") };
  }
  const state = outcome.status === "uncertain" ? "uncertain" : "held";
  const native = "native" in outcome ? outcome.native ?? base.native : base.native;
  // An unknown answer already counted its attempt at the intent boundary; a
  // pre-effect refusal adds one, so a persistent foreign thread or unreadable
  // inventory escalates its bounded retry instead of polling every minute.
  const heldAttempts = outcome.status === "uncertain" ? attempts : Math.max(base.attempts, 0) + 1;
  // An unknown answer or a pre-effect hold stops the pass for the same reason:
  // nothing else at this shared folder is called on an unsettled observation.
  return { stop: true, task: settle(ports, latest, {
    ...base, state, observed: outcome.observed ?? base.observed, participants: outcome.participants ?? base.participants,
    native, folderPresent: existsSync(bound.directory), detail: outcome.reason,
    attempts: heldAttempts, nextAttemptAt: retryAt(heldAttempts), deferredByAdmission: false,
  }, state === "uncertain" ? "external_workspace_archive_uncertain" : "external_workspace_archive_held") };
}

/** The recorded registrations at this exact folder, with the bound entry always first. */
function samePathRegistrationsFor(task: Task, directory: string): string[] {
  const bound = preservedExternalWorkspace(task);
  return [...new Set([...(bound ? [bound.workspaceId] : []), ...samePathArchives(task, directory).flatMap(record => record.samePathRegistrations)])];
}

/**
 * The exact durable removal of this shared folder by another authorized entry of
 * the same task, or null. It is only read, never inferred: a later registration
 * never treats absent files as a fresh clean proof.
 */
function removalChain(task: Task, directory: string, workspaceId: string): ExternalWorkspaceArchive | null {
  return samePathArchives(task, directory).find(record => record.workspaceId !== workspaceId
    && record.state === "archived" && record.folderRemovalAuthorized && record.folderPresent === false
    && Boolean(record.source?.head)) ?? null;
}

const retryAt = (attempts: number) => new Date(Date.now() + externalArchiveRetryDelay(Math.max(attempts, 1))).toISOString();

/** Record one outcome without ever taking a preserved-folder absence as success. */
function settle(ports: ExternalWorkspaceArchivePorts, task: Task, record: ExternalWorkspaceArchive, event: string): Task {
  const externalWorkspaceArchives = upsert(task, record);
  // A catalog success clears only this effect's own visible cause. Ownership is
  // the line's opening, not a comparison with the cause derived from the current
  // records: a record an owner has since settled drops out of that derivation, so
  // a comparison would keep the cause the owner's settlement made stale. Every
  // other cleanup cause (a runtime retirement, build output, an owned archive, a
  // sibling registration's hold) is left exactly as it was.
  const cleanupReason = !task.resolution.cleanupReason || ownsCleanupReason(task.resolution.cleanupReason)
    ? externalArchiveHoldReason({ ...task, resolution: { ...task.resolution, externalWorkspaceArchives } })
    : task.resolution.cleanupReason;
  return ports.resolution.update(task, { externalWorkspaceArchives, cleanupReason }, {}, event, JSON.stringify(record));
}

/** What left a registration unsettled before any native answer: the visible line, and whether anything was sent. */
interface HoldCause {
  detail: string;
  /** A breaker deferral: admission refused the request, so nothing reached Paseo. */
  deferred?: boolean;
}

/** A pre-effect hold: no native request is sent and the cause stays visible. */
function hold(ports: ExternalWorkspaceArchivePorts, task: Task, record: ExternalWorkspaceArchive | null, bound: { workspaceId: string; directory: string }, cause: HoldCause, runs: Run[], scope?: string[]): Task {
  // Settled history is immutable: a later observation never rewrites an archived
  // or terminal failure into a fresh hold.
  if (record && externalWorkspaceArchiveSettled(record)) return task;
  const attempts = record?.attempts ?? 0;
  const held: ExternalWorkspaceArchive = {
    workspaceId: bound.workspaceId, directory: bound.directory, requestId: record?.requestId ?? externalWorkspaceArchiveRequestId(task.id, bound.workspaceId),
    state: "held", observed: record?.observed ?? null, participants: record?.participants ?? [...taskThreadIdentities(task, runs)],
    native: record?.native ?? null, folderPresent: existsSync(bound.directory), detail: cause.detail,
    source: record?.source ?? null, folderRemovalAuthorized: record?.folderRemovalAuthorized ?? false,
    folderRemovedBy: record?.folderRemovedBy ?? null,
    samePathRegistrations: scope?.length ? scope : record?.samePathRegistrations.length ? record.samePathRegistrations : samePathRegistrationsFor(task, bound.directory),
    attempts, intentAt: record?.intentAt ?? null, settledAt: now(),
    deferredByAdmission: cause.deferred === true,
    nextAttemptAt: cause.deferred ? new Date(Date.now()).toISOString() : retryAt(attempts),
  };
  return settle(ports, task, held, "external_workspace_archive_held");
}

/**
 * What observing the catalog entry alone established: `absent` (positively not
 * listed), `present`, or the unreadable cause. A missing entry is positively
 * observed, never inferred from a timeout.
 */
type CatalogObservation = { kind: "absent" } | { kind: "present" } | { kind: "unreadable"; reason: string };

/** Observe one catalog entry without sending anything. */
async function observeCatalogEntry(adapter: Adapter, workspaceId: string): Promise<CatalogObservation> {
  if (!adapter.taskWorkspaceArchived) return { kind: "unreadable", reason: "catalog observation is unavailable" };
  try { return { kind: await adapter.taskWorkspaceArchived(workspaceId) ? "absent" : "present" }; }
  catch (error) { return { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) }; }
}
