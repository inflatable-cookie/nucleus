import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ProofFileEntry, ProofFileRecord, Run, Task } from "../../shared/contracts";
import {
  MAX_PROOF_FILE_BYTES, MAX_PROOF_FILE_LABEL, MAX_PROOF_FILES, MAX_PROOF_FILES_TOTAL_BYTES,
  proofFileEntryRefusal,
} from "../../shared/service/proof-files.mjs";
import { now } from "../store/store";

/**
 * nucleus#1142 (papercut 01e88ba5): a worker's proof files reach the retained
 * reviewer, never the public PR.
 *
 * The worker names local files in its report; Nucleus proves each one is a real
 * regular file inside this task's own scratch or worktree, copies it into a
 * per-task, per-head evidence directory under the service scratch it already
 * owns, and records its SHA-256. The retained reviewer's prompt for that head
 * lists the copies with their hashes, so the reviewer opens them from its own
 * session. Nothing is uploaded to the forge and no local path enters a PR body
 * or comment.
 *
 * Evidence lives beside the run scratch the launch already created, so it is
 * pruned with the task's other scratch by the ordinary retention pass. A refused
 * report copies nothing: every entry is proved before the first file is written.
 */

/** A report's proofs are evidence about one exact head; without it they cannot be listed for a reviewer. */
const HEAD = /^[a-f0-9]{40}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_NAME = /[^A-Za-z0-9._-]+/g;

/** The evidence directory's own leaf name under the task's scratch root. */
export const PROOF_EVIDENCE_DIRECTORY = "evidence";

/** A real directory, never a symlink or a redirected ancestor. */
function realDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(directory) === directory;
  } catch { return false; }
}

function inside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The scratch root the recorded run leaf lives under, proved to be the real directory Queue created. */
function scratchRootFor(leaf: string | undefined): string | null {
  if (!leaf || !isAbsolute(leaf) || leaf !== join(leaf)) return null;
  const root = dirname(leaf);
  return isAbsolute(root) && realDirectory(root) ? root : null;
}

/** One file's safe copy name: ordinal, hash prefix and the original basename. */
function evidenceName(index: number, sha256: string, source: string): string {
  const safe = basename(source).replace(SAFE_NAME, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";
  return `${String(index + 1).padStart(2, "0")}-${sha256.slice(0, 8)}-${safe}`;
}

function ensureEvidenceDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!realDirectory(directory)) throw Error(`Nucleus evidence directory ${directory} is not a real directory on its own storage`);
}

/**
 * Validate every named file, then copy them all. Throws before any write when
 * one entry is outside the task, missing, not a regular file or too large, so a
 * refused report leaves nothing behind.
 */
export function recordWorkerProofFiles(input: {
  task: Pick<Task, "id" | "directory" | "temporaryDirectory" | "runId" | "proofFiles">;
  run: Pick<Run, "id" | "temporaryDirectory"> | null;
  files: readonly ProofFileEntry[];
  head: string | null | undefined;
  eventId: string;
}): ProofFileRecord[] {
  const { task, run, files } = input;
  if (!files.length) return [];
  if (files.length > MAX_PROOF_FILES)
    throw Error(`Name at most ${MAX_PROOF_FILES} proof files; a report is evidence, not a file transfer`);
  if (!TASK_ID.test(task.id)) throw Error("This task's identity cannot name an evidence directory");
  if (!input.head || !HEAD.test(input.head))
    throw Error(`A report naming proofFiles must carry the exact 40-character head the evidence belongs to; received ${JSON.stringify(input.head ?? null)}`);
  const head = input.head;
  // The reporting run's own leaf first: a revision or the initial worker both
  // record the scratch directory their launch proved.
  const scratchLeaf = run?.temporaryDirectory ?? task.temporaryDirectory;
  const scratchRoot = scratchRootFor(scratchLeaf);
  if (!scratchRoot)
    throw Error("proofFiles require this task's recorded scratch directory; the report cannot name a file without the scratch Queue created for this run");
  const bases = [...new Set([task.directory, run?.temporaryDirectory, task.temporaryDirectory].filter((value): value is string => Boolean(value)))]
    .filter(realDirectory);
  if (!bases.length) throw Error("proofFiles require this task's own worktree or scratch directory to prove the named paths");

  const planned: { entry: ProofFileEntry; bytes: Buffer; sha256: string }[] = [];
  let total = 0;
  for (const [index, entry] of files.entries()) {
    const refusal = proofFileEntryRefusal(entry);
    if (refusal) throw Error(`proofFiles[${index}] ${refusal}`);
    const source = entry.path;
    if (!isAbsolute(source) || source !== join(source))
      throw Error(`proofFiles[${index}].path must be a normalized absolute path inside this task's own scratch or worktree`);
    let stat;
    try { stat = lstatSync(source); }
    catch { throw Error(`proofFiles[${index}].path ${JSON.stringify(source)} does not exist; name a file this task produced`); }
    if (stat.isSymbolicLink() || !stat.isFile())
      throw Error(`proofFiles[${index}].path must be a regular file inside this task's own scratch or worktree, not a symlink or directory`);
    if (realpathSync(source) !== source)
      throw Error(`proofFiles[${index}].path must name its own real file, not a redirected path`);
    if (stat.size > MAX_PROOF_FILE_BYTES)
      throw Error(`proofFiles[${index}] is ${stat.size} bytes; each proof file must be at most ${MAX_PROOF_FILE_BYTES} bytes`);
    const proven = bases.some(base => inside(realpathSync(base), source));
    if (!proven)
      throw Error(`proofFiles[${index}].path is outside this task's own scratch and worktree; only files this task produced can be delivered as proof`);
    total += stat.size;
    if (total > MAX_PROOF_FILES_TOTAL_BYTES)
      throw Error(`proofFiles total more than ${MAX_PROOF_FILES_TOTAL_BYTES} bytes; name a smaller set of proof files`);
    const bytes = readFileSync(source);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    planned.push({ entry, bytes, sha256 });
  }

  const headDirectory = join(scratchRoot, PROOF_EVIDENCE_DIRECTORY, task.id, head);
  ensureEvidenceDirectory(join(scratchRoot, PROOF_EVIDENCE_DIRECTORY));
  ensureEvidenceDirectory(join(scratchRoot, PROOF_EVIDENCE_DIRECTORY, task.id));
  ensureEvidenceDirectory(headDirectory);
  const at = now();
  const records: ProofFileRecord[] = [];
  for (const [index, item] of planned.entries()) {
    const name = evidenceName(index, item.sha256, item.entry.path);
    const target = join(headDirectory, name);
    writeFileSync(target, item.bytes, { mode: 0o600 });
    records.push({
      head, label: item.entry.label.trim().slice(0, MAX_PROOF_FILE_LABEL), name, path: target,
      sha256: item.sha256, bytes: item.bytes.byteLength,
      runId: run?.id ?? task.runId ?? "", eventId: input.eventId, at,
    });
  }
  return records;
}

/**
 * Remove one task's evidence directories when the ordinary retention pass purges
 * its history. Only a recorded copy path under `scratch/<namespace>/evidence/
 * <task>/<head>/` is removed, and only when every level is a real directory on
 * its own storage; anything else is left in place.
 */
export function removeTaskProofFiles(task: Pick<Task, "id" | "proofFiles">): number {
  if (!TASK_ID.test(task.id)) return 0;
  const heads = new Set<string>();
  for (const record of task.proofFiles) {
    const headDirectory = dirname(record.path);
    const taskDirectory = dirname(headDirectory);
    if (basename(headDirectory) !== record.head || !HEAD.test(record.head)) continue;
    if (basename(taskDirectory) !== task.id || basename(dirname(taskDirectory)) !== PROOF_EVIDENCE_DIRECTORY) continue;
    if (!record.path.includes(`${sep}scratch${sep}`) || !record.path.startsWith(`${headDirectory}${sep}`)) continue;
    heads.add(headDirectory);
  }
  let removed = 0;
  for (const headDirectory of heads) {
    try {
      if (!realDirectory(headDirectory)) continue;
      rmSync(headDirectory, { recursive: true, force: false });
      removed++;
    } catch { /* Retention leaves unknown or occupied evidence in place. */ }
  }
  for (const headDirectory of heads) {
    try {
      const taskDirectory = dirname(headDirectory);
      if (realDirectory(taskDirectory) && realDirectory(dirname(taskDirectory))) rmdirSync(taskDirectory);
    } catch { /* Another head or a concurrent pass keeps the parent. */ }
  }
  return removed;
}
