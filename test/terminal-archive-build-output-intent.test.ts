import { test } from "./support/sharded-test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Lifecycle } from "../core/closeout/workspace-lifecycle";
import { git } from "../core/git/index";
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
