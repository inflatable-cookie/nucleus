import { test } from "./support/sharded-test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { runBuildOutputIntent } from "../core/hooks/build-output-records";
import { buildOutputCleanupHooks, removeBuildOutput } from "../core/workspaces/worktree-cleanup";
import { completionSchema, hostRunRecordSchema, runSchema, type HostRunInternalRecord } from "../shared/contracts";
import { HOOK_TEST_TIMEOUT_MS } from "./support/budgets";
import { HOST_RUN_ACCOUNTING_POLICY, hostRunAccountingAuthority, hostRunAccountingAutomaticRetirementRecord, hostRunAccountingDispositionRecord, hostRunPublicDigest } from "../core/host-runs/host-run-accounting";
import { hostRunAccountingDispositionMetaKey } from "../core/host-runs/host-run-meta-keys";
import { git, setup, settlingAdapter } from "./support/preserved-retirement-fixture";

// Queue #342 node_modules supersession (2026-10-20): run-bound settlement keeps installed
// dependencies for the task's next continuation; terminal cleanup still removes them.

const sentinel = (directory: string) => join(directory, "node_modules", "left-pad", "index.js");
const nestedSentinel = (directory: string) => join(directory, "frontend", "apps", "web", "node_modules", "pkg", "cache.bin");

async function installDependencies(f: Awaited<ReturnType<typeof setup>>) {
  await mkdir(join(f.directory, "node_modules", "left-pad"), { recursive: true });
  await writeFile(sentinel(f.directory), "installed");
}

function authorResult(f: Awaited<ReturnType<typeof setup>>, eventId: string, status: "blocked" | "error") {
  const completion = completionSchema.parse({ eventId, taskId: f.task.id, runId: f.task.runId!, status, summary: `Author ${status}` });
  f.store.setCredential(f.task.runId!, "run-token");
  f.store.acceptCompletion(completion, "run-token", null);
  f.store.update(f.task.id, { phase: "blocked" });
}

const runRecord = (f: Awaited<ReturnType<typeof setup>>) => f.store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.runId === f.task.runId);

test("blocked and error author results keep root and nested node_modules while Cargo output is cleared", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const status of ["blocked", "error"] as const) {
    const f = await setup(t, false, true);
    await installDependencies(f);
    authorResult(f, `author-${status}`, status);
    const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
    try {
      await engine.settleRunBuildOutputs(f.task.id);
      await assert.rejects(stat(f.target), { code: "ENOENT" });
      await assert.rejects(stat(f.nestedTarget), { code: "ENOENT" });
      assert.equal(await readFile(sentinel(f.directory), "utf8"), "installed");
      assert.equal(await readFile(nestedSentinel(f.directory), "utf8"), "generated package output");
      const record = runRecord(f);
      assert.equal(record?.state, "complete", status);
      assert.match(record?.detail ?? "", /Removed task-local Cargo target output/);
      assert.match(record?.detail ?? "", /Retained node_modules at .*node_modules/);
      assert.doesNotMatch(record?.detail ?? "", /Removed node_modules/);
      assert.equal(f.store.task(f.task.id).resolution.cleanupReason, "", status);
    } finally { await engine.stop(); f.store.close(); }
  }
});

test("a run-bound settlement leaves a symlinked Cargo target in place, target untouched, and its complete record claims no removal", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  const external = await mkdtemp(join(tmpdir(), "nsq-project-c-outputs-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, "artifact.rlib"), "external output");
  const before = await stat(join(external, "artifact.rlib"));
  await rm(f.target, { recursive: true, force: true });
  await symlink(external, f.target);
  await installDependencies(f);
  authorResult(f, "author-blocked", "blocked");
  const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    assert.ok((await lstat(f.target)).isSymbolicLink(), "the link stays for checkout removal");
    assert.equal(await readlink(f.target), external);
    const after = await stat(join(external, "artifact.rlib"));
    assert.equal(await readFile(join(external, "artifact.rlib"), "utf8"), "external output");
    assert.deepEqual([after.mode, after.mtimeMs, after.size], [before.mode, before.mtimeMs, before.size]);
    await assert.rejects(stat(f.nestedTarget), { code: "ENOENT" }, "an ordinary target directory is still removed");
    const record = runRecord(f);
    // complete means Queue's cleanup obligation is satisfied: the link remains and its
    // target is untouched; it claims no deletion, exit, capacity release or ownership.
    assert.equal(record?.state, "complete");
    assert.match(record?.detail ?? "", new RegExp(`Left build output symlinks: ${f.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(Cargo target\\): symlink left in place; target untouched`));
    assert.doesNotMatch(record?.detail ?? "", new RegExp(`Removed task-local Cargo target output at [^.]*${f.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(,|\\.|$)`));
    assert.match(record?.detail ?? "", /Retained node_modules at .*node_modules/);
    assert.equal(f.store.task(f.task.id).resolution.cleanupReason, "");
  } finally { await engine.stop(); f.store.close(); }
});

test("retained dependencies survive a restart and a successor reads them without reinstalling", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  await installDependencies(f);
  authorResult(f, "author-successor", "blocked");
  const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    assert.equal(runRecord(f)?.state, "complete");
    const settledVersion = f.store.task(f.task.id).version;
    f.store.close();
    const reopened = new Store(join(f.root, "queue.sqlite"));
    const restarted = new Engine(reopened, settlingAdapter(f, { active: false }), 0);
    try {
      await restarted.settleRunBuildOutputs(f.task.id);
      assert.equal(reopened.task(f.task.id).version, settledVersion, "a complete retained record is not rewritten");
      assert.equal(await readFile(sentinel(f.directory), "utf8"), "installed");
    } finally { await restarted.stop(); reopened.close(); }
  } finally { await engine.stop(); try { f.store.close(); } catch { /* closed before restart */ } }
});

test("JavaScript-only output settles once without reporting retained roots removed or blocking launch", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  await rm(f.target, { recursive: true, force: true });
  await installDependencies(f);
  authorResult(f, "author-js-only", "blocked");
  const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
  t.after(() => engine.stop());
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    const record = runRecord(f);
    assert.equal(record?.state, "complete");
    assert.match(record?.detail ?? "", /^Retained node_modules at .*node_modules for the task's next continuation$/);
    assert.equal(f.store.task(f.task.id).resolution.cleanupReason, "");
    const settledVersion = f.store.task(f.task.id).version;
    await engine.settleRunBuildOutputs(f.task.id);
    assert.equal(f.store.task(f.task.id).version, settledVersion, "repeated settlement does not rewrite the record");
    assert.equal(await readFile(sentinel(f.directory), "utf8"), "installed");
  } finally { f.store.close(); }
});

test("a reviewer view keeps its node_modules through a run-bound settlement and clears its Cargo target", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t);
  const reviewerDirectory = join(f.root, "review-view");
  git(f.repo, "worktree", "add", "--detach", reviewerDirectory, f.head);
  await mkdir(join(reviewerDirectory, "target", "debug"), { recursive: true });
  await writeFile(join(reviewerDirectory, "target", "debug", "cache.bin"), "review output");
  await mkdir(join(reviewerDirectory, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(reviewerDirectory, "node_modules", "left-pad", "index.js"), "review installed");
  const runId = randomUUID();
  f.store.putRun(runSchema.parse({ id: runId, taskId: f.task.id, role: "reviewer", generation: 1, head: f.head, base: f.base,
    agentId: "review-agent", workspaceId: f.task.workspaceId, profile: null, status: "finished", createdAt: new Date().toISOString(),
    lastObservedAt: null, active: null, idleSince: null, completion: null, released: true }));
  f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution,
    buildOutputCleanups: runBuildOutputIntent([], { id: runId, workspaceId: f.task.workspaceId!, agentId: "review-agent" }, reviewerDirectory, new Date().toISOString()) } });
  const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
  t.after(() => engine.stop());
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    await assert.rejects(stat(join(reviewerDirectory, "target")), { code: "ENOENT" });
    assert.equal(await readFile(join(reviewerDirectory, "node_modules", "left-pad", "index.js"), "utf8"), "review installed");
    const record = f.store.task(f.task.id).resolution.buildOutputCleanups.find(item => item.runId === runId);
    assert.equal(record?.state, "complete");
    assert.doesNotMatch(record?.detail ?? "", /Removed node_modules/);
  } finally { f.store.close(); }
});

test("terminal cleanup still removes retained node_modules and a run-bound record does not mask it", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  await installDependencies(f);
  authorResult(f, "author-terminal", "blocked");
  const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
  t.after(() => engine.stop());
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    await stat(sentinel(f.directory));
    const hooks = () => buildOutputCleanupHooks(f.store, f.task.id, f.task.workspaceId!, f.directory, () => true);
    assert.equal(hooks().begin(), "run", "a run-bound complete record does not mark the workspace complete");
    const result = await removeBuildOutput(f.directory);
    assert.equal(result.safe, true);
    assert.match(result.detail, /Removed node_modules at .*node_modules/);
    await assert.rejects(stat(sentinel(f.directory)), { code: "ENOENT" });
    await assert.rejects(stat(join(f.directory, "frontend", "apps", "web", "node_modules")), { code: "ENOENT" });
  } finally { f.store.close(); }
});

const hostRunAt = (path: string, state: "queued" | "admitted" | "running" | "settled", released: boolean) => {
  const at = new Date().toISOString();
  return hostRunRecordSchema.parse({
    id: `run-${state}-${randomUUID()}`, epoch: 1, caller: "interactive:501", repository: { origin: "acme/repo", path },
    selector: "qa", runClass: "heavy", classSource: "default", priority: "interactive", state,
    submittedAt: at, capacityDeadlineAt: at, runTimeoutMs: 60_000,
    budgetFallback: { cpu: 1, memoryBytes: 100_000_000 }, budget: { cpu: 0.5, memoryBytes: 100_000_000, wallMs: 100, source: "history" },
    position: state === "queued" ? 1 : null, admittedAt: state === "queued" ? null : at, launchedAt: state === "running" || state === "settled" ? at : null,
    settledAt: state === "settled" ? at : null, capacitySample: null,
    pid: null, processGroupId: null, startIdentity: null, settlement: null, wallMs: null, cpuMs: null, containers: [],
    capacityReleasedAt: released ? at : null, capacityReleaseReason: released ? "settled" : null, capacityReleaseKind: released ? "automatic" : null,
  });
};

test("a host run that still holds the workspace holds run-bound cleanup until it settles and releases capacity (Project-E 096)", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const state of ["queued", "admitted", "running", "settled"] as const) {
    const f = await setup(t, false, true);
    authorResult(f, `author-${state}`, "blocked");
    // A detached run whose client left still executes in the task checkout.
    const live = f.store.putHostRun(hostRunAt(join(f.directory, "rust"), state, false));
    const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
    try {
      await engine.settleRunBuildOutputs(f.task.id);
      assert.ok((await stat(f.target)).isDirectory(), `${state}: Cargo output survives while the host run holds the workspace`);
      const held = runRecord(f);
      assert.notEqual(held?.state, "complete", state);
      assert.match(held?.detail ?? "", new RegExp(`host run ${live.id}`), state);
      // Settlement with capacity released frees the workspace.
      f.store.putHostRun({ ...live, state: "settled", settledAt: new Date().toISOString(), capacityReleasedAt: new Date().toISOString(),
        capacityReleaseReason: "settled", capacityReleaseKind: "automatic" });
      await engine.settleRunBuildOutputs(f.task.id);
      await assert.rejects(stat(f.target), { code: "ENOENT" }, state);
      assert.equal(runRecord(f)?.state, "complete", state);
    } finally { await engine.stop(); f.store.close(); }
  }
});

/** Each valid retirement basis for `run`, built by the production record builders. */
function retirements(run: HostRunInternalRecord) {
  const digest = hostRunPublicDigest(run);
  const operator = hostRunAccountingDispositionRecord(run, {
    runId: run.id, operationId: `op-${run.id}`, expectedEpoch: run.epoch, expectedRunDigest: digest,
    authority: { caller: "relay-agent", relayed: true, note: "Tom: Both release" },
    acceptance: { scope: "exact_run", runId: run.id, epoch: run.epoch, unknownOutcomeRetained: true, reason: "accept this run" },
    reason: "exact-run accounting relief",
  }, hostRunAccountingAuthority({ caller: "relay-agent", relayed: true, note: "Tom: Both release" }), new Date().toISOString());
  const producer = hostRunAccountingAutomaticRetirementRecord(run, {
    runId: "effigy-run", selector: run.selector, evidenceSource: "checkout-journal", cleanup: "complete", state: "succeeded",
    exitCode: 0, signal: null, startedAt: null, endedAt: null, durationMs: null, runtimePath: "/fixture/effigy",
    runtimeSha256: "a".repeat(64), verdict: "passed", observedAt: new Date().toISOString(),
  }, digest, new Date().toISOString());
  assert.deepEqual(producer.policy, HOST_RUN_ACCOUNTING_POLICY);
  return { operator, producer };
}

test("a retired host run stops holding run-bound cleanup under either basis; an unbindable retirement or another charged run still holds", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const basis of ["operator", "producer"] as const) {
    const f = await setup(t, false, true);
    authorResult(f, `author-retired-${basis}`, "blocked");
    const live = f.store.putHostRun(hostRunAt(join(f.directory, "rust"), "running", false));
    const key = hostRunAccountingDispositionMetaKey(live.id);
    const valid = retirements(live)[basis];
    const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
    try {
      // Missing, malformed, unknown-format, another run's and another epoch's
      // retirements are not this row's retirement: cleanup stays held.
      for (const [label, stored] of [
        ["absent", undefined],
        ["unreadable", { unreadable: true }],
        ["malformed", { ...valid, disposition: "settled" }],
        ["unknown format", { ...valid, format: "queue.host-run.accounting-something" }],
        ["id mismatch", { ...valid, runId: "another-run" }],
        ["epoch mismatch", { ...valid, epoch: live.epoch + 1 }],
      ] as const) {
        if (stored === undefined) f.store.db.prepare("DELETE FROM meta WHERE key=?").run(key); else f.store.setMeta(key, stored);
        await engine.settleRunBuildOutputs(f.task.id);
        assert.ok((await stat(f.target)).isDirectory(), `${basis}/${label}: Cargo output survives`);
        assert.match(runRecord(f)?.detail ?? "", new RegExp(`host run ${live.id}`), `${basis}/${label}`);
      }

      // A second, still-charged run in the same workspace keeps holding it after
      // the first is retired.
      f.store.setMeta(key, valid);
      const second = f.store.putHostRun(hostRunAt(f.directory, "running", false));
      assert.equal(f.store.hostRunHoldingWorkspace(f.directory)?.id, second.id, `${basis}: the charged run holds`);
      await engine.settleRunBuildOutputs(f.task.id);
      assert.ok((await stat(f.target)).isDirectory(), `${basis}: a later charged run still holds cleanup`);
      assert.match(runRecord(f)?.detail ?? "", new RegExp(`host run ${second.id}`), basis);

      // With only the retired run left, cleanup proceeds; the retired row and its
      // retirement are byte-for-byte unchanged and nothing settles or releases.
      f.store.db.prepare("DELETE FROM host_run_records WHERE id=?").run(second.id);
      const rowBefore = hostRunPublicDigest(f.store.hostRun(live.id)!);
      const retirementBefore = JSON.stringify(f.store.hostRunAccountingDispositionRaw(live.id));
      await engine.settleRunBuildOutputs(f.task.id);
      await assert.rejects(stat(f.target), { code: "ENOENT" }, basis);
      assert.equal(runRecord(f)?.state, "complete", basis);
      const after = f.store.hostRun(live.id)!;
      assert.equal(hostRunPublicDigest(after), rowBefore, `${basis}: the pinned row is unchanged`);
      assert.equal(JSON.stringify(f.store.hostRunAccountingDispositionRaw(live.id)), retirementBefore, `${basis}: the retirement is unchanged`);
      assert.equal(after.state, "running");
      assert.equal(after.settlement, null);
      assert.equal(after.capacityReleasedAt, null);
    } finally { await engine.stop(); f.store.close(); }
  }
});

test("a host run in a sibling directory sharing the workspace's name prefix holds nothing", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  authorResult(f, "author-sibling", "blocked");
  f.store.putHostRun(hostRunAt(`${f.directory}-sibling`, "running", false));
  assert.equal(f.store.hostRunHoldingWorkspace(f.directory), null);
  const engine = new Engine(f.store, settlingAdapter(f, { active: false }), 0);
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    await assert.rejects(stat(f.target), { code: "ENOENT" });
  } finally { await engine.stop(); f.store.close(); }
});

test("a host run recorded through a symlink to the workspace holds it", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  const link = `${f.directory}.link`;
  await symlink(f.directory, link);
  t.after(() => rm(link, { force: true }));
  const live = f.store.putHostRun(hostRunAt(link, "running", false));
  assert.equal(f.store.hostRunHoldingWorkspace(f.directory)?.id, live.id);
  f.store.close();
});

test("a host run admitted while the cleanup's idleness proofs await still holds the removal (review #564)", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  authorResult(f, "author-late-host-run", "blocked");
  const adapter = settlingAdapter(f, { active: false });
  const observe = adapter.observe;
  let late: HostRunInternalRecord | null = null;
  adapter.observe = async id => {
    if (!late) late = f.store.putHostRun(hostRunAt(f.directory, "running", false));
    return observe(id);
  };
  const engine = new Engine(f.store, adapter, 0);
  try {
    await engine.settleRunBuildOutputs(f.task.id);
    assert.ok(late, "the host run arrived during the awaited observation");
    assert.ok((await stat(f.target)).isDirectory(), "Cargo output survives the late host run");
    assert.notEqual(runRecord(f)?.state, "complete");
    assert.match(runRecord(f)?.detail ?? "", /host run run-running-/);
  } finally { await engine.stop(); f.store.close(); }
});

test("a host run recorded under a case alias of the workspace holds it on a case-insensitive volume (review #564)", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await setup(t, false, true);
  const alias = f.directory.replace(/\/ns-/, "/NS-");
  let aliasResolves = false;
  try { aliasResolves = alias !== f.directory && (await stat(alias)).isDirectory(); } catch { /* case-sensitive volume */ }
  if (!aliasResolves) { t.skip("the volume is case-sensitive; an alias is a different path there"); f.store.close(); return; }
  const live = f.store.putHostRun(hostRunAt(alias, "running", false));
  assert.equal(f.store.hostRunHoldingWorkspace(f.directory)?.id, live.id, "the alias resolves to the workspace's own spelling");
  assert.equal(f.store.hostRunHoldingWorkspace(alias)?.id, live.id);
  f.store.close();
});
