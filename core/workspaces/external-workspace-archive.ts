import { existsSync } from "node:fs";
import { doublingDelay } from "../../shared/backoff";
import { AdmissionDeferred, isBackpressureDeferral } from "../host/admission";
import type { Adapter, ExternalWorkspaceArchiveOutcome, ExternalWorkspaceCatalog, ExternalWorkspaceCatalogEntry } from "../host/adapter";
import { now, type Store } from "../store/store";
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
 */

const RETRY_BASE_MS = 60_000, RETRY_MAX_MS = 60 * 60_000;
/** The wrapper the pre-fix catch put around every adapter throw, including a breaker deferral. */
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

/** The recorded cause of an unresolved catalog archive, for the task's cleanup line. */
export function externalArchiveHoldReason(task: Task): string {
  const record = task.resolution.externalWorkspaceArchives.find(item => (item.state === "held" || item.state === "uncertain" || item.state === "failed") && !settledByOwner(task, item.workspaceId));
  if (!record) return "";
  const prefix = record.state === "failed" ? "External workspace archive failed" : record.state === "uncertain"
    ? "External workspace archive is uncertain; observe before retrying" : "External workspace catalog entry held";
  return `${prefix} for ${record.workspaceId}: ${record.detail}`;
}

/** Replace this workspace's record and keep every other one. */
const upsert = (task: Task, record: ExternalWorkspaceArchive): ExternalWorkspaceArchive[] =>
  [...task.resolution.externalWorkspaceArchives.filter(item => item.workspaceId !== record.workspaceId), record];

/** Every recorded registration at the task's exact preserved folder. */
const samePathArchives = (task: Task, directory: string) =>
  task.resolution.externalWorkspaceArchives.filter(record => record.directory === directory);

/**
 * A recorded entry that never reached Paseo: a current held+bare breaker hold,
 * or the pre-fix shape (uncertain, no intent, wrapped prefix). allowed() is the
 * only intent writer and runs immediately before workspace.archive, so a null
 * intent proves no native request was sent.
 */
function isDeferralOnlyRecord(record: ExternalWorkspaceArchive): boolean {
  if (record.state === "held" && isBackpressureDeferral(record.detail)) return true;
  return record.state === "uncertain"
    && record.intentAt == null
    && record.detail.startsWith(CATALOG_REQUEST_WRAPPER)
    && isBackpressureDeferral(record.detail.slice(CATALOG_REQUEST_WRAPPER.length));
}

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
  if (task.removedAt || task.phase !== "done" || !task.resolution.mergedCommit || !task.resolution.syncedCommit) return false;
  if (holdsOf(task).dispatch) return false;
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
  if (task.removedAt || ports.paused()) return task;
  if (task.phase !== "done" || !task.resolution.mergedCommit || !task.resolution.syncedCommit) return task;
  if (holdsOf(task).dispatch) return task;
  const ownerRetry = retryWorkspaceId != null;
  const runs = store.runs(task.id);
  if (!adapter.archiveExternalWorkspace) return task;
  const ownedAgentIds = taskThreadIdentities(task, runs);

  // The complete same-path catalog inventory is owed before any call that might
  // remove shared backing: Queue must know every registration that points at
  // this exact folder. Without a complete inventory nothing is called, and the
  // gap is a visible hold rather than a guess.
  let catalog: ExternalWorkspaceCatalogEntry[] | null = null;
  if (adapter.externalWorkspaceCatalog) {
    let read: ExternalWorkspaceCatalog;
    try { read = await adapter.externalWorkspaceCatalog(bound.directory); }
    catch (error) { read = { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    if (!read.ok) {
      if (retryWorkspaceId && retryWorkspaceId !== bound.workspaceId) return task;
      const record = recordedExternalArchive(task, bound.workspaceId);
      if (record && externalWorkspaceArchiveSettled(record)) return task;
      return hold(ports, task, record, bound, `The complete same-path catalog inventory could not be established: ${read.reason}`, runs);
    }
    catalog = read.entries;
    // An entry whose placement cannot be read may be one Paseo can remove.
    const unreadable = catalog.find(entry => !entry.placement);
    if (unreadable) {
      const detail = `Workspace ${unreadable.workspaceId} at this exact folder has an unreadable placement: ${unreadable.reason ?? "no reason was reported"}`;
      const own = recordedExternalArchive(task, unreadable.workspaceId);
      if (own && externalWorkspaceArchiveSettled(own)) {
        const boundRecord = recordedExternalArchive(task, bound.workspaceId);
        if (boundRecord && externalWorkspaceArchiveSettled(boundRecord)) return task;
        return hold(ports, task, boundRecord, bound, detail, runs);
      }
      return hold(ports, task, own, { workspaceId: unreadable.workspaceId, directory: bound.directory }, detail, runs,
        [bound.workspaceId, ...catalog.map(entry => entry.workspaceId)]);
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
      if (!target) return task;
      return hold(ports, task, recordedExternalArchive(task, target), { workspaceId: target, directory: bound.directory },
        `Catalog registrations at this folder disagree on placement (${[...kinds].sort().join(", ")}); the no-removal rule keeps the entries`, runs,
        [bound.workspaceId, ...catalog.map(entry => entry.workspaceId)]);
    }
  }
  const listed = new Set((catalog ?? []).map(entry => entry.workspaceId));
  const samePath = [...new Set([bound.workspaceId, ...(catalog ?? []).map(entry => entry.workspaceId)])];
  if (retryWorkspaceId && !samePath.includes(retryWorkspaceId)) return task;
  const worktreePath = Boolean(catalog?.length) && catalog!.every(entry => entry.placement?.kind === "worktree");

  // The bound entry first, so a folder decision exists before any other
  // registration's call; the rest keep their catalog order.
  for (const workspaceId of [bound.workspaceId, ...samePath.filter(id => id !== bound.workspaceId)]) {
    task = store.task(taskId);
    if (task.removedAt || ports.paused()) return task;
    if (task.phase !== "done" || !task.resolution.mergedCommit || !task.resolution.syncedCommit || holdsOf(task).dispatch) return task;
    let record = recordedExternalArchive(task, workspaceId);
    if (settledByOwner(task, workspaceId)) continue;
    if (record && externalWorkspaceArchiveSettled(record)) continue;
    if (ownerRetry && workspaceId !== retryWorkspaceId) continue;
    if (!ownerRetry && record && backedOff(record)) continue;

    // An unknown native answer - a request whose reply never arrived, or one the
    // platform answered ambiguously - is observed against the same catalog
    // operation before anything else. Positively absent means the archive landed;
    // record that and send nothing. Still present proves the earlier request did
    // not take effect, but only an explicit owner retry may replay it; an
    // automatic pass keeps the uncertainty visible instead.
    if (record && isUnknownNativeAnswer(record)) {
      const observed = await observeCatalog(store, adapter, workspaceId);
      const folderPresent = existsSync(bound.directory);
      if (observed === "absent") {
        task = settle(ports, task, {
          ...record, state: "archived", folderPresent, settledAt: now(), nextAttemptAt: null,
          folderRemovedBy: folderPresent ? null : record.folderRemovedBy ?? (record.folderRemovalAuthorized ? workspaceId : null),
          detail: `${record.detail}; observed absent from the catalog after an unconfirmed answer${!folderPresent && record.folderRemovalAuthorized ? `; the folder is absent under the recorded worktree removal` : ""}`,
        }, "external_workspace_archive_archived");
        continue;
      }
      if (!ownerRetry || observed !== "present") {
        const detail = observed === "present"
          ? `A prior catalog archive request (${record.state}) still appears in the catalog; inspect before retrying`
          : `A prior catalog archive request (${record.state}) could not be observed: ${observed}; inspect before retrying`;
        // An unknown answer on this shared path ends the pass: no sibling
        // registration is called until an observation settles it.
        return settle(ports, task, { ...record, state: "uncertain", folderPresent, detail, nextAttemptAt: retryAt(record.attempts) }, "external_workspace_archive_uncertain");
      }
      // The owner's retry observed the same entry still present, so the earlier
      // request provably did not take effect; a fresh attempt below re-proves
      // placement, membership and source and reuses the stable request id.
    }

    if (catalog && !listed.has(workspaceId)) {
      // The complete inventory positively names what the catalog currently
      // lists; an entry it no longer lists is observed absent, not inferred.
      const folderPresent = existsSync(bound.directory);
      const chain = removalChain(task, bound.directory, workspaceId);
      const already: ExternalWorkspaceArchive = {
        workspaceId, directory: bound.directory, requestId: externalWorkspaceArchiveRequestId(task.id, workspaceId),
        state: "archived", observed: null, participants: [], native: null, folderPresent,
        source: null, folderRemovalAuthorized: Boolean(chain), folderRemovedBy: chain?.workspaceId ?? null,
        samePathRegistrations: samePath,
        detail: folderPresent
          ? "The catalog entry was already absent when Queue observed it; no archive request was sent and the folder is preserved"
          : chain
            ? `The catalog entry was already absent when Queue observed it; no archive request was sent and the folder is absent under the recorded worktree removal by ${chain.workspaceId}`
            : "The catalog entry was already absent when Queue observed it; no archive request was sent and the folder is also absent",
        attempts: 0, intentAt: null, settledAt: now(), nextAttemptAt: null,
      };
      task = settle(ports, task, already, "external_workspace_archive_archived");
      continue;
    }

    // Another registration's unknown native answer blocks this call: the shared
    // folder's state is not positively known, so this entry cannot be proven safe
    // to archive (and a worktree removal could destroy the pending effect's
    // evidence). Only its own observation may settle it, on its own pass.
    if (samePathArchives(task, bound.directory).some(other => other.workspaceId !== workspaceId
      && isUnknownNativeAnswer(other) && !settledByOwner(task, other.workspaceId))) return store.task(taskId);

    // The task-level fences: every run released, no other live task's run or
    // ownership on this workspace, no host run in the folder, and no thread this
    // task owns serving another task. A hold here protects the folder and stops
    // the pass; the visible cause names it.
    const currentRuns = store.runs(task.id);
    // The cause is recorded against the entry this pass was inspecting, so a
    // sibling registration's hold is never written over the bound entry's
    // settled history (and never silently dropped).
    const target = { workspaceId, directory: bound.directory };
    if (currentRuns.some(run => !run.released)) return hold(ports, task, record, target, "Waiting for all task runs to release before archiving the catalog entry", currentRuns, samePath);
    if (store.workspaceUsedByOtherTaskRun(task.id, workspaceId)) return hold(ports, task, record, target, "Workspace is referenced by another task", currentRuns, samePath);
    const hostRun = store.hostRunHoldingWorkspace(bound.directory);
    if (hostRun) return hold(ports, task, record, target, "A host run still holds the preserved workspace", currentRuns, samePath);
    const foreign = [...ownedAgentIds].filter(agentId => servesAnotherTask(store, task, agentId));
    if (foreign.length) return hold(ports, task, record, target, `Thread ${foreign[0]} now serves another task`, currentRuns, samePath);

    // The durable removal of this shared folder by an earlier authorized entry:
    // later same-path cleanup rests on that exact chain, never on a new
    // inference that absent files were clean.
    const chain = worktreePath ? removalChain(task, bound.directory, workspaceId) : null;
    const requestId = record?.requestId ?? externalWorkspaceArchiveRequestId(task.id, workspaceId);
    let outcome: ExternalWorkspaceArchiveOutcome;
    try {
      outcome = await adapter.archiveExternalWorkspace({
        taskId: task.id, workspaceId, directory: bound.directory, ownedAgentIds, requestId,
        expected: { branch: task.branch, baseBranch: task.baseBranch, repository: task.repository ?? null, repoPath: task.repoPath },
        samePathWorkspaceIds: samePath.filter(id => id !== workspaceId),
        folderRemoval: chain ? { workspaceId: chain.workspaceId, head: chain.source!.head } : null,
        allowed: (observed, participants, source) => {
          const current = store.task(task.id);
          if (ports.paused() || current.phase !== "done" || !current.resolution.mergedCommit || !current.resolution.syncedCommit) return false;
          if (holdsOf(current).dispatch) return false;
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
            samePathRegistrations: samePath,
            detail: source
              ? "Native catalog archive requested under a freshly proved clean, published worktree source"
              : chain
                ? `Native catalog archive requested under the recorded removal of this shared folder by ${chain.workspaceId}`
                : "Native catalog archive requested",
            attempts: (prior?.attempts ?? 0) + 1, intentAt: now(), settledAt: null, nextAttemptAt: null,
          };
          ports.resolution.update(current, { externalWorkspaceArchives: upsert(current, intent) }, {}, "external_workspace_archive_intent", JSON.stringify(intent));
          return true;
        },
      });
    } catch (error: unknown) {
      // Admission throws before allowed() runs, so no native request was sent.
      // A wrapped or ordinary throw stays uncertain: its text is not a classifier.
      if (error instanceof AdmissionDeferred)
        return hold(ports, store.task(taskId), record, { workspaceId, directory: bound.directory }, error.message, currentRuns, samePath);
      outcome = { status: "uncertain", reason: `${CATALOG_REQUEST_WRAPPER}${error instanceof Error ? error.message : String(error)}` };
    }

    // A decline means a task fence changed between the proofs and the effect;
    // nothing else at this shared folder is called on that state.
    if (outcome.status === "declined") return store.task(taskId);
    const latest = store.task(task.id);
    const base = recordedExternalArchive(latest, workspaceId) ?? {
      workspaceId, directory: bound.directory, requestId, state: "held" as const, observed: null, participants: [],
      native: null, folderPresent: null, source: null, folderRemovalAuthorized: false, folderRemovedBy: null,
      samePathRegistrations: samePath, detail: "", attempts: 0, intentAt: null, settledAt: null, nextAttemptAt: null,
    };
    const attempts = Math.max(base.attempts, 1);
    if (outcome.status === "archived") {
      const removed = !outcome.folderPresent && base.folderRemovalAuthorized;
      task = settle(ports, latest, {
        ...base, state: "archived", observed: outcome.observed, participants: outcome.participants, native: outcome.native,
        folderPresent: outcome.folderPresent,
        folderRemovedBy: removed ? base.folderRemovedBy ?? workspaceId : null,
        detail: outcome.folderPresent
          ? "Paseo archived the catalog entry; the folder, its files, the worktree registration and the branch are preserved"
          : removed
            ? `Paseo archived the catalog entry and its teardown removed the folder under the freshly proved clean, published worktree permission${base.folderRemovedBy ? ` recorded by ${base.folderRemovedBy}` : ""}`
            : "Paseo archived the catalog entry; the folder's state was observed as absent",
        samePathRegistrations: base.samePathRegistrations.length ? base.samePathRegistrations : samePath,
        attempts, settledAt: now(), nextAttemptAt: null,
      }, "external_workspace_archive_archived");
      continue;
    }
    if (outcome.status === "failed") {
      // A hard, visible failure with no success or preserved-folder claim. It is
      // terminal: a replay cannot undo a removal, so no automatic retry is owed.
      // A failure or an unknown answer stops the pass: the shared folder's state
      // is not positively known, so no sibling registration is called on it.
      return settle(ports, latest, {
        ...base, state: "failed", observed: outcome.observed ?? base.observed, participants: outcome.participants ?? base.participants,
        native: outcome.native ?? base.native, folderPresent: existsSync(bound.directory), detail: outcome.reason,
        attempts, settledAt: now(), nextAttemptAt: null,
      }, "external_workspace_archive_failed");
    }
    const state = outcome.status === "uncertain" ? "uncertain" : "held";
    const native = "native" in outcome ? outcome.native ?? base.native : base.native;
    // An unknown answer already counted its attempt at the intent boundary; a
    // pre-effect refusal adds one, so a persistent foreign thread or unreadable
    // inventory escalates its bounded retry instead of polling every minute.
    const heldAttempts = outcome.status === "uncertain" ? attempts : Math.max(base.attempts, 0) + 1;
    // An unknown answer or a pre-effect hold stops the pass for the same reason:
    // nothing else at this shared folder is called on an unsettled observation.
    return settle(ports, latest, {
      ...base, state, observed: outcome.observed ?? base.observed, participants: outcome.participants ?? base.participants,
      native, folderPresent: existsSync(bound.directory), detail: outcome.reason,
      attempts: heldAttempts, nextAttemptAt: retryAt(heldAttempts),
    }, state === "uncertain" ? "external_workspace_archive_uncertain" : "external_workspace_archive_held");
  }
  return store.task(taskId);
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
  // A catalog success clears only this effect's own visible cause; every other
  // cleanup cause (a runtime retirement, build output, an owned archive, a
  // sibling registration's hold) is left exactly as it was.
  const cleanupReason = !task.resolution.cleanupReason || task.resolution.cleanupReason.startsWith("External workspace")
    ? externalArchiveHoldReason({ ...task, resolution: { ...task.resolution, externalWorkspaceArchives } })
    : task.resolution.cleanupReason;
  return ports.resolution.update(task, { externalWorkspaceArchives, cleanupReason }, {}, event, JSON.stringify(record));
}

/** A pre-effect hold: no native request is sent and the cause stays visible. */
function hold(ports: ExternalWorkspaceArchivePorts, task: Task, record: ExternalWorkspaceArchive | null, bound: { workspaceId: string; directory: string }, detail: string, runs: Run[], scope?: string[]): Task {
  // Settled history is immutable: a later observation never rewrites an archived
  // or terminal failure into a fresh hold.
  if (record && externalWorkspaceArchiveSettled(record)) return task;
  const attempts = record?.attempts ?? 0;
  const held: ExternalWorkspaceArchive = {
    workspaceId: bound.workspaceId, directory: bound.directory, requestId: record?.requestId ?? externalWorkspaceArchiveRequestId(task.id, bound.workspaceId),
    state: "held", observed: record?.observed ?? null, participants: record?.participants ?? [...taskThreadIdentities(task, runs)],
    native: record?.native ?? null, folderPresent: existsSync(bound.directory), detail,
    source: record?.source ?? null, folderRemovalAuthorized: record?.folderRemovalAuthorized ?? false,
    folderRemovedBy: record?.folderRemovedBy ?? null,
    samePathRegistrations: scope?.length ? scope : record?.samePathRegistrations.length ? record.samePathRegistrations : samePathRegistrationsFor(task, bound.directory),
    attempts, intentAt: record?.intentAt ?? null, settledAt: now(),
    nextAttemptAt: isBackpressureDeferral(detail) ? new Date(Date.now()).toISOString() : retryAt(attempts),
  };
  return settle(ports, task, held, "external_workspace_archive_held");
}

/** A thread that any other live task binds is not this task's to archive. */
function servesAnotherTask(store: Store, task: Task, agentId: string): boolean {
  if (store.unreleasedRunsForAgent(agentId, task.hostId).length) return true;
  return store.tasks().some(other => other.id !== task.id && (!other.hostId || !task.hostId || other.hostId === task.hostId) && !["done", "cancelled"].includes(other.phase) && !other.removedAt
    && [other.agentId, other.coordinatorAgentId, other.resolution.reviewerAgentId].includes(agentId));
}

/**
 * Observe the catalog entry alone, without sending anything: `absent`,
 * `present`, or the unreadable cause. A missing entry is positively observed,
 * never inferred from a timeout.
 */
async function observeCatalog(store: Store, adapter: Adapter, workspaceId: string): Promise<"absent" | "present" | string> {
  if (!adapter.taskWorkspaceArchived) return "catalog observation is unavailable";
  try { return await adapter.taskWorkspaceArchived(workspaceId) ? "absent" : "present"; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}
