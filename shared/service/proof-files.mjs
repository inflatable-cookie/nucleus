/**
 * Papercut 01e88ba5 (nucleus#1142): a worker's visual proof had nowhere to go.
 * The worker rendered before-and-after screenshots into its own scratch, kept
 * them off the public PR because they showed live board data, and said they
 * "went to the reviewer through Nucleus". Nothing carried them, so the reviewer
 * judged the proof insufficient twice at the same head and the task parked.
 *
 * A worker report may now name proof files as `{label, path}`. Nucleus validates
 * and copies them into its own per-head evidence directory and lists them, with
 * their hashes, in the retained reviewer's prompt for that head. Nothing is
 * uploaded to the forge.
 *
 * One rule for both surfaces: the report schema (`shared/schema/review.ts`) and
 * the `nucleus_report` bridge (`bin/mcp-report.mjs`) read these functions, so the
 * words a worker reads are the words intake applies. This module owns the shape
 * only; containment inside the task's own scratch or worktree, the regular-file
 * check and the copy belong to `core/intake/proof-files.ts`, which alone reads
 * the task.
 */

/** The one accepted entry shape, named in every refusal. */
export const PROOF_FILE_SHAPE = "{label, path}";

/** The one wording a refused report carries: correct the named field and resend. */
export const PROOF_FILES_RESEND_RULE = "Correct the named field and resend the same report; a refused report is not a reason to report blocked.";

/** Bounded evidence: a handful of screenshots, not a file transfer. */
export const MAX_PROOF_FILES = 12;
export const MAX_PROOF_FILE_LABEL = 120;
export const MAX_PROOF_FILE_PATH = 1024;
/** Per file and per report, so one report cannot fill the scratch volume. */
export const MAX_PROOF_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PROOF_FILES_TOTAL_BYTES = 32 * 1024 * 1024;

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** What is wrong with one entry, or null. Names the field and its expected shape. */
export function proofFileEntryRefusal(entry) {
  if (!isObject(entry)) return `must be an object of ${PROOF_FILE_SHAPE}`;
  const shape = Object.keys(entry).sort().join(",");
  if (shape !== "label,path") return `must be exactly ${PROOF_FILE_SHAPE}; received keys ${JSON.stringify(shape)}`;
  if (typeof entry.label !== "string" || entry.label.trim().length < 1 || entry.label.trim().length > MAX_PROOF_FILE_LABEL)
    return `label must be a non-empty short description of at most ${MAX_PROOF_FILE_LABEL} characters`;
  if (typeof entry.path !== "string" || entry.path.trim().length < 1 || entry.path.length > MAX_PROOF_FILE_PATH)
    return `path must be a local absolute path of at most ${MAX_PROOF_FILE_PATH} characters`;
  if (entry.path.includes("\0")) return "path must not contain a NUL character";
  if (!entry.path.startsWith("/"))
    return "path must be an absolute path inside this task's own scratch or worktree";
  return null;
}

const canonical = entry => (isObject(entry)
  ? JSON.stringify(Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])))
  : JSON.stringify(entry));

/** The same file named twice is one entry; the first occurrence keeps its place. */
export function dedupeProofFiles(rows) {
  if (!Array.isArray(rows)) return rows;
  const seen = new Set();
  return rows.filter(entry => {
    const key = canonical(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every refusal the list carries as `{ path, message }`, in entry order. */
export function proofFileListRefusals(rows) {
  const issues = [];
  if (!Array.isArray(rows)) return issues;
  const entries = dedupeProofFiles(rows);
  if (entries.length > MAX_PROOF_FILES)
    issues.push({ path: [], message: `Name at most ${MAX_PROOF_FILES} proof files; a report is evidence, not a file transfer` });
  entries.forEach((entry, index) => {
    const refusal = proofFileEntryRefusal(entry);
    if (refusal) issues.push({ path: [index], message: `proofFiles[${index}] ${refusal}` });
  });
  return issues;
}
