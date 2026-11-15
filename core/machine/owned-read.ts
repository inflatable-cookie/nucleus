/**
 * The one owner-only record read: the same 0600 regular file of this uid that
 * `machine/owned-file.mjs` publishes, opened without following a symlink.
 *
 * The read exists apart from the publication primitive because publication is a
 * plain installer-facing `.mjs` module and reading needs typed answers: a proven
 * absence (the path's own entry is gone: nothing has been written yet) is a
 * different fact from a file that exists but cannot be trusted or decoded, and a
 * caller that reaps, resumes or relaunches on absence must never read the second
 * as the first. Callers that only want the record, or nothing, use the schema
 * parse and keep that tolerant shape themselves.
 */
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";

/** What one owner-only read found: the bytes, a proven absence, or a refusal with its reason. */
export type OwnedFileRead =
  | { kind: "present"; text: string }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

/** What one owner-only JSON read found: the decoded record, a proven absence, or a refusal with its reason. */
export type OwnedJsonRead<T> =
  | { kind: "present"; value: T }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Read one owner-only file without following a symlink; absence and refusal stay distinct. */
export function readOwnedFile(path: string): OwnedFileRead {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "unreadable", reason: `could not be opened: ${describe(error)}` };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { kind: "unreadable", reason: "is not a regular file" };
    const mode = info.mode & 0o777;
    if (mode !== 0o600) return { kind: "unreadable", reason: `has mode 0${mode.toString(8)} instead of 0600` };
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return { kind: "unreadable", reason: "is not owned by this process" };
    return { kind: "present", text: readFileSync(fd, "utf8") };
  } catch (error) {
    return { kind: "unreadable", reason: `could not be read: ${describe(error)}` };
  } finally { closeSync(fd); }
}

/** Read one owner-only JSON record; bytes that do not decode are `unreadable`, never `missing`. */
export function readOwnedJson<T>(path: string, parse: (value: unknown) => T): OwnedJsonRead<T> {
  const read = readOwnedFile(path);
  if (read.kind !== "present") return read;
  try { return { kind: "present", value: parse(JSON.parse(read.text)) }; }
  catch (error) { return { kind: "unreadable", reason: `could not be decoded: ${describe(error)}` }; }
}
