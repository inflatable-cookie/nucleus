// Run by `find -execdir` (it lives in core/workspaces/ so the backend build identity covers it) inside the directory fts is already in (Queue's owned
// workspace walk, core/workspaces/orphan-worktree.ts). For each entry it opens the name
// relative to that directory, never following a link and only as a directory,
// and gives the owner write and search through that same descriptor. A file or
// link put in its place fails to open. One JSON line per entry; exit 1 on any failure.
import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";

let failed = false;
for (const name of process.argv.slice(2)) {
  try {
    const fd = openSync(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isDirectory()) throw new Error("not a directory");
      if ((stat.mode & 0o300) !== 0o300) fchmodSync(fd, (stat.mode & 0o7777) | 0o300);
    } finally { closeSync(fd); }
    process.stdout.write(`${JSON.stringify({ ok: name })}\n`);
  } catch (error) {
    failed = true;
    process.stdout.write(`${JSON.stringify({ fail: name, reason: error instanceof Error ? error.message : String(error) })}\n`);
  }
}
process.exit(failed ? 1 : 0);
