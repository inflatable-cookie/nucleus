import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stableInstalledPath } from "../shared/runtime.mjs";
import { pruneVersions } from "../service/install/main-channel.mjs";

test("a path inside an installed version becomes the stable current link", () => {
  assert.equal(stableInstalledPath("/h/.local/share/nucleus/versions/0.0.0-abc-def/runtime/node"), "/h/.local/share/nucleus/current/runtime/node");
  assert.equal(stableInstalledPath("/h/.local/share/nucleus/versions/0.0.0-abc-def/"), "/h/.local/share/nucleus/current/");
  assert.equal(stableInstalledPath("/h/.local/share/nucleus/current/runtime/node"), "/h/.local/share/nucleus/current/runtime/node");
});

test("pruning keeps the named versions and one other, and leaves links alone", async () => {
  const versions = await mkdtemp(join(tmpdir(), "prune-versions-"));
  for (const name of ["a", "b", "c", "d"]) await mkdir(join(versions, name));
  await mkdir(join(versions, ".stage-x"));
  await symlink("../current", join(versions, "0-old-alias"));
  await pruneVersions(versions, new Set([join(versions, "a")]));
  assert.deepEqual((await readdir(versions)).sort(), [".stage-x", "0-old-alias", "a", "d"]);
  assert.ok((await lstat(join(versions, "0-old-alias"))).isSymbolicLink());
});
