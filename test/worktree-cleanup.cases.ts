import { test, weighted } from "./support/sharded-test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, chmod, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { Lifecycle } from "../core/closeout/workspace-lifecycle";
import { PaseoAdapter } from "../service/paseo-composition";
import { sharedCargoEnvironment } from "../core/machine/cargo-cache";
import { buildOutputCleanupHooks, removeBuildOutput } from "../core/workspaces/worktree-cleanup";
import { completionSchema, runSchema, submissionSchema } from "../shared/contracts";
import { RuntimeRetirementService } from "../core/runtime/runtime-retirement";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import { holdPatch } from "../core/merge/merge-hold";
import { removeOwnedWorktree } from "../core/workspaces/workspace-allocation";
import { normalizeOwnedDirectoryPermissions } from "../core/workspaces/orphan-worktree";
import { HOOK_TEST_TIMEOUT_MS } from "./support/budgets";
import { archiverFor, engineAdapter, git, preservedFixture, settlingAdapter, setup } from "./support/preserved-retirement-fixture";

test("merged closeout removes nested build outputs after workspace thread and Git proofs", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, true, true);
  git(f.repo, "push", "origin", "--delete", f.task.branch);
  const { adapter: archiver, archive } = archiverFor(f);
  const engine = new Engine(f.store, engineAdapter((...args) => archiver.archiveTaskWorkspace!(...args)), 0);
  t.after(() => engine.stop());
  try {
    await new Lifecycle(engine).archive(f.store.task(f.task.id));
    assert.equal(archive.count, 1);
    await assert.rejects(stat(f.target), { code: "ENOENT" });
    await assert.rejects(stat(f.nestedTarget), { code: "ENOENT" });
    await assert.rejects(stat(f.nestedNodeModules), { code: "ENOENT" });
    const cleanup = f.store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.workspaceId === f.task.workspaceId);
    assert.equal(cleanup?.state, "complete");
    assert.match(cleanup?.detail ?? "", /Removed task-local Cargo target output/);
    assert.ok(f.store.events(f.task.id).some(event => event.kind === "workspace_archived"));
  } finally { f.store.close(); }
});

test("cancellation removes nested build outputs only after its pushed head is proved published", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  const { adapter: archiver, archive } = archiverFor(f);
  const engine = new Engine(f.store, engineAdapter((...args) => archiver.archiveTaskWorkspace!(...args)), 0);
  t.after(() => engine.stop());
  try {
    const cancelled = await engine.disposeTask({ taskId: f.task.id, version: f.task.version, action: "cancel", reason: "Duplicate task" });
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(archive.count, 1);
    await assert.rejects(stat(f.target), { code: "ENOENT" });
    await assert.rejects(stat(f.nestedTarget), { code: "ENOENT" });
    await assert.rejects(stat(f.nestedNodeModules), { code: "ENOENT" });
    assert.ok(cancelled.disposition?.effects.some(effect => effect.kind === "remove_build_output" && effect.result?.includes("Removed task-local Cargo target output")));
    assert.equal(cancelled.resolution.buildOutputCleanups.find(item => item.workspaceId === f.task.workspaceId)?.state, "complete");
  } finally { f.store.close(); }
});

test("dirty or unpushed work keeps its target output", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const state of ["dirty", "unpushed"] as const) {
    const f = await setup(t, false, true);
    const { adapter: archiver } = archiverFor(f);
    try {
      if (state === "dirty") await writeFile(join(f.directory, "uncommitted.txt"), "keep");
      else {
        await writeFile(join(f.directory, "src", "task.rs"), "pub fn task_source() -> u8 { 3 }\n");
        git(f.directory, "add", "-A"); git(f.directory, "commit", "-m", "unpushed work");
      }
      const head = git(f.directory, "rev-parse", "HEAD");
      const cleanup = buildOutputCleanupHooks(f.store, f.task.id, f.task.workspaceId!, f.directory, () => true);
      await assert.rejects(archiver.archiveTaskWorkspace(f.store.task(f.task.id), f.task.workspaceId!, f.directory, head, () => true, false, true, new Set(), true, true, cleanup), /uncommitted|unpublished/);
      assert.equal(await stat(f.target).then(() => true), true);
      assert.equal(await stat(f.nestedTarget).then(() => true), true);
      assert.equal(await stat(f.nestedNodeModules).then(() => true), true);
      assert.equal(f.store.task(f.task.id).resolution.buildOutputCleanups.length, 0);
    } finally { f.store.close(); }
  }
});

test("a live workspace agent keeps its target output", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  const live = { id: "live-agent", workspaceId: f.task.workspaceId, labels: { "northstar.task": f.task.id }, status: "running", activeTurn: { id: "turn" } };
  const { adapter: archiver } = archiverFor(f, [live]);
  try {
    const cleanup = buildOutputCleanupHooks(f.store, f.task.id, f.task.workspaceId!, f.directory, () => true);
    await assert.rejects(archiver.archiveTaskWorkspace(f.store.task(f.task.id), f.task.workspaceId!, f.directory, f.head, () => true, false, true, new Set([live.id]), true, true, cleanup), /become idle/);
    assert.equal(await stat(f.target).then(() => true), true);
    assert.equal(await stat(f.nestedTarget).then(() => true), true);
    assert.equal(await stat(f.nestedNodeModules).then(() => true), true);
    assert.equal(f.store.task(f.task.id).resolution.buildOutputCleanups.length, 0);
  } finally { f.store.close(); }
});

test("restart resumes a durable cleanup intent and records the observed removal", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  const cleanupDir = join(f.directory, "target", "debug");
  await writeFile(join(cleanupDir, "partial.bin"), "remaining generated output");
  let hooks = buildOutputCleanupHooks(f.store, f.task.id, f.task.workspaceId!, f.directory, () => true);
  assert.equal(hooks.begin(), "run");
  await rm(join(cleanupDir, "cache.bin")); // Simulate a crash partway through recursive removal.
  f.store.close();
  const store = new Store(join(f.root, "queue.sqlite"));
  try {
    hooks = buildOutputCleanupHooks(store, f.task.id, f.task.workspaceId!, f.directory, () => true);
    assert.equal(hooks.begin(), "run");
    const result = await removeBuildOutput(f.directory);
    hooks.observed(result);
    assert.equal(store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.workspaceId === f.task.workspaceId)?.state, "complete");
    await assert.rejects(stat(f.target), { code: "ENOENT" });
  } finally { store.close(); }
});

test("a cleanup that cannot be proved stays visible and survives terminal retention", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  try {
    const finishedAt = new Date(Date.now() - 15 * 86400000).toISOString();
    f.store.update(f.task.id, {
      phase: "cancelled", finishedAt,
      resolution: {
        ...f.task.resolution, cleanupReason: "Build output cleanup blocked: tracked generated path",
        buildOutputCleanups: [{ workspaceId: f.task.workspaceId!, directory: f.directory, state: "skipped", detail: "Tracked generated path", at: finishedAt }],
      },
    });
    assert.ok(f.store.uiTasks().some(task => task.id === f.task.id), "terminal cleanup finding remains on the board");
    assert.deepEqual(f.store.purgeOldTasks(Date.now() + 15 * 86400000), [], "unsettled output cleanup keeps its task history");
  } finally { f.store.close(); }
});

test("Cargo package-cache sharing preserves existing task-local target output", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  try {
    const cargoHome = join(f.root, "shared-cargo-home");
    assert.deepEqual(sharedCargoEnvironment({ CARGO_HOME: cargoHome }), { CARGO_HOME: cargoHome, CARGO_INCREMENTAL: "0" });
    assert.equal((await lstat(f.target)).isSymbolicLink(), false);
    assert.equal(await readFile(join(f.target, "debug", "cache.bin"), "utf8"), "generated output");
  } finally { f.store.close(); }
});

test("cleanup preserves tracked files hidden under the ignored target directory", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  try {
    const tracked = join(f.target, "tracked.txt");
    await writeFile(tracked, "repository source");
    git(f.directory, "add", "-f", "target/tracked.txt");
    git(f.directory, "commit", "-m", "track target file");
    git(f.directory, "push", "origin", f.task.branch);

    const result = await removeBuildOutput(f.directory);
    assert.equal(result.removed, false);
    assert.equal(result.safe, false);
    assert.match(result.detail, new RegExp(`${f.target}: Git reports tracked files`));
    assert.equal(await readFile(tracked, "utf8"), "repository source");
    assert.equal(await readFile(join(f.target, "debug", "cache.bin"), "utf8"), "generated output");
  } finally { f.store.close(); }
});

test("cleanup preserves a tracked target symlink and its referent", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  try {
    await rm(f.target, { recursive: true, force: true });
    const referent = join(f.root, "outside-target", "fixture");
    await mkdir(referent, { recursive: true });
    await writeFile(join(referent, "artifact.bin"), "outside artifact");
    await symlink(referent, f.target, "dir");
    git(f.directory, "add", "-f", "target");
    git(f.directory, "commit", "-m", "track target symlink");
    git(f.directory, "push", "origin", f.task.branch);

    const result = await removeBuildOutput(f.directory);
    assert.equal(result.removed, false);
    assert.equal(result.safe, false);
    assert.match(result.detail, new RegExp(`${f.target}: Git reports tracked files`));
    assert.equal((await lstat(f.target)).isSymbolicLink(), true);
    assert.equal(await readFile(join(referent, "artifact.bin"), "utf8"), "outside artifact");
  } finally { f.store.close(); }
});

test("cleanup reports the full path and reason for a tracked nested Cargo target", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  try {
    const tracked = join(f.nestedTarget, "tracked.txt");
    await writeFile(tracked, "repository source");
    git(f.directory, "add", "-f", "backend/target/tracked.txt");
    git(f.directory, "commit", "-m", "track nested target file");
    git(f.directory, "push", "origin", f.task.branch);

    const result = await removeBuildOutput(f.directory);
    assert.equal(result.safe, false);
    assert.match(result.detail, new RegExp(`${f.nestedTarget}: Git reports tracked files at or under this build root`));
    assert.equal(await readFile(tracked, "utf8"), "repository source");
    assert.equal(await readFile(join(f.nestedTarget, "debug", "cache.bin"), "utf8"), "nested generated output");
    await assert.rejects(stat(f.target), { code: "ENOENT" });
  } finally { f.store.close(); }
});

test("cleanup discovers a Cargo target-dir override inside the task worktree", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  try {
    await mkdir(join(f.directory, ".cargo"), { recursive: true });
    await writeFile(join(f.directory, ".cargo", "config.toml"), '[build]\n"target-dir" = "task-build"\n');
    git(f.directory, "add", ".cargo/config.toml", ".gitignore");
    git(f.directory, "commit", "-m", "configure local Cargo output");
    git(f.directory, "push", "origin", f.task.branch);
    const configuredTarget = join(f.directory, "task-build");
    await mkdir(join(configuredTarget, "debug"), { recursive: true });
    await writeFile(join(configuredTarget, "debug", "artifact.bin"), "generated output");

    const result = await removeBuildOutput(f.directory);
    assert.equal(result.safe, true);
    assert.match(result.detail, new RegExp(`Removed task-local Cargo target output at .*${configuredTarget}`));
    await assert.rejects(stat(configuredTarget), { code: "ENOENT" });
    await assert.rejects(stat(f.target), { code: "ENOENT" });
  } finally { f.store.close(); }
});

test("a Cargo manifest that cannot resolve in place is noted, its target/ removed, and archival not blocked", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  // Longhorn, 2026-09-30: ~20 staged proof crates are not root-workspace members, so `cargo metadata`
  // fails in place; blocking on that held every Longhorn archive although no output existed.
  const f = await setup(t, false);
  try {
    const brokenRoot = join(f.directory, "broken");
    const configPath = join(brokenRoot, ".cargo", "config.toml");
    await mkdir(join(brokenRoot, ".cargo"), { recursive: true });
    await writeFile(join(brokenRoot, "Cargo.toml"), "[package\nname = \"broken\"\n");
    await writeFile(configPath, "[build]\n");
    git(f.directory, "add", "broken");
    git(f.directory, "commit", "-m", "add invalid nested Cargo manifest");
    git(f.directory, "push", "origin", f.task.branch);
    await mkdir(join(brokenRoot, "target", "debug"), { recursive: true });
    await writeFile(join(brokenRoot, "target", "debug", "artifact"), "x");

    const hooks = buildOutputCleanupHooks(f.store, f.task.id, f.task.workspaceId!, f.directory, () => true);
    assert.equal(hooks.begin(), "run");
    const result = await removeBuildOutput(f.directory);
    hooks.observed(result);
    assert.equal(result.safe, true, result.detail);
    assert.equal(await stat(join(brokenRoot, "target")).then(() => true, () => false), false, "the conventional target/ is still removed");
    assert.match(result.detail, new RegExp(`Unresolved Cargo manifests.*${brokenRoot}: Cargo metadata failed`));
    assert.match(result.detail, new RegExp(configPath));
    assert.equal(f.store.task(f.task.id).resolution.cleanupReason, "", "nothing blocks archival");
  } finally { f.store.close(); }
});

test("Cargo metadata discovers member-local target dirs and reports a blocked removal on the task", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  try {
    const memberRoot = join(f.directory, "backend");
    const configPath = join(memberRoot, ".cargo", "config.toml");
    const memberTarget = join(memberRoot, "member-build");
    await mkdir(join(memberRoot, "src"), { recursive: true });
    await mkdir(join(memberRoot, ".cargo"), { recursive: true });
    await mkdir(memberTarget, { recursive: true });
    const nestedStaleTarget = join(memberRoot, "target");
    await mkdir(join(nestedStaleTarget, "debug"), { recursive: true });
    await writeFile(join(nestedStaleTarget, "debug", "stale.bin"), "stale default output");
    await writeFile(join(memberRoot, "Cargo.toml"), '[package]\nname = "nested-fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    await writeFile(join(memberRoot, "src", "lib.rs"), "pub fn nested_source() {}\n");
    await writeFile(configPath, '[build]\n"target-dir" = "member-build"\n');
    await writeFile(join(f.directory, "Cargo.toml"), '[package]\nname = "cache-fixture"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\nmembers = ["backend"]\n');
    await writeFile(join(f.directory, "Cargo.lock"), 'version = 3\n\n[[package]]\nname = "cache-fixture"\nversion = "0.1.0"\n\n[[package]]\nname = "nested-fixture"\nversion = "0.1.0"\n');
    const trackedOutput = join(memberTarget, "tracked-source.txt");
    await writeFile(trackedOutput, "preserve tracked content");
    git(f.directory, "add", "Cargo.toml", "Cargo.lock", "backend/Cargo.toml", "backend/src/lib.rs", "backend/.cargo/config.toml");
    git(f.directory, "add", "-f", "backend/member-build/tracked-source.txt");
    git(f.directory, "commit", "-m", "add a workspace member target override");
    git(f.directory, "push", "origin", f.task.branch);

    const hooks = buildOutputCleanupHooks(f.store, f.task.id, f.task.workspaceId!, f.directory, () => true);
    assert.equal(hooks.begin(), "run");
    const result = await removeBuildOutput(f.directory);
    hooks.observed(result);
    assert.equal(result.safe, false);
    assert.match(result.detail, new RegExp(`${memberTarget}: Git reports tracked files at or under this build root`));
    assert.match(result.detail, new RegExp(`Cargo package root ${memberRoot}`));
    assert.match(result.detail, new RegExp(`workspace root ${f.directory}`));
    assert.match(result.detail, new RegExp(configPath));
    assert.match(f.store.task(f.task.id).resolution.cleanupReason, new RegExp(`${memberTarget}.*${configPath}`));
    assert.equal(await readFile(trackedOutput, "utf8"), "preserve tracked content");
    await assert.rejects(stat(f.target), { code: "ENOENT" });
    await assert.rejects(stat(nestedStaleTarget), { code: "ENOENT" });
  } finally { f.store.close(); }
});

test("an intermediate symlink in a configured target path is skipped without deleting its tracked target", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  try {
    const configPath = join(f.directory, ".cargo", "config.toml");
    const realTarget = join(f.directory, "real-output", "target");
    const targetAlias = join(f.directory, "target-alias");
    const tracked = join(realTarget, "tracked.txt");
    await mkdir(join(f.directory, ".cargo"), { recursive: true });
    await mkdir(realTarget, { recursive: true });
    await writeFile(configPath, '[build]\n"target-dir" = "target-alias/target"\n');
    await writeFile(tracked, "preserve through alias");
    await symlink("real-output", targetAlias);
    git(f.directory, "add", ".cargo/config.toml", "target-alias", "real-output");
    git(f.directory, "add", "-f", "real-output/target/tracked.txt");
    git(f.directory, "commit", "-m", "configure a target path through a symlink");
    git(f.directory, "push", "origin", f.task.branch);

    const hooks = buildOutputCleanupHooks(f.store, f.task.id, f.task.workspaceId!, f.directory, () => true);
    assert.equal(hooks.begin(), "run");
    const result = await removeBuildOutput(f.directory);
    hooks.observed(result);
    const aliasTarget = join(targetAlias, "target");
    assert.equal(result.safe, false);
    assert.match(result.detail, new RegExp(`${aliasTarget}: Build output path traverses an intermediate symlink to ${realTarget}`));
    assert.match(result.detail, new RegExp(configPath));
    assert.match(f.store.task(f.task.id).resolution.cleanupReason, new RegExp(`${aliasTarget}.*${configPath}`));
    assert.equal(await readFile(tracked, "utf8"), "preserve through alias");
  } finally { f.store.close(); }
});

test("Cargo metadata target directories outside the worktree block cleanup with config context", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  try {
    const configPath = join(f.directory, ".cargo", "config.toml");
    await mkdir(join(f.directory, ".cargo"), { recursive: true });
    await writeFile(configPath, '[build]\ntarget-dir = "../external-target"\n');
    git(f.directory, "add", ".cargo/config.toml");
    git(f.directory, "commit", "-m", "configure external Cargo output");
    git(f.directory, "push", "origin", f.task.branch);
    const externalTarget = join(dirname(f.directory), "external-target");
    await mkdir(externalTarget, { recursive: true });
    await writeFile(join(externalTarget, "artifact.bin"), "external generated output");

    const hooks = buildOutputCleanupHooks(f.store, f.task.id, f.task.workspaceId!, f.directory, () => true);
    assert.equal(hooks.begin(), "run");
    const result = await removeBuildOutput(f.directory);
    hooks.observed(result);
    assert.equal(result.safe, false);
    assert.match(result.detail, new RegExp(`${externalTarget}: Cargo package root ${f.directory}.*selected target directory is outside`));
    assert.match(result.detail, new RegExp(configPath));
    assert.match(f.store.task(f.task.id).resolution.cleanupReason, new RegExp(`${externalTarget}.*${configPath}`));
    assert.equal(await readFile(join(externalTarget, "artifact.bin"), "utf8"), "external generated output");
  } finally { f.store.close(); }
});

weighted(5)("an operator can retry a skipped cancelled cleanup after its blocker is removed", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  const tracked = join(f.target, "tracked.txt");
  await writeFile(tracked, "preserve until operator removes blocker");
  git(f.directory, "add", "-f", "target/tracked.txt");
  git(f.directory, "commit", "-m", "track build output blocker");
  git(f.directory, "push", "origin", f.task.branch);
  const { adapter: archiver, archive } = archiverFor(f);
  const engine = new Engine(f.store, engineAdapter((...args) => archiver.archiveTaskWorkspace!(...args)), 0);
  t.after(() => engine.stop());
  try {
    const cancelled = await engine.disposeTask({ taskId: f.task.id, version: f.store.task(f.task.id).version, action: "cancel", reason: "Close this task" });
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(archive.count, 0);
    assert.equal(cancelled.resolution.buildOutputCleanups.find(item => item.workspaceId === f.task.workspaceId)?.state, "skipped");
    assert.match(cancelled.resolution.cleanupReason, new RegExp(`^Build output cleanup blocked: .*${f.target}`));

    git(f.directory, "rm", "target/tracked.txt");
    git(f.directory, "commit", "-m", "remove build output blocker");
    git(f.directory, "push", "origin", f.task.branch);
    const retried = await engine.performTaskControl({ taskId: f.task.id, version: cancelled.version, action: "retry_effect", effect: `build_output_cleanup.${cancelled.workspaceId}`, reason: "Retry the skipped cleanup" });
    assert.equal(retried.disposition?.workspaceArchived, true);
    assert.equal(archive.count, 1);
    assert.equal(retried.resolution.buildOutputCleanups.find(item => item.workspaceId === f.task.workspaceId)?.state, "complete");
    assert.equal(retried.resolution.cleanupReason, "");
    await assert.rejects(stat(f.target), { code: "ENOENT" });
    await assert.rejects(stat(f.nestedTarget), { code: "ENOENT" });
    await assert.rejects(stat(f.nestedNodeModules), { code: "ENOENT" });
  } finally { f.store.close(); }
});

test("two source revisions keep task-local Cargo executables while sharing downloaded packages", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  try {
    await rm(f.target, { recursive: true, force: true });
    const second = join(f.worktreeRoot, "ns-sibling-fixture");
    git(f.repo, "worktree", "add", "--detach", second, "main");
    for (const directory of [f.directory, second]) {
      git(directory, "config", "user.name", "Queue tests");
      git(directory, "config", "user.email", "queue@example.invalid");
    }
    await writeFile(join(f.directory, "src", "main.rs"), 'fn main() { println!("revision-one"); }\n');
    git(f.directory, "add", "src/main.rs");
    git(f.directory, "commit", "-m", "revision one");
    await writeFile(join(second, "src", "main.rs"), 'fn main() { println!("revision-two"); }\n');
    git(second, "add", "src/main.rs");
    git(second, "commit", "-m", "revision two");
    assert.notEqual(git(f.directory, "rev-parse", "HEAD"), git(second, "rev-parse", "HEAD"));

    const cargoHome = join(f.root, "shared-cargo-home");
    const cargoEnv = { ...process.env, ...sharedCargoEnvironment({ CARGO_HOME: cargoHome }) };
    assert.equal(cargoEnv.CARGO_HOME, cargoHome);
    delete cargoEnv.CARGO_TARGET_DIR;
    const build = (cwd: string) => execFileSync("cargo", ["build", "--quiet"], { cwd, env: cargoEnv, encoding: "utf8" });
    build(f.directory);
    build(second);

    const firstTarget = join(f.directory, "target");
    const secondTarget = join(second, "target");
    assert.equal((await lstat(firstTarget)).isSymbolicLink(), false, "first revision keeps a local target directory");
    assert.equal((await lstat(secondTarget)).isSymbolicLink(), false, "second revision keeps a local target directory");
    const firstBinary = join(firstTarget, "debug", "cache-fixture");
    const secondBinary = join(secondTarget, "debug", "cache-fixture");
    assert.equal(execFileSync(firstBinary, [], { encoding: "utf8" }).trim(), "revision-one");
    assert.equal(execFileSync(secondBinary, [], { encoding: "utf8" }).trim(), "revision-two");
  } finally { f.store.close(); }
});

function authorBlocked(f: Awaited<ReturnType<typeof setup>>, eventId: string) {
  const completion = completionSchema.parse({ eventId, taskId: f.task.id, runId: f.task.runId!, status: "blocked", summary: "Blocked on a dependency" });
  f.store.setCredential(f.task.runId!, "run-token");
  f.store.acceptCompletion(completion, "run-token", null);
  f.store.update(f.task.id, { phase: "blocked" });
}

test('retry_effect retires a preserved cancelled workspace without changing its disposition or holds', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await preservedFixture(t);
  try {
    const before = f.store.update(f.task.id, holdPatch(f.cancelled, 'merge', 'owner', 'Acceptance still owed'));
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, before));
    assert.ok(next.verbs.some(verb => verb.args?.effect === `workspace_archive.${before.workspaceId}`));
    const result = await f.retry();
    assert.equal(result.resolution.workspaceRetirement?.state, 'archived');
    assert.deepEqual(result.disposition, f.cancelled.disposition);
    assert.deepEqual(result.holds, before.holds);
    assert.equal(result.phase, 'cancelled');
    assert.equal(result.reason, f.cancelled.reason);
    assert.equal(f.archive.count, 1);
    assert.ok(result.resolution.archivedWorkspaceIds.includes(f.task.workspaceId!));
    assert.equal(git(f.repo, 'ls-remote', 'origin', `refs/heads/${f.task.branch}`).split(/\s/)[0], f.head);
    await assert.rejects(f.retry(), /No recorded side effect/);
    assert.equal(f.archive.count, 1, 'duplicate owner control never archives twice');
  } finally { await f.close(); }
});

weighted(19)('preserved retirement refuses unsafe source, ownership, participants and retention through retry_effect', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const shape of ['dirty', 'unpublished', 'shared', 'foreign-workspace', 'active', 'permission', 'unknown', 'live-tool', 'unreleased', 'dispatch-hold', 'retention', 'open-pr', 'unmerged-proof'] as const) {
    await t.test(shape, async t => {
      const f = await preservedFixture(t, [], true);
      f.archive.catalogued = false;
      try {
        if (shape === 'dirty') await writeFile(join(f.directory, 'src', 'task.rs'), 'dirty source');
        if (shape === 'unpublished') { await writeFile(join(f.directory, 'unpublished.txt'), 'keep'); git(f.directory, 'add', '.'); git(f.directory, 'commit', '-m', 'local only'); }
        if (shape === 'shared') {
          const other = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Shared', repoPath: f.repo,
            planningCommit: f.base, handoffPath: 'other.md', originAgentId: 'origin' }), 'host', 'other', f.base);
          f.store.update(other.id, { phase: 'cancelled', workspaceId: f.task.workspaceId });
        }
        if (['active', 'permission', 'unknown', 'foreign-workspace'].includes(shape)) f.adapter.observe = async id => {
          if (shape === 'unknown') throw Error('Observation unavailable');
          return { id, workspaceId: shape === 'foreign-workspace' ? 'elsewhere' : f.task.workspaceId, status: 'idle',
            active: shape === 'active', permissions: shape === 'permission', error: '' };
        };
        if (shape === 'live-tool') f.adapter.agentTimelinePage = async () => ({ hasOlder: false, gap: false, entries: [{ timestamp: new Date().toISOString(), item: { type: 'tool_call', callId: 'live-tool', status: 'running', name: 'exec', detail: { type: 'shell', command: 'validation' } } }] });
        if (shape === 'unreleased') f.store.putRun(runSchema.parse({ id: 'unfinished', taskId: f.task.id, role: 'revision', generation: 1,
          head: f.head, base: f.base, agentId: f.task.agentId, workspaceId: f.task.workspaceId, profile: null,
          status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false }));
        if (shape === 'dispatch-hold') f.store.update(f.task.id, holdPatch(f.cancelled, 'dispatch', 'owner', 'Keep workspace'));
        if (shape === 'retention') f.engine.hooks.retentionGate = async () => ({ hold: true, attention: false, records: [] });
        if (shape === 'open-pr') f.adapter.findAnyOpenBranchPr = async () => [{ number: 1, url: 'https://example.invalid/pr/1' }];
        if (shape === 'unmerged-proof') f.adapter.verifyCancelledWorkspacePr = async () => { throw Error('PR is merged or unknown'); };
        const result = await f.retry();
        assert.equal(result.resolution.workspaceRetirement?.state, 'held', result.resolution.workspaceRetirement?.detail);
        assert.equal(result.phase, 'cancelled');
        assert.deepEqual(result.disposition, f.cancelled.disposition);
        assert.equal(f.archive.count, 0);
        await stat(f.target);
        assert.ok(f.store.uiTasks().some(task => task.id === f.task.id), 'blocked cleanup remains visible');
        assert.ok(!f.store.purgeOldTasks(Date.now() + 15 * 86400000).includes(f.task.id));
      } finally { await f.close(); }
    });
  }
});

weighted(12)('adapter pre-effect refusals remain held and retry_effect recovers after repair', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const shape of ['unrelated-thread', 'non-idle-thread', 'dirty', 'unpublished', 'ownership'] as const) await t.test(shape, async t => {
    const agents: unknown[] = [];
    const f = await preservedFixture(t, agents);
    try {
      const archive = f.adapter.archiveTaskWorkspace!;
      // Introduce the refusal after the outer proof, inside the real adapter's
      // preflight. This must not create a workspace archive intent.
      f.adapter.archiveTaskWorkspace = async (...args) => {
        if (shape === 'unrelated-thread') agents.push({ id: 'foreign', workspaceId: f.task.workspaceId, status: 'idle' });
        if (shape === 'non-idle-thread') agents.push({ id: f.task.agentId, workspaceId: f.task.workspaceId, status: 'running' });
        if (shape === 'dirty') await writeFile(join(f.directory, 'src', 'task.rs'), 'late dirty source');
        if (shape === 'unpublished') git(f.repo, 'push', 'origin', '--delete', f.task.branch);
        if (shape === 'ownership') f.workspace.worktreeSlug = 'unrelated-checkout';
        return archive(...args);
      };
      const refused = await f.retry();
      assert.equal(refused.resolution.workspaceRetirement?.state, 'held', refused.resolution.workspaceRetirement?.detail);
      assert.equal(refused.resolution.workspaceRetirement?.intentAt, null);
      assert.equal(f.archive.count, 0);
      assert.equal(f.store.events(f.task.id).filter(event => event.kind === 'workspace_retirement_intent').length, 0);
      await stat(f.target);
      assert.deepEqual(refused.disposition, f.cancelled.disposition);
      assert.ok(ownerTaskNext(collectOwnerVerbFacts(f.store, refused)).verbs.some(verb => verb.available && verb.args?.effect === `workspace_archive.${f.task.workspaceId}`));

      f.adapter.archiveTaskWorkspace = archive;
      agents.length = 0;
      git(f.directory, 'restore', 'src/task.rs');
      git(f.directory, 'push', 'origin', f.task.branch);
      f.workspace.worktreeSlug = f.task.branch;
      const recovered = await f.retry();
      assert.equal(recovered.resolution.workspaceRetirement?.state, 'archived');
      assert.equal(f.archive.count, 1);
      assert.deepEqual(recovered.disposition, f.cancelled.disposition);
    } finally { await f.close(); }
  });
});

test('retirement records intent before archive and observes a lost reply after restart without replay', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await preservedFixture(t);
  try {
    const archive = f.adapter.archiveTaskWorkspace!;
    f.adapter.archiveTaskWorkspace = async (...args) => {
      assert.equal(f.store.task(f.task.id).resolution.workspaceRetirement?.intentAt, null, 'adapter preflight is not archive delivery');
      assert.ok(f.store.task(f.task.id).resolution.runtimeRetirements.length);
      await archive(...args);
      assert.equal(f.store.task(f.task.id).resolution.workspaceRetirement?.state, 'intent');
      throw Error('Reply lost');
    };
    const unknown = await f.retry();
    assert.equal(unknown.resolution.workspaceRetirement?.state, 'uncertain');
    assert.equal(f.archive.count, 1);
    await f.engine.stop();
    const reopened = new Store(join(f.root, 'queue.sqlite'));
    const restarted = new Engine(reopened, f.adapter, 0, undefined, new RuntimeRetirementService(reopened, f.runtime.invoke));
    try {
      assert.ok(reopened.lifecycleTasks().some(task => task.id === f.task.id));
      await restarted.scheduleRunBuildOutputs(f.task.id);
      assert.equal(reopened.task(f.task.id).resolution.workspaceRetirement?.state, 'archived');
      assert.deepEqual(reopened.task(f.task.id).disposition, f.cancelled.disposition);
      assert.equal(f.archive.count, 1);
    } finally { await restarted.stop(); reopened.close(); }
  } finally { await f.close(); }
});

test('unknown archive delivery waits for observation and a present workspace retries with fresh proofs', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await preservedFixture(t);
  try {
    f.archive.failure = 'worktree.teardown failed';
    const first = await f.retry();
    assert.equal(first.resolution.workspaceRetirement?.state, 'uncertain');
    assert.equal(first.resolution.runtimeRetirements[0]?.state, 'failed');
    f.adapter.taskWorkspaceArchived = async () => { throw Error('Workspace observation unavailable'); };
    const retried = await f.retry();
    assert.equal(retried.resolution.workspaceRetirement?.state, 'uncertain');
    assert.equal(f.archive.count, 1);
    f.adapter.taskWorkspaceArchived = async () => true;
    const catalogOnly = await f.retry();
    assert.equal(catalogOnly.resolution.workspaceRetirement?.state, 'uncertain');
    assert.match(catalogOnly.resolution.workspaceRetirement?.detail ?? '', /uncertain; inspect/);
    assert.equal(catalogOnly.resolution.archivedWorkspaceIds.length, 0);
    f.adapter.taskWorkspaceArchived = async () => false;
    f.archive.failure = null;
    // A positive present observation does not bypass source checks.
    await writeFile(join(f.directory, 'src', 'task.rs'), 'new local source');
    const held = await f.retry();
    assert.equal(held.resolution.workspaceRetirement?.state, 'held');
    assert.equal(held.resolution.workspaceRetirement?.intentAt, null);
    assert.equal(f.archive.count, 1);
    git(f.directory, 'restore', 'src/task.rs');
    const recovered = await f.retry();
    assert.equal(recovered.resolution.workspaceRetirement?.state, 'archived');
    assert.equal(recovered.resolution.runtimeRetirements[0]?.state, 'none');
    assert.equal(f.archive.count, 2);
    assert.deepEqual(f.archive.requests, Array(2).fill(`ns-archive-${f.task.id}-${f.task.workspaceId}`), 'observed-present retry reuses the native idempotency identity');
    assert.deepEqual(recovered.disposition, f.cancelled.disposition);
  } finally { await f.close(); }
});

test('confirmed archive retains a failed runtime proof separately from archive success', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await preservedFixture(t);
  try {
    const scope = 'a'.repeat(32);
    const runtime = new RuntimeRetirementService(f.store, async args => args[1] === 'scope'
      ? { code: 0, timedOut: false, spawnError: '', output: JSON.stringify({ scope: { kind: 'worktree', token: scope } }) }
      : { code: 1, timedOut: false, spawnError: '', output: 'retire failed' });
    // Capture through the service used by the engine; a failed proof must remain durable.
    await runtime.capture(f.task.id, f.task.workspaceId!, f.directory);
    f.runtime.prove = runtime.prove.bind(runtime);
    const result = await f.retry();
    assert.equal(result.resolution.workspaceRetirement?.state, 'archived');
    assert.equal(result.resolution.runtimeRetirements[0]?.state, 'failed');
    assert.match(result.resolution.workspaceRetirement?.detail ?? '', /Workspace archived; runtime retirement failed/);
    assert.equal(f.archive.count, 1);
  } finally { await f.close(); }
});

test('terminal phase alone cannot supersede an unapplied author result', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
  try {
    authorBlocked(f, 'original-result');
    const later = completionSchema.parse({ eventId: 'unproven-revision', taskId: f.task.id, runId: 'unproven-run',
      status: 'ready_for_review', prNumber: 1, head: f.head, summary: 'No authentic receipt' });
    f.store.putRun(runSchema.parse({ id: later.runId, taskId: f.task.id, role: 'revision', generation: 1,
      head: f.head, base: f.base, agentId: 'later-author', workspaceId: f.task.workspaceId, profile: null,
      status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: later, released: true }));
    f.store.update(f.task.id, { phase: 'done', completion: later });
    await engine.settleRunBuildOutputs(f.task.id);
    const record = f.store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.runId === f.task.runId);
    assert.equal(record?.state, 'intent');
    assert.match(record?.detail ?? '', /not applied/);
    await stat(f.target);
  } finally { await engine.stop(); f.store.close(); }
});

test('run output cleanup observes released participants and other tasks same-workspace leases', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  const adapter = settlingAdapter(f, { active: false });
  const observe = adapter.observe;
  let active = true;
  adapter.observe = async id => ({ ...await observe(id), active: id === 'retained-reviewer' && active });
  const engine = new Engine(f.store, adapter, 0);
  try {
    authorBlocked(f, 'author-with-history');
    const released = runSchema.parse({ id: 'old-review', taskId: f.task.id, role: 'reviewer', generation: 1,
      head: f.head, base: f.base, agentId: 'retained-reviewer', workspaceId: f.task.workspaceId, profile: null,
      status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: true });
    f.store.putRun(released);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, reviewerAgentId: released.agentId } });
    await engine.settleRunBuildOutputs(f.task.id);
    await stat(f.target);
    assert.match(f.store.task(f.task.id).resolution.buildOutputCleanups[0]!.detail, /retained-reviewer.*active/);
    active = false;
    const other = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Another lease', repoPath: f.repo,
      planningCommit: f.base, handoffPath: 'other.md', originAgentId: 'origin' }), 'host', 'other', f.base);
    f.store.putRun({ ...released, id: 'foreign-lease', taskId: other.id, released: false });
    await engine.settleRunBuildOutputs(f.task.id);
    await stat(f.target);
    assert.match(f.store.task(f.task.id).resolution.buildOutputCleanups[0]!.detail, /foreign-lease.*unreleased/);
    f.store.putRun({ ...f.store.run('foreign-lease')!, released: true });
    await engine.settleRunBuildOutputs(f.task.id);
    await stat(f.target);
    assert.match(f.store.task(f.task.id).resolution.buildOutputCleanups[0]!.detail, /referenced by another task/);
  } finally { await engine.stop(); f.store.close(); }
});

test('a pinned reviewer in its own workspace does not fence task-workspace output cleanup', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  const adapter = settlingAdapter(f, { active: false });
  const observe = adapter.observe;
  const reviewerId = 'pinned-reviewer', reviewerWorkspace = 'wks_0123456789abcdef';
  const reviewerDirectory = join(f.root, 'review-view');
  const reviewerOutput = join(reviewerDirectory, 'node_modules');
  await mkdir(reviewerOutput, { recursive: true });
  await writeFile(join(reviewerOutput, 'kept.txt'), 'review view output');
  const observed: string[] = [];
  adapter.observe = async id => {
    observed.push(id);
    return id === reviewerId ? { ...await observe(id), workspaceId: reviewerWorkspace, status: 'running', active: true } : observe(id);
  };
  const engine = new Engine(f.store, adapter, 0);
  try {
    authorBlocked(f, 'author-with-pinned-review');
    const runId = randomUUID();
    f.store.putRun(runSchema.parse({ id: runId, taskId: f.task.id, role: 'reviewer', generation: 1,
      head: f.head, base: f.base, agentId: reviewerId, workspaceId: reviewerWorkspace, profile: null,
      status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: true,
      reviewSourceView: { creationId: randomUUID(), workspaceId: reviewerWorkspace, runId,
        sourceWorkspaceId: f.task.workspaceId, sourceDirectory: f.directory, receiptOperationId: null, receiptAt: new Date().toISOString(),
        head: f.head, tree: git(f.directory, 'rev-parse', 'HEAD^{tree}'), commonDir: git(f.repo, 'rev-parse', '--absolute-git-dir'),
        origin: f.remote, branch: `ns-review-${runId}`, directory: reviewerDirectory, state: 'ready', agentCreationIntent: true,
        briefDigest: null, briefVersion: null } }));
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, reviewerAgentId: reviewerId } });
    await engine.settleRunBuildOutputs(f.task.id);
    assert.equal(f.store.task(f.task.id).resolution.buildOutputCleanups[0]!.state, 'complete');
    await assert.rejects(stat(f.target), { code: 'ENOENT' });
    assert.equal(observed.includes(reviewerId), false, 'the stored run binds the reviewer to a different workspace');
    assert.equal(await readFile(join(reviewerOutput, 'kept.txt'), 'utf8'), 'review view output');
  } finally { await engine.stop(); f.store.close(); }
});

test('terminal reconciliation settles the initial author after an authentic applied revision', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  const adapter = settlingAdapter(f, { active: false });
  adapter.verifyPr = async () => ({ url: 'https://github.com/example/repo/pull/1', head: f.head });
  const engine = new Engine(f.store, adapter, 0);
  try {
    authorBlocked(f, 'initial');
    const revision = runSchema.parse({ id: 'later-revision', taskId: f.task.id, role: 'revision', generation: 1,
      head: f.head, base: f.base, agentId: 'later-author', workspaceId: f.task.workspaceId, profile: null,
      status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: false });
    f.store.putRun(revision);
    f.store.update(f.task.id, { phase: 'changes_requested', resolution: { ...f.store.task(f.task.id).resolution, currentRunId: revision.id } });
    f.store.setCredential(revision.id, 'revision-token');
    engine.resolution.complete(completionSchema.parse({ eventId: 'revision-result', taskId: f.task.id, runId: revision.id,
      status: 'ready_for_review', summary: 'Published revision', prNumber: 1, head: f.head }), 'revision-token');
    f.store.putRun({ ...f.store.run(revision.id)!, released: true, status: 'finished' });
    await engine.resolution.advance(f.store.task(f.task.id));
    assert.equal(f.store.task(f.task.id).completion?.runId, revision.id, 'real revision application becomes the completion');
    const replacement = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Replacement', repoPath: f.repo,
      planningCommit: f.base, handoffPath: 'replacement.md', originAgentId: 'origin' }), 'host', 'replacement', f.base);
    const cancelled = await engine.disposeTask({ taskId: f.task.id, version: f.store.task(f.task.id).version,
      action: 'supersede', replacementTaskId: replacement.id, reason: 'Preserve delivery', workDisposition: 'preserve' });
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(cancelled.runId, f.task.runId);
    assert.ok(f.store.lifecycleTasks().some(task => task.id === f.task.id));
    await engine.scheduleRunBuildOutputs(f.task.id);
    assert.equal(f.store.task(f.task.id).resolution.buildOutputCleanups.find(record => record.runId === f.task.runId)?.state, 'complete');
    await assert.rejects(stat(f.target), { code: 'ENOENT' });
    assert.equal(await readFile(join(f.directory, 'src', 'task.rs'), 'utf8'), 'pub fn task_source() -> u8 { 2 }\n');
  } finally { await engine.stop(); f.store.close(); }
});

test("blocked author output settles once its result is applied and keeps dirty source", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  await writeFile(join(f.directory, "src", "task.rs"), "unpublished edit\n");
  authorBlocked(f, "author-blocked");
  // The accepted completion itself writes the run-bound intent that settlement later consumes.
  assert.equal(f.store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.runId === f.task.runId)?.state, "intent");
  const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
  t.after(() => engine.stop());
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    await assert.rejects(stat(f.target), { code: "ENOENT" });
    assert.equal(await readFile(join(f.directory, "src", "task.rs"), "utf8"), "unpublished edit\n");
    const record = f.store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.runId === f.task.runId);
    assert.equal(record?.state, "complete");
    assert.match(record?.detail ?? "", /Removed task-local Cargo target output/);
  } finally { f.store.close(); }
});

test("run-bound output is kept while the run's agent is active and settles on a later idle pass", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  authorBlocked(f, "author-active");
  const agent = { active: true };
  const engine = new Engine(f.store, settlingAdapter(f, agent), 0);
  t.after(() => engine.stop());
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    await stat(f.target);
    const held = f.store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.runId === f.task.runId);
    assert.equal(held?.state, "intent");
    assert.match(held?.detail ?? "", /is active/);
    agent.active = false;
    await engine.settleRunBuildOutputs(f.task.id);
    await assert.rejects(stat(f.target), { code: "ENOENT" });
    assert.equal(f.store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.runId === f.task.runId)?.state, "complete");
  } finally { f.store.close(); }
});

test("run-bound output waits for a later unreleased run in the same workspace", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  authorBlocked(f, "author-later-run");
  const later = runSchema.parse({ id: "revision-run", taskId: f.task.id, role: "revision", generation: 1, head: f.head, base: f.base, agentId: "revision-agent", workspaceId: f.task.workspaceId, profile: null, status: "running", createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false });
  f.store.putRun(later);
  const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
  t.after(() => engine.stop());
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    await stat(f.target);
    assert.match(f.store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.runId === f.task.runId)?.detail ?? "", /revision-run is unreleased/);
    f.store.putRun({ ...later, status: "finished", released: true });
    await engine.settleRunBuildOutputs(f.task.id);
    await assert.rejects(stat(f.target), { code: "ENOENT" });
  } finally { f.store.close(); }
});

test("tracked output is retained with its reason and source is untouched", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  git(f.directory, "add", "-f", "target/debug/cache.bin");
  git(f.directory, "commit", "-m", "track generated output");
  git(f.directory, "push", "origin", f.task.branch);
  authorBlocked(f, "author-tracked");
  const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
  t.after(() => engine.stop());
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    await stat(join(f.target, "debug", "cache.bin"));
    const record = f.store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.runId === f.task.runId);
    assert.equal(record?.state, "skipped");
    assert.match(f.store.task(f.task.id).resolution.cleanupReason, /^Build output cleanup blocked: .*Skipped build output roots: .*Git reports tracked files/);
    assert.equal(await readFile(join(f.directory, "src", "task.rs"), "utf8"), "pub fn task_source() -> u8 { 2 }\n");
  } finally { f.store.close(); }
});

test("run-bound settlement survives restart and does not touch runs that never got a record", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
  t.after(() => engine.stop());
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    await stat(f.target);
    assert.equal(f.store.task(f.task.id).resolution.buildOutputCleanups.length, 0);
    authorBlocked(f, "author-restart");
    const agent = { active: true };
    f.store.close();
    const reopened = new Store(join(f.root, "queue.sqlite"));
    const restarted = new Engine(reopened, settlingAdapter(f, agent), 0);
    t.after(() => restarted.stop());
    try {
      await restarted.settleRunBuildOutputs(f.task.id);
      await stat(f.target);
      agent.active = false;
      await restarted.settleRunBuildOutputs(f.task.id);
      await assert.rejects(stat(f.target), { code: "ENOENT" });
      assert.equal(reopened.task(f.task.id).resolution.buildOutputCleanups.find(item => item.runId === f.task.runId)?.state, "complete");
    } finally { reopened.close(); }
  } finally { try { f.store.close(); } catch { /* already closed above */ } }
});

test("a complete workspace marker does not mask output from a run created after it", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  f.store.update(f.task.id, { resolution: { ...f.task.resolution, buildOutputCleanups: [{ workspaceId: f.task.workspaceId!, directory: f.directory, state: "complete", detail: "old", at: "2020-01-01T00:00:00.000Z" }] } });
  try {
    const hooks = () => buildOutputCleanupHooks(f.store, f.task.id, f.task.workspaceId!, f.directory, () => true);
    assert.equal(hooks().begin(), "complete");
    f.store.putRun(runSchema.parse({ id: "later-run", taskId: f.task.id, role: "revision", generation: 1, head: f.head, base: f.base, agentId: "revision-agent", workspaceId: f.task.workspaceId, profile: null, status: "finished", createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: true }));
    assert.equal(hooks().begin(), "run");
  } finally { f.store.close(); }
});

weighted(6)('preserved retirement waits for complete bounded projected tool evidence before archive intent', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const { projectedToolTimelineTail, longAnchorToolHistory } = await import('./support/tool-timeline');
  for (const shape of ['complete', 'live', 'unknown', 'gap', 'changed'] as const) {
    const f = await preservedFixture(t);
    try {
      const history = longAnchorToolHistory('completed');
      history[100].item = { type: 'tool_call', callId: 'older', name: 'exec', status: shape === 'unknown' ? undefined : 'running' };
      history[300].item = { type: 'tool_call', callId: shape === 'live' || shape === 'unknown' ? 'other' : 'older', name: 'exec', status: 'completed' };
      const native = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
      const limits: number[] = [];
      const counts: number[] = [];
      (native as any).api = { agents: { ref: () => ({ timeline: { refetch: async ({ limit }: { limit: number }) => {
        limits.push(limit);
        const page = projectedToolTimelineTail(history, limit);
        counts.push(page.entries.length);
        if (shape === 'gap' && limit > 200) page.gap = true;
        if (shape === 'changed' && limit > 200) page.endCursor!.seq++;
        return { ...page, error: null };
      } } }) } };
      f.adapter.agentTimelinePage = native.agentTimelinePage.bind(native);
      const source = await readFile(join(f.directory, 'src/lib.rs'), 'utf8');
      const result = await f.retry();
      if (shape === 'complete') {
        assert.equal(result.resolution.workspaceRetirement?.state, 'archived', result.resolution.workspaceRetirement?.detail);
        assert.equal(f.archive.count, 1);
        assert.deepEqual(limits.slice(0, 2), [200, 840]);
        assert.deepEqual(counts.slice(0, 2), [420, 450]);
        assert.equal(git(f.repo, 'ls-remote', 'origin', `refs/heads/${f.task.branch}`).split(/\s/)[0], f.head);
      } else {
        assert.equal(f.archive.count, 0, shape);
        assert.equal(result.resolution.workspaceRetirement?.state, 'held', shape);
        assert.equal(result.resolution.workspaceRetirement?.intentAt, null, shape);
        assert.match(result.resolution.workspaceRetirement!.detail, /tool|history/, shape);
        assert.equal(await readFile(join(f.directory, 'src/lib.rs'), 'utf8'), source, shape);
        assert.equal(git(f.directory, 'rev-parse', 'HEAD'), f.head, shape);
        assert.equal(git(f.directory, 'status', '--porcelain'), '', shape);
        assert.ok(await stat(f.target), 'build outputs also remain before sufficient evidence');
      }
    } finally { await f.close(); }
  }
});

test('owner retry finishes catalog-absent canonical teardown and proves runtime retirement', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await preservedFixture(t, [], true);
  try {
    f.archive.catalogued = false;
    const scope = 'b'.repeat(32), calls: string[][] = [];
    const runtime = new RuntimeRetirementService(f.store, async args => {
      calls.push(args);
      return { code: 0, timedOut: false, spawnError: '', output: args[1] === 'scope' ? JSON.stringify({ scope: { kind: 'worktree', token: scope } }) : 'nothing owned remains' };
    });
    await runtime.capture(f.task.id, f.task.workspaceId!, f.directory);
    f.runtime.prove = runtime.prove.bind(runtime);
    const result = await f.retry();
    assert.equal(result.resolution.workspaceRetirement?.state, 'archived');
    assert.equal(result.resolution.runtimeRetirements[0].state, 'retired');
    assert.deepEqual(result.disposition, f.cancelled.disposition);
    assert.equal(result.phase, 'cancelled');
    assert.equal(f.archive.count, 0);
    await assert.rejects(stat(f.directory), { code: 'ENOENT' });
    assert.deepEqual(calls.at(-1), ['container', 'retire', '--scope', scope, '--yes']);
    assert.ok(f.store.events(f.task.id).some(event => event.kind === 'workspace_retirement_intent'));
  } finally { await f.close(); }
});

test('restart finishes interrupted native archive without replay', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await preservedFixture(t, [], true);
  try {
    f.archive.lostReply = true;
    const first = await f.retry();
    assert.equal(first.resolution.workspaceRetirement?.state, 'uncertain');
    assert.equal(f.archive.count, 1);
    await stat(f.directory);
    await f.engine.stop();
    const reopened = new Store(join(f.root, 'queue.sqlite'));
    const runtime = new RuntimeRetirementService(reopened, f.runtime.invoke);
    const restarted = new Engine(reopened, f.adapter, 0, undefined, runtime);
    try {
      await restarted.scheduleRunBuildOutputs(f.task.id);
      const result = reopened.task(f.task.id);
      assert.equal(result.resolution.workspaceRetirement?.state, 'archived');
      assert.deepEqual(result.disposition, f.cancelled.disposition);
      assert.equal(f.archive.count, 1);
      await assert.rejects(stat(f.directory), { code: 'ENOENT' });
      await restarted.scheduleRunBuildOutputs(f.task.id);
      assert.equal(f.archive.count, 1);
    } finally { await restarted.stop(); reopened.close(); }
  } finally { await f.close(); }
});

test('ordinary closeout and scoped runtime retry finish retained teardown after a lost native reply', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, true, false, true);
  const { adapter: archiver, archive } = archiverFor(f);
  archive.lostReply = true;
  const adapter = { ...engineAdapter((...args) => archiver.archiveTaskWorkspace(...args)), taskWorkspaceArchived: (id: string) => archiver.taskWorkspaceArchived(id) };
  let failProof = true;
  const runtime = new RuntimeRetirementService(f.store, async args => args[1] === 'scope'
    ? { code: 0, timedOut: false, spawnError: '', output: JSON.stringify({ scope: { kind: 'worktree', token: 'c'.repeat(32) } }) }
    : { code: failProof ? 1 : 0, timedOut: false, spawnError: '', output: failProof ? 'runtime remains' : 'retired' });
  const engine = new Engine(f.store, adapter, 0, undefined, runtime);
  try {
    await new Lifecycle(engine).archive(f.store.task(f.task.id));
    const pending = f.store.task(f.task.id);
    assert.equal(pending.resolution.archiveIntentWorkspaceId, f.task.workspaceId);
    assert.deepEqual(pending.resolution.archivedWorkspaceIds, []);
    await stat(f.directory);
    assert.equal(pending.resolution.runtimeRetirements[0].state, 'failed');
    await engine.retryRuntimeRetirement(f.task.id, f.store.task(f.task.id).version);
    const archived = f.store.task(f.task.id);
    await assert.rejects(stat(f.directory), { code: 'ENOENT' });
    assert.equal(archive.count, 1);
    assert.ok(archived.resolution.archivedWorkspaceIds.includes(f.task.workspaceId!));
    assert.equal(archived.resolution.runtimeRetirements[0].state, 'failed');
    assert.match(archived.resolution.cleanupReason, /runtime retirement failed/);
    failProof = false;
    await engine.retryRuntimeRetirement(f.task.id, archived.version);
    assert.equal(f.store.task(f.task.id).resolution.runtimeRetirements[0].state, 'retired');
    assert.equal(archive.count, 1);
  } finally { await engine.stop(); f.store.close(); }
});

test('uncertain local teardown preserves a changed published head across owner retry', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await preservedFixture(t, [], true);
  try {
    f.archive.lostReply = true;
    assert.equal((await f.retry()).resolution.workspaceRetirement?.state, 'uncertain');
    await writeFile(join(f.directory, 'later.txt'), 'later published source');
    git(f.directory, 'add', '.'); git(f.directory, 'commit', '-m', 'later'); git(f.directory, 'push', 'origin', f.task.branch);
    const result = await f.retry();
    assert.equal(result.resolution.workspaceRetirement?.state, 'uncertain');
    assert.equal(result.resolution.workspaceRetirement?.head, f.head);
    assert.match(result.resolution.workspaceRetirement?.detail ?? '', /head changed since archive intent/);
    assert.equal(f.archive.count, 1);
    await stat(f.directory);
  } finally { await f.close(); }
});

// Live, 2026-10-23: five merged tasks never archived because their checkout's Cargo
// `target` links to an Project-C output volume. An untracked link at a canonical root goes
// with the checkout; Queue never follows, stats through or cleans its target.
async function externalOutput(root: string, name: string) {
  const outside = join(root, "project-c-outputs", name);
  await mkdir(join(outside, "debug", "sealed"), { recursive: true });
  await writeFile(join(outside, "debug", "artifact.bin"), "external artifact");
  await writeFile(join(outside, "debug", "sealed", "locked.bin"), "sealed artifact");
  await chmod(join(outside, "debug", "sealed", "locked.bin"), 0o400);
  await chmod(join(outside, "debug", "sealed"), 0o500);
  await chmod(outside, 0o500);
  return outside;
}
async function unseal(outside: string) {
  await chmod(outside, 0o755).catch(() => {});
  await chmod(join(outside, "debug", "sealed"), 0o755).catch(() => {});
}
/** Every entry's mode, mtime, size and file content, read without following links. */
async function tree(path: string) {
  const out: string[] = [];
  const walk = async (entry: string, rel: string): Promise<void> => {
    const info = await lstat(entry);
    out.push(`${rel} ${info.mode.toString(8)} ${info.mtimeMs} ${info.size}${info.isFile() ? ` ${await readFile(entry, "utf8")}` : ""}`);
    if (info.isDirectory()) for (const name of (await readdir(entry)).sort()) await walk(join(entry, name), `${rel}/${name}`);
  };
  await walk(path, ".");
  return out;
}
const leftInPlace = (path: string, kind: string) => new RegExp(`${path} \\(${kind}\\): symlink left in place; target untouched`);
const excludeLinks = async (repo: string) => appendFile(join(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "exclude"), "target\nnode_modules\n");

test("an untracked Cargo target symlink to an external build volume is left in place and does not block cleanup", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  const outside = await externalOutput(f.root, "effigy-39273292");
  try {
    await rm(f.target, { recursive: true, force: true });
    await symlink(outside, f.target, "dir");
    const before = await tree(outside);
    const result = await removeBuildOutput(f.directory);
    assert.equal(result.safe, true, result.detail);
    assert.equal(result.removed, false);
    assert.match(result.detail, leftInPlace(f.target, "Cargo target"));
    assert.doesNotMatch(result.detail, /Skipped build output roots|No build output roots/);
    assert.equal(await readlink(f.target), outside);
    assert.deepEqual(await tree(outside), before);
  } finally { await unseal(outside); f.store.close(); }
});

test("an untracked node_modules symlink is left in place while an ordinary target directory is still removed", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  const outside = await externalOutput(f.root, "node-store");
  const link = join(f.directory, "node_modules");
  try {
    await symlink(outside, link, "dir");
    const before = await tree(outside);
    const result = await removeBuildOutput(f.directory);
    assert.equal(result.safe, true, result.detail);
    assert.match(result.detail, leftInPlace(link, "node_modules"));
    assert.match(result.detail, new RegExp(`Removed task-local Cargo target output at ${f.target}`));
    await assert.rejects(stat(f.target), { code: "ENOENT" });
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.deepEqual(await tree(outside), before);
  } finally { await unseal(outside); f.store.close(); }
});

test("a dangling build output symlink is left in place and nothing is created at its target", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  try {
    const missing = join(f.root, "project-c-outputs", "gone");
    await rm(f.target, { recursive: true, force: true });
    await symlink(missing, f.target, "dir");
    const result = await removeBuildOutput(f.directory);
    assert.equal(result.safe, true, result.detail);
    assert.match(result.detail, leftInPlace(f.target, "Cargo target"));
    assert.equal(await readlink(f.target), missing);
    await assert.rejects(lstat(missing), { code: "ENOENT" });
  } finally { f.store.close(); }
});

test("a build output symlink to a directory in the checkout is left in place with its directory untouched", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  try {
    const vendor = join(f.directory, "vendor-modules");
    await mkdir(join(vendor, "pkg"), { recursive: true });
    await writeFile(join(vendor, "pkg", "index.js"), "module.exports = 1;\n");
    const link = join(f.directory, "node_modules");
    await symlink("vendor-modules", link, "dir");
    const before = await tree(vendor);
    const result = await removeBuildOutput(f.directory);
    assert.equal(result.safe, true, result.detail);
    assert.match(result.detail, leftInPlace(link, "node_modules"));
    assert.equal(await readlink(link), "vendor-modules");
    assert.deepEqual(await tree(vendor), before);
  } finally { f.store.close(); }
});

test("a build output symlink reached through a redirected parent stays unsafe", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  const outside = await externalOutput(f.root, "redirected");
  try {
    await mkdir(join(f.directory, ".cargo"), { recursive: true });
    await writeFile(join(f.directory, ".cargo", "config.toml"), '[build]\n"target-dir" = "target-alias/target"\n');
    const real = join(f.directory, "real-output");
    await mkdir(real);
    await symlink(outside, join(real, "target"), "dir");
    await symlink("real-output", join(f.directory, "target-alias"));
    const before = await tree(outside);
    const result = await removeBuildOutput(f.directory);
    assert.equal(result.safe, false);
    assert.match(result.detail, new RegExp(`${join(f.directory, "target-alias", "target")}: Build output path traverses an intermediate symlink to ${join(real, "target")}`));
    assert.doesNotMatch(result.detail, /symlink left in place/);
    assert.equal(await readlink(join(real, "target")), outside);
    assert.deepEqual(await tree(outside), before);
  } finally { await unseal(outside); f.store.close(); }
});

test("a failed build output symlink observation keeps cleanup unsafe even when an ordinary root is removed", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  const outside = await externalOutput(f.root, "unreadable");
  const frontend = join(f.directory, "frontend");
  try {
    await mkdir(frontend);
    await symlink(outside, join(frontend, "node_modules"), "dir");
    const before = await tree(outside);
    await chmod(frontend, 0o600); // readable, not searchable: lstat of the entry fails
    let result;
    try { result = await removeBuildOutput(f.directory); } finally { await chmod(frontend, 0o755); }
    assert.equal(result.safe, false);
    assert.match(result.detail, new RegExp(`${join(frontend, "node_modules")}: Could not inspect build output root`));
    assert.match(result.detail, new RegExp(`Removed task-local Cargo target output at ${f.target}`));
    assert.doesNotMatch(result.detail, /symlink left in place/);
    assert.deepEqual(await tree(outside), before);
  } finally { await unseal(outside); f.store.close(); }
});

test("a build output symlink replaced while Queue inspects it stays unsafe", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  const outside = await externalOutput(f.root, "first");
  const swapped = join(f.root, "project-c-outputs", "second");
  const bin = join(f.root, "swap-bin");
  const saved = process.env.PATH;
  try {
    await rm(f.target, { recursive: true, force: true });
    await symlink(outside, f.target, "dir");
    await mkdir(bin);
    const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    // Swap the link during the untracked check, between Queue's two observations.
    await writeFile(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" ls-files "*) rm -f "${f.target}" && ln -s "${swapped}" "${f.target}";; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${saved}`;
    let result;
    try { result = await removeBuildOutput(f.directory); } finally { process.env.PATH = saved; }
    assert.equal(result.safe, false);
    assert.match(result.detail, new RegExp(`${f.target}: Build output root changed while Queue inspected it`));
    assert.doesNotMatch(result.detail, /symlink left in place/);
    assert.equal(await readlink(f.target), swapped, "the swap ran");
  } finally { process.env.PATH = saved; await unseal(outside); f.store.close(); }
});

test("a build output root that is a regular file stays unsafe", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false);
  try {
    await rm(f.target, { recursive: true, force: true });
    await writeFile(f.target, "not a directory");
    const result = await removeBuildOutput(f.directory);
    assert.equal(result.safe, false);
    assert.match(result.detail, new RegExp(`${f.target}: Build output root is not a directory`));
    assert.equal(await readFile(f.target, "utf8"), "not a directory");
  } finally { f.store.close(); }
});

weighted(4)("worktree and orphan removal delete build output symlinks without traversing their targets", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const variant of ["worktree", "worktree discard", "orphan", "orphan discard"] as const) {
    const f = await setup(t, false);
    const outside = await externalOutput(f.root, "effigy-39273292");
    const store = join(f.root, "project-c-outputs", "node-store");
    const missing = join(f.root, "project-c-outputs", "gone");
    try {
      await mkdir(join(store, "pkg"), { recursive: true });
      await writeFile(join(store, "pkg", "index.js"), "module.exports = 1;\n");
      await excludeLinks(f.repo);
      await rm(f.target, { recursive: true, force: true });
      await symlink(outside, f.target, "dir");
      await symlink(missing, join(f.directory, "node_modules"), "dir");
      await mkdir(join(f.directory, "frontend"));
      await symlink(store, join(f.directory, "frontend", "node_modules"), "dir");
      assert.equal(git(f.directory, "status", "--porcelain"), "", "ignored links leave the archive's porcelain fence clean");
      const before = [await tree(outside), await tree(store)];
      const cleanup = await removeBuildOutput(f.directory);
      assert.equal(cleanup.safe, true, cleanup.detail);
      if (variant.endsWith("discard")) normalizeOwnedDirectoryPermissions(f.directory);
      if (variant.startsWith("orphan")) rmSync(f.directory, { recursive: true });
      else await removeOwnedWorktree(f.repo, f.directory, variant.endsWith("discard"));
      await assert.rejects(lstat(f.directory), { code: "ENOENT" }, variant);
      assert.deepEqual([await tree(outside), await tree(store)], before, variant);
      await assert.rejects(lstat(missing), { code: "ENOENT" }, variant);
    } finally { await unseal(outside); f.store.close(); }
  }
});

test("a merged task whose Cargo target links to an external volume archives through real worktree removal", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, true, false, true);
  const outside = await externalOutput(f.root, "effigy-39273292");
  try {
    await excludeLinks(f.repo);
    await rm(f.target, { recursive: true, force: true });
    await symlink(outside, f.target, "dir");
    git(f.repo, "push", "origin", "--delete", f.task.branch);
    const before = await tree(outside);
    const { adapter: archiver, archive } = archiverFor(f);
    archive.retainDirectory = true; // Queue's own teardown, not the native archive, removes the checkout.
    const engine = new Engine(f.store, engineAdapter((...args) => archiver.archiveTaskWorkspace!(...args)), 0);
    t.after(() => engine.stop());
    await new Lifecycle(engine).archive(f.store.task(f.task.id));
    assert.equal(archive.count, 1);
    const cleanup = f.store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.workspaceId === f.task.workspaceId);
    assert.equal(cleanup?.state, "complete");
    assert.match(cleanup?.detail ?? "", leftInPlace(f.target, "Cargo target"));
    assert.ok(f.store.events(f.task.id).some(event => event.kind === "workspace_archived"));
    await assert.rejects(lstat(f.directory), { code: "ENOENT" });
    assert.deepEqual(await tree(outside), before);
  } finally { await unseal(outside); f.store.close(); }
});
