import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  projectQaRunSchema,
  QA_MANAGED_LAUNCH_RETIRED,
  QA_SCHEDULE_RETIRED,
} from "../shared/contracts";
import { QueueRuntime } from "../service/runtime-owner";
import { Store } from "../core/store/store";
import { PersistenceExecutor } from "../service/executor/executor";
import { seedLegacyQaRun } from "./support/legacy-qa";
import { command, git } from "../core/git/index";

/** One registered repository with a GitHub origin, plus a private runtime store. */
async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nsq-qa-retired-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await command(
    "git",
    ["init", "--bare", "--initial-branch=main", join(root, "origin.git")],
    root,
  );
  await command(
    "git",
    ["clone", join(root, "origin.git"), join(root, "repo")],
    root,
  );
  const repo = join(root, "repo");
  await git(
    repo,
    "remote",
    "set-url",
    "origin",
    "https://github.com/acme/app.git",
  );
  const dataDir = join(root, "data");
  const runtime = new QueueRuntime({ dataDir, timers: false });
  t.after(() => runtime.stop());
  return { root, repo, origin: "acme/app", runtime };
}

const run = (id: string, overrides: Record<string, unknown> = {}) =>
  projectQaRunSchema.parse({
    id,
    key: "acme/app",
    repository: { origin: "acme/app", path: "/repository" },
    state: "failed",
    baseBranch: "main",
    base: "a".repeat(40),
    argv: ["effigy", "qa"],
    digest: "b".repeat(64),
    capacityWait: null,
    capacityUnavailable: false,
    exitCode: 1,
    durationMs: 1200,
    outputTail: "1 failing test",
    startedAt: "2026-11-01T00:00:00.000Z",
    submittedAt: "2026-11-01T00:00:00.000Z",
    finishedAt: "2026-11-01T00:01:00.000Z",
    pid: null,
    ...overrides,
  });

test("a fresh milestone QA launch refuses with the recipe and the history reads that still answer", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () => f.runtime.runProjectQa({ repository: f.origin }),
    (error: Error) => {
      assert.equal(error.message, QA_MANAGED_LAUNCH_RETIRED);
      assert.match(error.message, /report-only/);
      assert.match(error.message, /milestone-qa\.md/);
      for (const verb of [
        "project.qa.get",
        "project.qa.list",
      ])
        assert.ok(error.message.includes(verb), `the refusal names ${verb}`);
      return true;
    },
    "the launch entry point is retired for every caller, including --wait",
  );
  await assert.rejects(
    () => f.runtime.runProjectQa({ repository: f.origin, wait: true }),
    { message: QA_MANAGED_LAUNCH_RETIRED },
  );
  assert.deepEqual(
    (await f.runtime.listProjectQa()).filter((item) => item.key === f.origin),
    [],
    "a refused launch creates no run, so no checkout, request identity or capacity is spent",
  );
});

test("a schedule can be cleared but never enabled or replaced", async (t) => {
  const f = await fixture(t);
  const configured = await f.runtime.setRepository({
    repository: f.origin,
    qa: { argv: ["effigy", "qa"], timeoutMs: 60_000 },
  });
  assert.deepEqual(configured.qa?.argv, ["effigy", "qa"]);
  await assert.rejects(
    () =>
      f.runtime.setRepository({
        repository: f.origin,
        qa: {
          argv: ["effigy", "qa"],
          timeoutMs: 60_000,
          schedule: { afterMerges: 5 },
        },
      }),
    { message: QA_SCHEDULE_RETIRED },
    "enabling a schedule is the retired entry point",
  );
  const cleared = await f.runtime.setRepository({
    repository: f.origin,
    qa: { argv: ["effigy", "qa"], timeoutMs: 60_000, schedule: null },
  });
  assert.equal(
    cleared.qa?.schedule ?? null,
    null,
    "clearing a leftover schedule stays the exit",
  );
  f.runtime.store.patchRepository(
    { origin: f.origin, path: f.repo },
    {
      qa: {
        argv: ["effigy", "qa"],
        timeoutMs: 60_000,
        schedule: { afterMerges: 3, maxIntervalHours: 24 },
      },
    },
  );
  const patchCleared = await f.runtime.setRepository({
    repository: f.origin,
    qa: { schedule: null },
  });
  assert.equal(
    patchCleared.qa?.schedule ?? null,
    null,
    "schedule-only null patch clears a stored legacy schedule",
  );
  assert.deepEqual(
    patchCleared.qa?.argv,
    ["effigy", "qa"],
    "schedule-only null patch preserves the stored QA argv",
  );
});

test("a standby refuses older unsettled QA even when the latest result is terminal", async t => {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "legacy-qa-")));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, "queue.sqlite");
  const store = new Store(path);
  const active = run(randomUUID(), { state: "running", finishedAt: null, pid: process.pid });
  const id = randomUUID();
  const key = createHash("sha256").update(active.key).digest("hex").slice(0, 24);
  const evidence = join(dataDir, "project-qa", key);
  await mkdir(evidence, { recursive: true });
  const logPath = join(evidence, `${id}.failures.log`);
  await writeFile(logPath, "retained failure\n");
  const terminal = seedLegacyQaRun(store, run(id, { failuresLogPath: logPath }));
  seedLegacyQaRun(store, active);
  // Restore the latest index to the terminal row: custody must look past it.
  seedLegacyQaRun(store, terminal);
  const requestId = randomUUID();
  const request = {
    id: requestId, input: { repository: active.key, baseBranch: "main", requestId },
    ownerInstance: randomUUID(), ownerPid: process.pid, receivedAt: active.startedAt,
    state: "preparing", diagnostic: "", runId: null,
  };
  store.setMeta(`projectQaRequest:${requestId}`, request);
  store.patchRepository(active.repository, {
    qa: { argv: ["effigy", "qa"], schedule: { afterMerges: 1, maxIntervalHours: 24 } },
  });
  store.close();
  const boot = (standbyFor?: number) => new PersistenceExecutor({
    owner: { dataDir, timers: false, settings: { daemonUrl: "ws://127.0.0.1:0/ws" } },
    ...(standbyFor ? { standbyFor } : {}),
  });
  const refusal = async (expected: RegExp) => {
    const standby = boot(process.pid);
    try { await assert.rejects(standby.boot(), expected); }
    finally { standby.terminate(); }
  };
  await refusal(/Legacy milestone QA upgrade deferred.*unresolved delivery/);
  const compatible = new Store(path);
  try {
    assert.equal(compatible.getMeta<{ state: string }>(`projectQaRequest:${requestId}`)?.state, "preparing");
    compatible.setMeta(`projectQaRequest:${requestId}`, {
      ...request, state: "refused", diagnostic: "Compatibility service settled interrupted preparation",
    });
  } finally { compatible.close(); }

  await refusal(new RegExp(`${active.id} still owns execution or checkout cleanup`));
  const cleanup = new Store(path);
  const checkoutPath = join(evidence, active.id);
  try {
    assert.deepEqual(cleanup.qaRun(active.id), active);
    assert.deepEqual(cleanup.qaRun(terminal.id), terminal);
    seedLegacyQaRun(cleanup, { ...active, state: "failed", finishedAt: terminal.finishedAt, pid: null, checkoutPath });
    seedLegacyQaRun(cleanup, terminal);
    await mkdir(checkoutPath);
  } finally { cleanup.close(); }
  await refusal(/Legacy QA checkout .* is still present/);
  // The compatibility build's cleanup would remove its checked allocation here.
  await rm(checkoutPath, { recursive: true });
  const replacement = boot();
  try {
    await replacement.boot();
    assert.deepEqual(await replacement.rpc("project.qa.get", { id: terminal.id }), terminal);
    assert.deepEqual(await replacement.rpc("project.qa.list", {}), [terminal]);
    assert.deepEqual(await replacement.rpc("project.qa.get", { repository: terminal.repository.path }), terminal);
    await assert.rejects(replacement.rpc("project.qa.run", { repository: active.key, wait: true }), /launch is retired/);
    assert.equal(await readFile(logPath, "utf8"), "retained failure\n");
    const settings = await replacement.rpc("repository.get", { repository: active.key });
    assert.ok(settings && typeof settings === "object" && "qa" in settings);
    assert.ok(settings.qa && typeof settings.qa === "object" && "schedule" in settings.qa);
    assert.deepEqual(settings.qa.schedule, { afterMerges: 1, maxIntervalHours: 24 });
    const cleared = await replacement.rpc("repository.set", { repository: active.key, qa: { schedule: null } });
    assert.ok(cleared && typeof cleared === "object" && "qa" in cleared);
    assert.ok(cleared.qa && typeof cleared.qa === "object" && "schedule" in cleared.qa);
    assert.equal(cleared.qa.schedule, null);
  } finally {
    await replacement.drain();
  }
});
