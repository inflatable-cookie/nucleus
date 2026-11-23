import { test } from "./support/sharded-test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Lifecycle } from "../core/closeout/workspace-lifecycle";
import { git } from "../core/git/index";
import { readProcessSubset } from "../core/machine/host-process-listing";
import { terminalArchiveFixture as fixture } from "./support/terminal-archive-fixture";

/** Build output is ignored by its checkout, as in a real repository; the exclude file lives in the shared Git directory. */
async function ignoreBuildOutput(directory: string) {
  const common = resolve(
    directory,
    await git(
      directory,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ),
  );
  await appendFile(join(common, "info", "exclude"), "node_modules/\n");
}

// nucleus#1465: a done, merged task whose build-output cleanup intent was recorded
// (no run) before its process stopped, with no observed result. The next lifecycle
// pass must finish that cleanup and archive the workspace; the stored intent must
// not hold the archive for good.
for (const output of ["present", "absent"] as const)
  test(`a done task with a prior build-output intent (build output ${output}) and no observed result still archives its workspace`, async (t) => {
    const f = await fixture(t);
    f.remote.participant.status = "closed";
    await ignoreBuildOutput(f.directory);
    if (output === "present") {
      await mkdir(join(f.directory, "node_modules"));
      await writeFile(join(f.directory, "node_modules", "generated"), "cache");
    }
    f.updateResolution({
      workspaceArchiveRetries: [],
      cleanupReason: "",
      buildOutputCleanups: [
        {
          workspaceId: "ws",
          directory: f.directory,
          state: "intent",
          detail: "Build output cleanup intent recorded",
          at: new Date().toISOString(),
          observations: [],
        },
      ],
    });
    await new Lifecycle(f.engine).pass();
    const after = f.task();
    assert.equal(
      f.remote.archives.length,
      1,
      JSON.stringify(after.resolution.workspaceArchiveRetries),
    );
    assert.deepEqual(after.resolution.archivedWorkspaceIds, ["ws"]);
    assert.equal(after.resolution.archiveIntentWorkspaceId, null);
    assert.equal(existsSync(f.directory), false);
    assert.equal(
      after.resolution.buildOutputCleanups.find((record) => !record.runId)
        ?.state,
      "complete",
    );
  });

test("a done task with no build-output record archives its clean merged workspace in one lifecycle pass", async (t) => {
  const f = await fixture(t);
  f.remote.participant.status = "closed";
  await ignoreBuildOutput(f.directory);
  await mkdir(join(f.directory, "node_modules"));
  await writeFile(join(f.directory, "node_modules", "generated"), "cache");
  f.updateResolution({ workspaceArchiveRetries: [], cleanupReason: "" });
  await new Lifecycle(f.engine).pass();
  const after = f.task();
  assert.equal(
    f.remote.archives.length,
    1,
    JSON.stringify(after.resolution.workspaceArchiveRetries),
  );
  assert.deepEqual(after.resolution.archivedWorkspaceIds, ["ws"]);
  assert.equal(existsSync(f.directory), false);
});

test("a merged workspace archives on retry after the process using its build output exits", async (t) => {
  const f = await fixture(t);
  f.remote.participant.status = "closed";
  await ignoreBuildOutput(f.directory);
  const output = join(f.directory, "node_modules");
  await mkdir(output);
  const file = join(output, "generated");
  const handle = await open(file, "w");
  const child = spawn(
    process.execPath,
    ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
    { cwd: f.root, stdio: ["ignore", "pipe", "inherit", handle.fd] },
  );
  const exit = once(child, "exit");
  try {
    assert.ok(child.stdout);
    await handle.close();
    await once(child.stdout, "data");
    assert.ok(child.pid);
    const read = await readProcessSubset([child.pid]);
    assert.equal(read.state, "listed");
    assert.ok(read.processes.some((fact) => fact.cwd === f.root && fact.openFiles?.paths.includes(file)));
    f.adapter.hostProcessListing = async () => read.processes;
    f.updateResolution({ workspaceArchiveRetries: [], cleanupReason: "" });

    await new Lifecycle(f.engine).pass();
    assert.ok(existsSync(file));
    assert.equal(f.remote.archives.length, 0);
    const retries = f.task().resolution.workspaceArchiveRetries;
    assert.match(retries.find((retry) => retry.workspaceId === "ws")?.error ?? "", /still uses the workspace or run scratch/);

    child.kill();
    await exit;
    f.adapter.hostProcessListing = async () => [];
    f.updateResolution({ workspaceArchiveRetries: retries.map((retry) => ({
      ...retry,
      nextAttemptAt: new Date(0).toISOString(),
    })) });
    await new Lifecycle(f.engine).pass();
    assert.equal(existsSync(output), false);
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ["ws"]);
    assert.equal(f.remote.archives.length, 1);
  } finally {
    child.kill();
    await exit;
  }
});
