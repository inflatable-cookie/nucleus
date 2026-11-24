import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../shared/contracts";
import { createRustApi } from "../client/web/rust-api";
import { createRustAdapter, projectKeys, RustUnsupported } from "../client/web/rust-adapter";
import { rustProjectArchive } from "../client/rust-contracts";

/**
 * The Rust engine's board adapter (Spec 070 ruling 4): the shared screens'
 * contracts answered from the engine's paired API. The fake below speaks the
 * engine's wire shapes (`engine/crates/nucleus-service/src/web/settings.rs`),
 * including a field this client does not know, and records every write.
 */

function engine() {
  let dispatch = {
    usage: "normal", usageUntilMs: null, globalSlots: 4, projectDefaultSlots: 2,
    projectSlotOverrides: { Orbit_Main: 3 },
    providerLimitCooldownSeconds: 300, mode: "running",
  };
  let profiles: Record<string, unknown> = {
    profiles: [{
      name: "Worker", group: "team",
      selection: { id: "w", provider: "codex", model: "m", effort: "high", capability: "worker", weight: "default" },
      unrated: true, providerInstanceId: "codex-1",
    }],
    pausedGroups: [],
  };
  let projects = { projects: {
    Orbit_Main: { name: "Orbit", archived: false, repositories: [
      { origin: "example/orbit", path: "/work/orbit", base: "main", requiredChecks: ["ci"], hungToolMinutes: 30, hostProjectTitle: "Orbit" },
    ] },
  } };
  const revisions: Record<string, number> = { dispatch: 1, profiles: 1, projects: 1 };
  const writes: Array<{ domain: string; body: { revision: string; value: unknown } }> = [];
  const snap = (value: unknown, domain: string) => ({ value, revision: String(revisions[domain] ?? 1), configured: true });
  const views: Record<string, () => unknown> = {
    dispatch: () => snap(dispatch, "dispatch"),
    profiles: () => snap(profiles, "profiles"),
    projects: () => ({ settings: snap(projects, "projects"), resolvedPlanners: { Orbit_Main: "thread-1" } }),
    hosts: () => ({ settings: snap({ t3: { endpoint: "http://127.0.0.1:3773/", credentialRef: "T3" } }, "hosts"), active: { endpoint: "http://127.0.0.1:3773/", status: "reachable" } }),
    storage: () => ({
      settings: snap({ enabled: true, workRoot: null, scratchRoot: null, logRoot: null, retention: { keepNewest: 5, maxAgeDays: null } }, "storage"),
      active: { databaseRoot: "/e/db", workRoot: "/e/work", backupRoot: "/e/backups", scratchRoot: "/e/scratch", logRoot: "/e/logs" },
      backups: { complete: true, issues: 0, verified: [{ id: "b1", createdAt: "2026-11-24T08:00:00Z" }] },
    }),
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace("/api/engine", "");
    assert.equal(new Headers(init?.headers).get("x-nucleus-board"), "1");
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/settings") return json(Object.fromEntries(Object.entries(views).map(([key, view]) => [key, view()])));
    if (path === "/tasks") return json([]);
    const domain = /^\/settings\/(\w+)$/.exec(path)?.[1];
    if (domain && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { revision: string; value: never };
      writes.push({ domain, body });
      if (domain === "dispatch") dispatch = body.value;
      if (domain === "profiles") profiles = body.value;
      if (domain === "projects") projects = body.value;
      revisions[domain] = (revisions[domain] ?? 1) + 1;
    }
    if (domain) return json(views[domain]!());
    if (/\/plan$/.test(path)) return json({ version: 0, lanes: [], documents: [], idle: true });
    return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
  }) as typeof fetch;
  return { fetcher, writes, mode: () => dispatch.mode };
}

test("the board snapshot carries the engine's settings and its dispatch mode", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  const board = await adapter.rpc(api.uiSnapshot, {});
  assert.ok(!("unchanged" in board));
  if ("unchanged" in board) return;
  assert.equal(board.paused, false);
  assert.equal(board.dispatchHeld, false);
  assert.equal(board.globalLimit, 4);
  assert.deepEqual(board.projects.map((project) => [project.key, project.name]), [["p-orbit-main", "Orbit"]]);
  assert.deepEqual(board.projectLimitOverrides, { "p-orbit-main": 3 });
  assert.deepEqual(board.pool.map((entry) => [entry.profileId, entry.group, entry.roles]), [["w", "team", ["worker", "reviewer"]]]);
  assert.equal(board.backup.newestSnapshotAt, "2026-11-24T08:00:00Z");
  assert.ok(board.repositoryBadges?.["/work/orbit"]);
});

test("pause, dispatch hold and stop write the Dispatch mode the scheduler reads", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  await adapter.rpc(api.queueControl, { dispatchHeld: true });
  assert.equal(fake.mode(), "held");
  await adapter.rpc(api.queueControl, { paused: true });
  assert.equal(fake.mode(), "paused");
  await adapter.rpc(api.stopThreads, { caller: "operator (board)" });
  assert.equal(fake.mode(), "stopped");
  const board = await adapter.rpc(api.uiSnapshot, {});
  assert.ok(!("unchanged" in board) && board.paused);
  await adapter.rpc(api.queueControl, { paused: false });
  assert.equal(fake.mode(), "running");
  assert.ok(fake.writes.every((write) => write.domain === "dispatch"));
  assert.deepEqual(fake.writes.map((write) => write.body.revision), ["1", "2", "3", "4"]);
});

test("a profile write keeps the engine's fields this client does not know", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  const result = await adapter.rpc(api.configureProfile, {
    profileId: "w", enabled: true, group: "team-b", roles: ["worker"], capability: "heavyweight", weight: "more", scopes: ["general"],
  });
  assert.equal(result.entry?.group, "team-b");
  const written = fake.writes[0]!.body.value as { profiles: Array<Record<string, unknown>> };
  assert.equal(written.profiles[0]!.unrated, true);
  assert.equal(written.profiles[0]!.providerInstanceId, "codex-1");
  assert.deepEqual(written.profiles[0]!.selection, {
    id: "w", provider: "codex", model: "m", effort: "high", capability: "heavyweight", weight: "more",
  });
});

test("shared Limits writes sparse project overrides and the two Dispatch defaults", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  await adapter.rpc(api.uiSnapshot, {});
  const { effective } = await adapter.rpc(api.capacityState, {});
  assert.equal(effective.projectLimit, 2);
  await adapter.rpc(api.configureCapacity, { ...effective, globalLimit: 8, projectLimit: 4 });
  for (const limit of [5, null, 0]) {
    const projectKey = "p-orbit-main";
    await adapter.rpc(api.configureProjectDispatchLimit, { projectKey, limit });
    const board = await adapter.rpc(api.uiSnapshot, {});
    assert.ok(!("unchanged" in board));
    assert.equal(board.globalLimit, 8);
    assert.equal(board.projectLimit, 4);
    assert.deepEqual(board.projectLimitOverrides, limit === null ? {} : { [projectKey]: limit });
  }
  assert.ok(fake.writes.every((write) => write.domain === "dispatch"));
});

test("retired machinery is refused by name instead of guessed", async () => {
  const adapter = createRustAdapter(createRustApi(engine().fetcher));
  await assert.rejects(adapter.rpc(api.refreshCatalog, {}), RustUnsupported);
  assert.deepEqual(
    ["orbit", "Orbit_Main", "orbit.main"].map(projectKeys(["orbit", "Orbit_Main", "orbit.main"]).key),
    ["orbit", "p-orbit-main", "p-orbit-main-2"],
  );
});

test("the archive control writes the Projects domain", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  await adapter.rpc(api.uiSnapshot, {});
  await adapter.rpc(rustProjectArchive, { project: "p-orbit-main", archived: true });
  const projects = fake.writes.find((write) => write.domain === "projects")!.body.value as {
    projects: Record<string, { archived: boolean }>;
  };
  assert.equal(projects.projects.Orbit_Main!.archived, true);
  const board = await adapter.rpc(api.uiSnapshot, {});
  assert.ok(!("unchanged" in board) && board.projects.length === 0, "an archived project leaves the board");
});
