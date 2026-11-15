/**
 * Owner-only publication and reading, shared by service bootstrap and durable run
 * records. A reader here keeps a proven absence apart from a file it could not
 * read, so a caller that relaunches or reaps on absence can hold instead.
 */
import { randomBytes } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Publish complete bytes from a private, unique file on the target filesystem. */
export function writeAtomicOwnedFile(path, payload, mode = 0o600, options = {}) {
  const temporary = `${path}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  let fd = null;
  let created = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
    created = true;
    fchmodSync(fd, mode);
    writeFileSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd); fd = null;
    if (options.exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
    if (options.syncDirectory !== "none") {
      let directory = null;
      try {
        directory = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
        fsyncSync(directory);
      } catch (error) {
        if (options.syncDirectory === "required") throw error;
      } finally { if (directory !== null) closeSync(directory); }
    }
  } finally {
    if (fd !== null) closeSync(fd);
    if (created) { try { unlinkSync(temporary); } catch { /* already published */ } }
  }
}

export function writeOwnedJson(path, value, options) {
  writeAtomicOwnedFile(path, JSON.stringify(value), 0o600, options);
}

/**
 * Read one owner-only file published by `writeAtomicOwnedFile`, without following
 * a symlink. The answer is the bytes, a proven absence (the path's own entry is
 * gone) or a refusal: a file that exists but is not an owner-only regular file of
 * this uid cannot be read as nothing.
 */
export function readOwnedFile(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    const code = error?.code;
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

/** One owner-only JSON record decoded by `parse`; bytes that do not decode are `unreadable`, never `missing`. */
export function readOwnedJson(path, parse) {
  const read = readOwnedFile(path);
  if (read.kind !== "present") return read;
  try { return { kind: "present", value: parse(JSON.parse(read.text)) }; }
  catch (error) { return { kind: "unreadable", reason: `could not be decoded: ${describe(error)}` }; }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
