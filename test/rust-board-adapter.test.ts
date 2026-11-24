import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { useNativeStubs, mount } from "./support/render";
import {
  EngineFeaturesContext,
  RUST_ENGINE_FEATURES,
} from "../client/engine-features";
import { waitFor, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS } from "./support/budgets";
import * as api from "../shared/contracts";
import { createRustApi } from "../client/web/rust-api";
import {
  createRustAdapter,
  projectKeys,
  RustUnsupported,
} from "../client/web/rust-adapter";
import { rustProfileUsage, rustProjectArchive } from "../client/rust-contracts";
import { profileUsage } from "../client/settings-profile-helpers";
import { nightlyProviders } from "./support/pool-shapes";
import type {
  RustCachedCatalog,
  RustBrowserSession,
  RustProfileUsage,
} from "../client/web/rust-api";

/**
 * The Rust engine's board adapter (Spec 070 ruling 4): the shared screens'
 * contracts answered from the engine's paired API. The fake below speaks the
 * engine's wire shapes (`engine/crates/nucleus-service/src/web/settings.rs`),
 * including a field this client does not know, and records every write.
 */

function engine() {
  let session: RustBrowserSession = {
    id: "operator-session",
    canEditSettings: true,
    planningProjects: null,
  };
  const denied = new Set<string>();
  let dispatch = {
    usage: "normal", usageUntilMs: null, globalSlots: 4, projectDefaultSlots: 2,
    projectSlotOverrides: { Orbit_Main: 3, lantern: 1 },
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
      { origin: "example/orbit-docs", path: "/work/orbit-docs", base: "main", requiredChecks: [], hungToolMinutes: 30 },
    ] },
    lantern: { name: "Lantern", archived: false, repositories: [
      { origin: "example/lantern", path: "/work/lantern", base: "main", requiredChecks: [], hungToolMinutes: 30 },
    ] },
  } };
  let catalog: RustCachedCatalog = { providers: null, readAtMs: null, status: "pending" };
  const empty = { counts: {}, groups: {}, sample: 0 };
  let usage: RustProfileUsage = { recent: empty, worker: empty, reviewer: empty, totals: {}, groupTotals: {} };
  const reads: string[] = [];
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
    reads.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/session") return json(session);
    if (path === "/profiles/catalog") return json(catalog);
    if (path === "/profiles/usage") return json(usage);
    if (path === "/settings") return json(Object.fromEntries(Object.entries(views).map(([key, view]) => [key, view()])));
    if (path === "/tasks") return json([]);
    if (path === "/settings/projects/Orbit_Main/removal") {
      const project = projects.projects.Orbit_Main;
      if (init?.method !== "POST") {
        return json({ project, digest: "confirmed-revision", tasks: [] });
      }
      assert.deepEqual(JSON.parse(String(init.body)), { digest: "confirmed-revision", reason: "Retired" });
      projects = { projects: { ...projects.projects } };
      Reflect.deleteProperty(projects.projects, "Orbit_Main");
      return json({ repositories: project.repositories, removedAtMs: 1_790_000_000_000 });
    }
    if (path === "/settings/projects/reassign") {
      const body = JSON.parse(String(init?.body)) as { revision: string; origin: string; toProject: string };
      writes.push({ domain: "reassign", body: { revision: body.revision, value: body } });
      const all: Record<string, { repositories: typeof projects.projects.Orbit_Main.repositories }> = projects.projects;
      const from = Object.values(all).find((project) => project.repositories.some((repo) => repo.origin === body.origin))!;
      const repo = from.repositories.find((candidate) => candidate.origin === body.origin)!;
      from.repositories = from.repositories.filter((candidate) => candidate !== repo);
      all[body.toProject]!.repositories.push(repo);
      revisions.projects = (revisions.projects ?? 1) + 1;
      return json(views.projects!());
    }
    const domain = /^\/settings\/(\w+)$/.exec(path)?.[1];
    if (domain && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { revision: string; value: never };
      if (Number(body.revision) !== revisions[domain]) {
        return new Response(JSON.stringify({ error: { message: "Revision changed" } }), { status: 409 });
      }
      writes.push({ domain, body });
      if (domain === "dispatch") dispatch = body.value;
      if (domain === "profiles") profiles = body.value;
      if (domain === "projects") projects = body.value;
      revisions[domain] = (revisions[domain] ?? 1) + 1;
    }
    if (domain) return json(views[domain]!());
    const [, project, collection] = /^\/planning\/([^/]+)\/(plan|items|decisions)$/.exec(path) ?? [];
    if (project && (denied.has(project) ||
      (session.planningProjects !== null && !session.planningProjects.includes(project)))) {
      return Response.json({ error: "controller is not authorized for this project" }, { status: 403 });
    }
    if (collection === "plan") return json({
      version: 1,
      lanes: [{ key: "delivery", horizon: "now", doneWhen: "", statusNote: "In progress" }],
      documents: [{
        key: "delivery", version: 1, title: "Delivery", aim: "Ship the change",
        document: "Fixture Markdown", status: "open",
      }],
      idle: false,
    });
    if (collection === "items") return json([{
      id: `i-${project}`, kind: "lead", author: "planner", title: "An idea",
      body: "Fixture idea", lanes: ["delivery"], state: "open", createdAtMs: 10,
    }, {
      id: "promoted", kind: "papercut", author: "planner", title: "Fixed", body: "",
      lanes: [], state: "promoted", taskId: "finished", taskLinks: ["finished"],
      createdAtMs: 100, updatedAtMs: 200,
    }]);
    if (collection === "decisions") return json([{
      id: `d-${project}`, projectId: project, author: "planner",
      question: "Which path should we take?", createdAtMs: 1_790_000_000_000,
      options: [{ id: "first", label: "First" }, { id: "second", label: "Second" }],
      answer: null,
    }]);
    return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
  }) as typeof fetch;
  return {
    fetcher, writes, reads, denied,
    planningReads: () => reads.filter((path) => path.startsWith("GET /planning/")),
    setSession: (next: RustBrowserSession) => { session = next; },
    setProfiles: (next: unknown, pausedGroups: string[]) => { profiles = { profiles: next, pausedGroups }; },
    mode: () => dispatch.mode,
    setCatalog: (next: RustCachedCatalog) => { catalog = next; },
    setUsage: (next: RustProfileUsage) => { usage = next; },
  };
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
  assert.deepEqual(board.projects.map((project) => [project.key, project.name]), [["p-orbit-main", "Orbit"], ["lantern", "Lantern"]]);
  assert.deepEqual(board.projects[0]!.repositories.map((repo) => repo.origin), ["example/orbit", "example/orbit-docs"]);
  assert.deepEqual(board.projectLimitOverrides, { "p-orbit-main": 3, lantern: 1 });
  assert.deepEqual(board.pool.map((entry) => [entry.profileId, entry.group, entry.roles]), [["w", "team", ["worker", "reviewer"]]]);
  assert.deepEqual(fake.reads, ["GET /settings", "GET /session"]);
  const storage = await adapter.rpc(api.workStorage, {});
  assert.equal(storage.backups?.newestAt, "2026-11-24T08:00:00Z");
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
    assert.deepEqual(board.projectLimitOverrides, limit === null ? { lantern: 1 } : { lantern: 1, [projectKey]: limit });
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
  assert.ok(!("unchanged" in board) && board.projects.length === 1, "an archived project leaves the board");
});

test("the Rust adapter ports project removal through one native resource", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  await adapter.rpc(api.uiSnapshot, {});
  const key = "p-orbit-main";
  const preview = await adapter.rpc(api.projectManagementPreview, { key });
  assert.equal(preview.project.name, "Orbit");
  assert.deepEqual(preview.tasks, []);
  const removed = await adapter.rpc(api.projectManage, {
    key, version: preview.project.version, digest: preview.digest, reason: "Retired",
  });
  assert.equal(removed.key, key);
  const board = await adapter.rpc(api.uiSnapshot, {});
  assert.ok(!("unchanged" in board) && !board.projects.some((project) => project.key === key));
  assert.deepEqual(fake.reads.filter((read) => read.endsWith("/removal")),
    ["GET /settings/projects/Orbit_Main/removal", "POST /settings/projects/Orbit_Main/removal"]);
});

test("moving a repository in the shared Projects editor reassigns it in the engine", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  await adapter.rpc(api.uiSnapshot, {});
  assert.deepEqual(await adapter.rpc(api.projectMergeCheck, { source: "p-orbit-main" }), { blockers: [], carried: [] });
  const moved = await adapter.rpc(api.projectMerge, {
    source: "p-orbit-main", target: "lantern", versions: { source: 1, target: 1 },
    repository: "example/orbit-docs", reason: "Added to Lantern in Settings",
  });
  assert.deepEqual(moved.project.repositories.map((repo) => repo.origin), ["example/lantern", "example/orbit-docs"]);
  assert.deepEqual(moved.source?.repositories.map((repo) => repo.origin), ["example/orbit"]);
  const reassign = fake.writes.find((write) => write.domain === "reassign")!.body.value as Record<string, string>;
  assert.deepEqual([reassign.origin, reassign.toProject], ["example/orbit-docs", "lantern"]);
  await assert.rejects(
    adapter.rpc(api.projectUpsert, { key: "lantern", name: "Lantern", repositories: [{ origin: "example/new", path: "" }] }),
    /first dispatch/,
  );
});

test("profile identity and pool saves persist independently through the paired settings revision", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  const created = await adapter.rpc(api.createNucleusProfile, {
    name: "Codex test",
    provider: "codex",
    model: "gpt-6-luna",
    modeId: "supervised",
    thinkingOptionId: "high",
    featureValues: { speed: "default" },
  });
  const { id } = created.profile;
  assert.notEqual(id, "w");
  const [saved] = await Promise.all([
    adapter.rpc(api.updateNucleusProfile, {
      id,
      name: "Claude test",
      provider: "claude",
      model: "claude-haiku-5-5",
      modeId: "full-access",
      thinkingOptionId: "ultra",
      featureValues: { ultracode: "on" },
    }),
    adapter.rpc(api.configureProfile, {
      profileId: id,
      group: "synthetic team",
      enabled: true,
      roles: ["reviewer"],
      capability: "heavyweight",
      weight: "more",
      scopes: ["general"],
    }),
  ]);
  const reloaded = createRustAdapter(createRustApi(fake.fetcher));
  assert.deepEqual(
    (await reloaded.rpc(api.listNucleusProfiles, {})).profiles.at(-1),
    saved.profile,
  );
  const board = await reloaded.rpc(api.uiSnapshot, {});
  assert.ok(!("unchanged" in board));
  assert.deepEqual(
    board.pool.find((entry) => entry.profileId === id),
    {
      profileId: id,
      group: "synthetic team",
      enabled: true,
      roles: ["reviewer"],
      capability: "heavyweight",
      weight: "more",
      scopes: ["general"],
    },
  );
  assert.deepEqual(
    fake.writes.map((write) => write.body.revision),
    ["1", "2", "3"],
  );
  assert.ok(fake.writes.every(({ domain }) => domain === "profiles"));
});

test("Refresh takes the newest held revision and retains usable choices on failure", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  assert.equal(
    (await adapter.rpc(api.readProfileVocabulary, {})).cacheStatus,
    "pending",
  );
  await assert.rejects(
    adapter.rpc(api.readProfileVocabulary, { refresh: true }),
    /not published/,
  );
  const current: RustCachedCatalog = {
    status: "current",
    readAtMs: 1_790_000_000_000,
    providers: [
      { instanceId: "broken", models: "wrong shape" },
      ...nightlyProviders(),
      {
        instanceId: "other-claude",
        driver: "claudeAgent",
        enabled: true,
        status: "ready",
        models: [
          {
            slug: "legacy",
            name: null,
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  type: "select",
                  currentValue: [],
                  options: [null, { id: "ultrathink" }],
                },
                { id: "bad", type: "unknown" },
              ],
            },
          },
          { slug: "no-capabilities", capabilities: null },
          { name: "Missing ID" },
        ],
      },
    ],
  };
  fake.setCatalog(current);
  const first = await adapter.rpc(api.readProfileVocabulary, {});
  const legacy = first.providers
    .find((provider) => provider.key === "claude")
    ?.models.find((model) => model.id === "legacy");
  assert.equal(legacy?.label, "legacy");
  assert.deepEqual(legacy?.thinkingOptions, [{ id: "ultra", label: "Ultra" }]);
  assert.deepEqual(legacy?.features, []);
  assert.ok(first.providers.some(({ key }) => key === "codex"));
  const validProviders = [
    {
      instanceId: "codex",
      enabled: true,
      status: "ready",
      models: [{ slug: "replacement", name: "Replacement" }],
    },
  ];
  fake.setCatalog({
    ...current,
    readAtMs: 1_790_000_001_000,
    providers: validProviders,
  });
  const changed = await adapter.rpc(api.readProfileVocabulary, {
    refresh: true,
  });
  assert.deepEqual(
    changed.providers[0]?.models.map(({ id, label }) => [id, label]),
    [["replacement", "Replacement"]],
  );
  assert.notEqual(first.readAt, changed.readAt);
  fake.setCatalog({ ...current, status: "stale", providers: validProviders });
  await assert.rejects(
    adapter.rpc(api.readProfileVocabulary, { refresh: true }),
    /temporarily unavailable/,
  );
  const retained = await adapter.rpc(api.readProfileVocabulary, {});
  assert.deepEqual(retained.providers, changed.providers);
  assert.equal(retained.cacheStatus, "stale");
  assert.ok(fake.reads.every((path) => path === "GET /profiles/catalog"));
});

test("the shared usage strips project recorded zero and active role windows", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  const zero = await adapter.rpc(rustProfileUsage, {});
  assert.deepEqual(profileUsage(zero, "w", ["w"]), {
    count: 0,
    max: 0,
    sample: 0,
  });
  fake.setUsage({
    recent: { counts: { w: 3, removed: 7 }, groups: { team: 3 }, sample: 10 },
    worker: { counts: { w: 2, removed: 7 }, groups: { team: 2 }, sample: 9 },
    reviewer: { counts: { w: 1 }, groups: { team: 1 }, sample: 1 },
    totals: { w: 12 },
    groupTotals: { team: 16 },
  });
  const active = await adapter.rpc(rustProfileUsage, {});
  assert.deepEqual(profileUsage(active, "w", ["w"]), {
    count: 3,
    max: 3,
    sample: 10,
  });
  assert.deepEqual(profileUsage(active, "w", ["w"], "worker"), {
    count: 2,
    max: 2,
    sample: 9,
  });
  assert.deepEqual(profileUsage(active, "w", ["w"], "reviewer"), {
    count: 1,
    max: 1,
    sample: 1,
  });
  assert.equal(active.assignments["profile:w"], 12);
  assert.equal(active.assignments.team, 16);
});

test("paired operator and planner Profiles show stored flags, subscriptions and usage", async (t) => {
  const fake = engine();
  fake.setProfiles([
    { name: "Worker", group: "team", selection: {
      id: "w", provider: "codex", model: "m", effort: "high", capability: "worker", weight: "default",
    } },
    { name: "Reserve", enabled: false, group: "reserve", selection: {
      id: "r", provider: "codex", model: "m", effort: null, capability: "worker", weight: "default",
    } },
  ], ["team"]);
  const worker = { counts: { w: 50 }, groups: { team: 50 }, sample: 50 };
  fake.setUsage({
    recent: worker, worker, reviewer: { counts: {}, groups: {}, sample: 0 },
    totals: { w: 50 }, groupTotals: { team: 50 },
    limitedGroups: { reserve: Date.now() + 3_600_000 },
  });
  useNativeStubs();
  const { ProfilesPanel } = await import("../client/settings-profiles");
  for (const canEditSettings of [true, false]) {
    const adapter = createRustAdapter(createRustApi(fake.fetcher));
    fake.setSession({
      id: canEditSettings ? "operator-session" : "planner-session",
      canEditSettings,
      planningProjects: canEditSettings ? null : ["Orbit_Main"],
    });
    const board = await adapter.rpc(api.uiSnapshot, {});
    assert.ok(!("unchanged" in board));
    const usage = await adapter.rpc(rustProfileUsage, {});
    const state = { ...board, ...usage, availability: [...board.availability, ...usage.availability] };
    assert.equal(state.canEditSettings, canEditSettings);
    assert.deepEqual(state.pool.map(({ enabled }) => enabled), [true, false]);
    assert.deepEqual(state.availability.map(({ group, unavailable }) => [group, unavailable]),
      [["team", true], ["reserve", true]]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const h = React.createElement;
    const ui = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, {
      invoke: ((method: string, input: never) => {
        switch (method) {
          case "profile.list": return adapter.rpc(api.listNucleusProfiles, input);
          case "profile.compatibility": return adapter.rpc(api.readProfileCompatibility, input);
          case "profile.vocabulary": return adapter.rpc(api.readProfileVocabulary, input);
          default: throw new Error(`Unexpected profile RPC ${method}`);
        }
      }) as never,
      children: h(EngineFeaturesContext.Provider, {
      value: RUST_ENGINE_FEATURES,
      children: h(ProfilesPanel, {
        c: new Proxy({}, { get: () => "#123" }) as never,
        compact: false, inset: 0, state, repositories: [], busy: false,
        savePool: async () => {}, savePoolList: async () => true, saveAvailability: async () => {},
      }),
    }) }) }));
    t.after(() => { ui.update(h(React.Fragment)); client.clear(); });
    assert.ok(ui.query("Worker, all roles: 50 of 50 recent assignments"));
    assert.ok(ui.query("Reserve, all roles: 0 of 50 recent assignments"));
    assert.doesNotMatch(ui.text(), /Reading subscriptions/);
    assert.match(ui.text(), /Unavailable until/);
    assert.equal(Boolean(ui.query("Edit Worker")), canEditSettings);
    assert.equal(ui.get(canEditSettings ? "Disable Worker" : "Worker: On").props.disabled, !canEditSettings);
    assert.equal(ui.get(canEditSettings ? "Enable Reserve" : "Reserve: Off").props.disabled, !canEditSettings);
  }
  assert.deepEqual(fake.planningReads(), []);
});

test("Rust board loads scoped collections on entry and shares them across views", async (t) => {
  const fake = engine();
  fake.setSession({ id: "planner-session", canEditSettings: false, planningProjects: ["Orbit_Main"] });
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  useNativeStubs();
  const { useBoardState } = await import("../client/board-state");
  const { useRecordQueries } = await import("../client/board/use-board-data");
  const { useInboxBoard } = await import("../client/board/inbox-list");
  const { createPushInvalidator } = await import("../client/web/rust-board");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invoke = (method: string, input: never) => {
    switch (method) {
      case "queue.ui-snapshot": return adapter.rpc(api.uiSnapshot, input);
      case "queue.plans": return adapter.rpc(api.plans, input);
      case "lead.board": return adapter.rpc(api.leadBoard, input);
      case "decision.list": return adapter.rpc(api.decisionList, input);
      default: throw new Error(`Unexpected board RPC ${method}`);
    }
  };
  const h = React.createElement;
  function Records({ view }: { view: "needs" | "planning" | "leads" | "queue" }) {
    const { state, stateQuery } = useBoardState();
    const records = useRecordQueries({
      state, stateQuery, tab: view === "planning" ? view : "queue", scopeOpen: false,
    });
    const inbox = useInboxBoard({
      state, selection: [], boardLeads: records.boardLeads, leadLinks: records.leadLinks,
      decisions: records.decisionsQuery.data, hiddenQueued: 0, triageTag: null,
    });
    return h("result", {}, JSON.stringify({
      projects: state?.projects.map(({ key }) => key),
      needs: inbox.counts.needs,
      decisions: records.decisionsQuery.data?.map(({ question }) => question),
      leads: records.leadsQuery.data?.cards.length,
      lanes: records.planQuery.data?.flatMap(({ laneViews }) => laneViews?.map(({ title }) => title) ?? []),
    }));
  }
  const render = (view: Parameters<typeof Records>[0]["view"]) =>
    h(QueryClientProvider, { client, children: h(PluginRpcProvider, {
      invoke: invoke as never,
      children: h(EngineFeaturesContext.Provider, {
        value: RUST_ENGINE_FEATURES, children: h(Records, { view }),
      }),
    }) });
  const ui = mount(render("queue"));
  t.after(() => { ui.update(h(React.Fragment)); client.clear(); });
  const wait = (pattern: RegExp) => waitFor(
    () => pattern.test(ui.text()), HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, pattern.source,
  );
  await wait(/p-orbit-main.*"needs":1.*Which path should we take.*"leads":1,"lanes":\["Delivery"\]/);
  const scopedReads = [
    "GET /planning/Orbit_Main/decisions", "GET /planning/Orbit_Main/items", "GET /planning/Orbit_Main/plan",
  ];
  assert.deepEqual(fake.planningReads().sort(), scopedReads);
  ui.update(render("planning"));
  ui.update(render("leads"));
  await client.refetchQueries({ queryKey: ["nucleus", "state"] });
  assert.deepEqual(fake.planningReads().sort(), scopedReads, "view changes and board revisions reuse the collections");

  ui.update(render("queue"));
  const push = createPushInvalidator(client);
  push({ queryKey: ["nucleus", "decisions"] });
  await waitFor(() => fake.planningReads().length === 4, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, "decisions refresh outside Needs you");
  assert.deepEqual(fake.planningReads().slice(3), ["GET /planning/Orbit_Main/decisions"]);
  assert.equal(await adapter.refreshSession(), false);
  push({ queryKey: ["nucleus"] });
  await waitFor(() => fake.planningReads().length === 7, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, "reconnect refresh");
  assert.deepEqual(fake.planningReads().slice(4).sort(), scopedReads);
});

test("a project refusal settles lists until the paired session changes", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  fake.denied.add("lantern");
  const decisions = () => adapter.rpc(api.decisionList, { status: "open" });
  assert.deepEqual((await decisions()).map(({ id }) => id), ["d-Orbit_Main"]);
  assert.deepEqual(fake.planningReads(), [
    "GET /planning/Orbit_Main/decisions", "GET /planning/lantern/decisions",
  ]);
  fake.denied.clear();
  assert.equal(await adapter.refreshSession(), false, "the same session reconnects");
  await adapter.rpc(api.plans, {});
  const leads = await adapter.rpc(api.leadBoard, {});
  assert.deepEqual(leads.cards.map(card => card.id), ["i-Orbit_Main"]);
  assert.deepEqual(leads.activity?.map(({ id, at, taskIds }) => [id, at, taskIds]), [
    ["i-Orbit_Main", new Date(10).toISOString(), []],
    ["promoted", new Date(200).toISOString(), ["finished"]],
  ]);
  assert.deepEqual((await decisions()).map(({ id }) => id), ["d-Orbit_Main"]);
  assert.equal(fake.planningReads().filter((path) => path.includes("/lantern/")).length, 1);
  fake.setSession({ id: "new-operator-session", canEditSettings: true, planningProjects: null });
  assert.equal(await adapter.refreshSession(), true);
  assert.deepEqual((await decisions()).map(({ id }) => id), ["d-Orbit_Main", "d-lantern"]);
});

test("the paired Profiles panel adds, edits, and duplicates using the shared controls", async (t) => {
  const fake = engine();
  const catalog: RustCachedCatalog = {
    providers: nightlyProviders(),
    status: "current",
    readAtMs: 1_790_000_000_000,
  };
  fake.setCatalog(catalog);
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  const state = await adapter.rpc(api.uiSnapshot, {});
  assert.ok(!("unchanged" in state));
  useNativeStubs();
  const h = React.createElement;
  const { ProfilesPanel } = await import("../client/settings-profiles");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  t.after(() => client.clear());
  const vocabulary = ["nucleus", "profile-vocabulary", ""];
  client.setQueryData(
    vocabulary,
    await adapter.rpc(api.readProfileVocabulary, {}),
  );
  client.setQueryData(
    ["nucleus", "profiles"],
    await adapter.rpc(api.listNucleusProfiles, {}),
  );
  const invoke = (method: string, input: never): Promise<unknown> => {
    switch (method) {
      case "profile.vocabulary":
        return adapter.rpc(api.readProfileVocabulary, input);
      case "profile.compatibility":
        return adapter.rpc(api.readProfileCompatibility, input);
      case "profile.list":
        return adapter.rpc(api.listNucleusProfiles, input);
      case "profile.create":
        return adapter.rpc(api.createNucleusProfile, input);
      case "profile.update":
        return adapter.rpc(api.updateNucleusProfile, input);
      default:
        throw new Error(`Unexpected profile RPC ${method}`);
    }
  };
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: invoke as never,
        children: h(EngineFeaturesContext.Provider, {
          value: RUST_ENGINE_FEATURES,
          children: h(ProfilesPanel, {
            c: new Proxy({}, { get: () => "#123" }) as never,
            compact: false,
            inset: 0,
            state,
            repositories: [],
            busy: false,
            savePool: async () => {},
            savePoolList: async () => true,
            saveAvailability: async () => {},
          }),
        }),
      }),
    }),
  );
  assert.ok(ui.query("Worker, all roles: 0 of 0 recent assignments"));
  assert.equal(ui.query("Coordinators"), undefined);
  ui.press("Add profile");
  ui.type("Name", "Shared profile");
  ui.press("Provider, Choose a provider");
  ui.press("Provider: Codex");
  ui.press("Model, Choose a model");
  ui.press("Model: Luna, gpt-6-luna");
  const wait = (ready: () => boolean, reason: string) =>
    waitFor(ready, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, reason);
  await wait(
    () => Boolean(ui.query("Duplicate Shared profile")),
    "the new profile's editor",
  );
  assert.equal(ui.all(/^Thinking, /).length, 1);
  ui.press("Provider, Codex");
  ui.press("Provider: Claude");
  ui.press("Model, Choose a model");
  ui.press("Model: Haiku, claude-haiku-5-5");
  await wait(() => fake.writes.length === 2, "the provider and model edit");
  const list = () =>
    adapter.rpc(api.listNucleusProfiles, {}).then((value) => value.profiles);
  const initial = (await list()).find(({ name }) => name === "Shared profile");
  assert.ok(initial);
  assert.deepEqual(
    [initial.provider, initial.model],
    ["claude", "claude-haiku-5-5"],
  );
  await wait(
    () =>
      client
        .getQueryData<{
          profiles: Awaited<ReturnType<typeof list>>;
        }>(["nucleus", "profiles"])
        ?.profiles.some(({ model }) => model === initial.model) === true,
    "the saved identity to reach the editor",
  );
  ui.press("Duplicate Shared profile");
  await wait(() => fake.writes.length === 3, "the duplicate to save");
  const copy = (await list()).find(
    ({ name }) => name === "Shared profile copy",
  );
  assert.ok(copy);
  assert.notEqual(copy.id, initial.id);
  assert.deepEqual(copy, { ...initial, id: copy.id, name: copy.name });
  await adapter.rpc(api.updateNucleusProfile, {
    id: copy.id,
    thinkingOptionId: "ultra",
  });
  assert.deepEqual(
    (await list()).find(({ id }) => id === initial.id),
    initial,
  );

  ui.press("Refresh providers and models");
  await wait(
    () => ui.text().includes("Providers and models refreshed."),
    "the Refresh receipt",
  );
  fake.setCatalog({ ...catalog, status: "stale" });
  ui.press("Refresh providers and models");
  await wait(() => ui.text().includes("Refresh failed"), "the Refresh failure");
  assert.ok(
    ui.query("Model, Haiku, claude-haiku-5-5"),
    "the last usable options remain",
  );
});
