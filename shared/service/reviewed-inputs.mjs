/**
 * Papercut 8647384e (2026-11-10): a reviewer verdict refused for a malformed
 * `reviewedInputs` entry became a planner escalation twice — nucleus#1070 (a
 * duplicate path) and nucleus#1098 (a malformed SHA-256). The refusal has to name
 * the exact entry, field and expected shape so the reviewer corrects that field
 * and resends the same verdict instead of reporting blocked. A harmless duplicate
 * — the same entry twice, or the same path with the same digest — is the same
 * reading recorded twice, so it is de-duplicated rather than refused.
 *
 * One rule for both surfaces: the report/completion schema
 * (`shared/schema/review.ts`) and the `nucleus_report` bridge
 * (`bin/mcp-report.mjs`) call these functions, so the words a reviewer reads are
 * the words intake applies.
 */

/** The four accepted entry shapes, named in every refusal. */
export const REVIEWED_INPUT_SHAPES = "{path, sha256}, {directory}, {glob} or {digest, count}";

/** The one wording a refused report carries: correct the named field and resend. */
export const REVIEWED_INPUT_RESEND_RULE = "Correct the named field and resend the same report; a refused report is not a reason to report blocked.";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 512;
const MAX_ENTRY_BYTES = 128 * 1024;

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The repository-relative path rule both surfaces apply to a reviewed input path. */
export function reviewedInputPathProblem(path) {
  if (typeof path !== "string" || !path.length) return "must be a non-empty repository-relative path string";
  if (path.length > 1024) return "must be at most 1024 characters";
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return "must be a normalized repository-relative path";
  if (path.split("/").some(segment => !segment || segment === "." || segment === "..")) return "must be a normalized repository-relative path";
  return null;
}

/** What is wrong with one entry, or null. Names the field and its expected shape. */
export function reviewedInputEntryRefusal(entry) {
  if (!isObject(entry)) return `must be an object of ${REVIEWED_INPUT_SHAPES}`;
  const shape = Object.keys(entry).sort().join(",");
  if (shape === "path,sha256") {
    const path = reviewedInputPathProblem(entry.path);
    if (path) return `path ${path}`;
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256))
      return "sha256 must be 64 lowercase hexadecimal characters (the reviewed file's SHA-256 digest)";
    return null;
  }
  if (shape === "directory" || shape === "glob") {
    const path = reviewedInputPathProblem(entry[shape]);
    if (path) return `${shape} ${path}`;
    return null;
  }
  if (shape === "count,digest") {
    if (typeof entry.digest !== "string" || !SHA256.test(entry.digest))
      return "digest must be 64 lowercase hexadecimal characters (the SHA-256 of the sorted {path, sha256} array)";
    if (!Number.isInteger(entry.count) || entry.count < 1) return "count must be a positive integer";
    return null;
  }
  return `must be exactly one of ${REVIEWED_INPUT_SHAPES}; received keys ${JSON.stringify(shape)}`;
}

const canonical = entry => (isObject(entry)
  ? JSON.stringify(Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])))
  : JSON.stringify(entry));

/** The same reading recorded twice is one entry; the first occurrence keeps its place. */
export function dedupeReviewedInputs(rows) {
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
export function reviewedInputListRefusals(rows) {
  const issues = [];
  if (!Array.isArray(rows)) return issues;
  const entries = dedupeReviewedInputs(rows);
  if (entries.length > MAX_ENTRIES)
    issues.push({ path: [], message: "Summarise reviewedInputs as directories or a digest" });
  entries.forEach((entry, index) => {
    const refusal = reviewedInputEntryRefusal(entry);
    if (refusal) issues.push({ path: [index], message: `reviewedInputs[${index}] ${refusal}` });
  });
  // One path may be recorded once. Two entries that claim different content for
  // the same path are not a harmless duplicate: the reviewer's closure would be
  // ambiguous, so that stays refused with both entries named.
  const firstByPath = new Map();
  entries.forEach((entry, index) => {
    if (!isObject(entry) || typeof entry.path !== "string" || typeof entry.sha256 !== "string") return;
    const first = firstByPath.get(entry.path);
    if (first === undefined) { firstByPath.set(entry.path, index); return; }
    const earlier = entries[first];
    if (isObject(earlier) && earlier.sha256 === entry.sha256) return;
    issues.push({ path: [index, "sha256"], message: `reviewedInputs[${index}].sha256 differs from reviewedInputs[${first}].sha256 for path ${entry.path}; expected one {path, sha256} entry per reviewed file` });
  });
  if (new TextEncoder().encode(JSON.stringify(entries)).byteLength > MAX_ENTRY_BYTES)
    issues.push({ path: [], message: "Reviewed input closure must be at most 128 KiB" });
  return issues;
}
