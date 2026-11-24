import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stableInstalledPath } from "../shared/runtime.mjs";
import {
  liveRollOwnerRoot,
  pruneVersions,
} from "../service/install/main-channel.mjs";

test("a path inside an installed version becomes the stable current link", () => {
  assert.equal(
    stableInstalledPath(
      "/h/.local/share/nucleus/versions/0.0.0-abc-def/runtime/node",
    ),
    "/h/.local/share/nucleus/current/runtime/node",
  );
  assert.equal(
    stableInstalledPath("/h/.local/share/nucleus/versions/0.0.0-abc-def/"),
    "/h/.local/share/nucleus/current/",
  );
  assert.equal(
    stableInstalledPath("/h/.local/share/nucleus/current/runtime/node"),
    "/h/.local/share/nucleus/current/runtime/node",
  );
});

test("pruning keeps the named versions and one other, and leaves links alone", async () => {
  const versions = await mkdtemp(join(tmpdir(), "prune-versions-"));
  for (const name of ["a", "b", "c", "d"]) await mkdir(join(versions, name));
  await mkdir(join(versions, ".stage-x"));
  await symlink("../current", join(versions, "0-old-alias"));
  await pruneVersions(versions, new Set([join(versions, "a")]));
  assert.deepEqual((await readdir(versions)).sort(), [
    ".stage-x",
    "0-old-alias",
    "a",
    "d",
  ]);
  assert.ok((await lstat(join(versions, "0-old-alias"))).isSymbolicLink());
});

test("retention never prunes the version a live roll owner runs from", async () => {
  const scratch = await realpath(
    await mkdtemp(join(await realpath(tmpdir()), "prune-live-owner-")),
  );
  const versions = join(scratch, "versions");
  const dataDir = join(scratch, "data");
  await mkdir(versions, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  for (const name of ["a", "b", "c", "d"]) await mkdir(join(versions, name));
  const claim = (pid: number, root: string) =>
    writeFile(
      join(dataDir, "queue-roll-owner.json"),
      JSON.stringify({ pid, at: new Date().toISOString(), root }),
    );

  // A live owner on b: b survives even though only a is named, c is pruned
  // and d stays as the one other.
  await claim(process.pid, join(versions, "b"));
  assert.equal(await liveRollOwnerRoot(dataDir), join(versions, "b"));
  const keep = new Set([join(versions, "a")]);
  const live = await liveRollOwnerRoot(dataDir);
  if (live) keep.add(live);
  await pruneVersions(versions, keep);
  assert.deepEqual((await readdir(versions)).sort(), ["a", "b", "d"]);

  // A dead owner's heartbeat names nothing: its version prunes normally.
  const probe = spawn(process.execPath, ["--version"]);
  const deadPid = probe.pid!;
  await new Promise((resolve) => probe.on("exit", resolve));
  await claim(deadPid, join(versions, "b"));
  assert.equal(await liveRollOwnerRoot(dataDir), null);

  // Corrupt and rootless heartbeats name nothing either.
  await writeFile(join(dataDir, "queue-roll-owner.json"), "not json");
  assert.equal(await liveRollOwnerRoot(dataDir), null);
  await claim(process.pid, join(versions, "missing"));
  assert.equal(await liveRollOwnerRoot(dataDir), null);
});
