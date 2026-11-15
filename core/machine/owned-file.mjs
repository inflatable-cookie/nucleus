/** Owner-only publication, shared by service bootstrap and durable run records. */
import { randomBytes } from "node:crypto";
import { constants, closeSync, fchmodSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
