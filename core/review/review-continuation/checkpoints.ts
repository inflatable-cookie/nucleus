/**
 * The retained reviewer's checkpoint file and its proof. A checkpoint is a
 * progress receipt, never an approval: this owner writes the owner-only file,
 * reads it without rewriting, and re-proves the stored record against the
 * authenticated callback receipt that hashed it. The derivation that decides
 * whether a checkpoint can be continued is `reader.ts`'s.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ReviewCheckpointRecord, Run, Task } from "../../../shared/contracts";
import { briefDigest } from "../../planning/brief";
import { digest, type Store } from "../../store/store";

/** Owner-only per-run directory under the Queue data directory for review checkpoints. */
export const reviewCheckpointRoot = (dataDir: string, taskId: string, runId: string) => join(dataDir, 'review-checkpoints', digest(taskId), runId);
export const reviewCheckpointPath = (dataDir: string, taskId: string, runId: string, ordinal: number) => join(reviewCheckpointRoot(dataDir, taskId, runId), `checkpoint-${ordinal}.json`);
/** The Queue data directory that owns review checkpoints; a memory store has no durable directory. */
export function reviewCheckpointDataDir(store: Pick<Store, 'path'>): string | null {
  return store.path === ':memory:' ? null : dirname(store.path);
}
/** The stable path recorded with an accepted checkpoint, independent of later delivery. */
export function reviewCheckpointPathFor(store: Pick<Store, 'path'>, taskId: string, runId: string, ordinal: number): string {
  // Recorded checkpoints accepted before the rename may sit in the old folder.
  const dataDir = reviewCheckpointDataDir(store) ?? join('.northstar-queue-review-checkpoints');
  return reviewCheckpointPath(dataDir, taskId, runId, ordinal);
}

/** Persist the progress receipt's owner-only file, without creating a delivery intent. */
export function writeReviewCheckpoint(store: Pick<Store, 'path'>, taskId: string, record: ReviewCheckpointRecord) {
  const dataDir = reviewCheckpointDataDir(store);
  if (!dataDir) return;
  const root = reviewCheckpointRoot(dataDir, taskId, record.runId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(record.path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

/** Read, but never rewrite, an exact owner-only checkpoint before operator delivery. */
export function readReviewCheckpoint(store: Pick<Store, 'path'>, taskId: string, record: ReviewCheckpointRecord): ReviewCheckpointRecord {
  const dataDir = reviewCheckpointDataDir(store);
  if (!dataDir) throw new Error('Reviewer checkpoint delivery requires durable Nucleus storage');
  const expected = reviewCheckpointPath(dataDir, taskId, record.runId, record.ordinal);
  if (record.path !== expected) throw new Error('Reviewer checkpoint path does not match its task/run/ordinal identity');
  const stat = statSync(expected);
  if ((stat.mode & 0o077) !== 0) throw new Error('Reviewer checkpoint file permissions are not owner-only');
  const stored = JSON.parse(readFileSync(expected, 'utf8')) as unknown;
  if (!isDeepStrictEqual(stored, record)) throw new Error('Reviewer checkpoint file differs from its authenticated stored record');
  return record;
}

/**
 * The one exact authenticated reviewer-progress checkpoint proof. A stored
 * `reviewCheckpoints` entry is never evidence by itself: this re-reads the
 * owner-only file, the accepted receipt that hashed the recorded callback, its
 * ordinal and progress digest, and the checkpoint's own run/head/brief binding.
 * Returns a precise refusal, or null when the record is authentic for this
 * task and run. Shared by the recovery-effect creation projection, checkpoint
 * retirement and the bounded external-owner recheck, so every gate reads the
 * same proof.
 */
export function reviewCheckpointRefusal(store: Store, task: Task, run: Run, record: ReviewCheckpointRecord): string | null {
  if (record.runId !== run.id) return `checkpoint ${record.ordinal} belongs to run ${record.runId}, not ${run.id}`;
  if (record.head !== run.head) return `checkpoint ${record.ordinal} is at head ${record.head.slice(0, 12)}, not the run head ${run.head.slice(0, 12)}`;
  if (!record.eventId || !record.callbackDigest || !record.checkpointDigest)
    return `checkpoint ${record.ordinal} lacks authenticated callback receipt provenance`;
  try { readReviewCheckpoint(store, task.id, record); }
  catch (error) { return `checkpoint ${record.ordinal} owner-only file is not provable (${error instanceof Error ? error.message : String(error)})`; }
  const row = store.db.prepare('SELECT task,run,hash,response FROM receipts WHERE id=?').get(record.eventId) as
    { task?: string; run?: string; hash?: string; response?: string } | undefined;
  if (!row || row.task !== task.id || row.run !== run.id || row.hash !== record.callbackDigest)
    return `checkpoint ${record.ordinal} callback receipt does not match its task/run identity`;
  let response: { accepted?: unknown; eventId?: unknown; checkpoint?: { ordinal?: unknown; continued?: unknown; checkpointDigest?: unknown } };
  try { response = JSON.parse(String(row.response)); }
  catch { return `checkpoint ${record.ordinal} callback receipt is unreadable`; }
  if (response.accepted !== true || response.eventId !== record.eventId || response.checkpoint?.ordinal !== record.ordinal
    || response.checkpoint.continued !== false || response.checkpoint.checkpointDigest !== record.checkpointDigest
    || digest(JSON.stringify(record.checkpoint)) !== record.checkpointDigest)
    return `checkpoint ${record.ordinal} receipt is not an accepted reviewer progress callback`;
  // The checkpoint's brief is the brief its run held, proved by the task's own
  // stored version: a contradictory version or digest is not evidence.
  const version = record.briefVersion ?? null;
  if (version !== null) {
    const stored = task.briefVersions.find(candidate => candidate.version === version);
    if (!stored || record.briefDigest !== briefDigest(stored.text))
      return `checkpoint ${record.ordinal} brief v${version} does not match the task's stored brief`;
  } else if (record.briefDigest != null) return `checkpoint ${record.ordinal} carries a brief digest without a version`;
  return null;
}
