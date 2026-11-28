import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import {
  createRustBoardTransport,
  createRustInvalidator,
} from "../client/web/rust-board";
import { rustTaskCard } from "./support/rust-task-card";
import { useNativeStubs, mount } from "./support/render";
import { waitFor, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS } from "./support/budgets";
import * as api from "../shared/contracts";
import { createRustApi, namedProfile } from "../client/web/rust-api";
import {
  createRustAdapter,
  projectKey,
  projectId,
  RustUnsupported,
} from "../client/web/rust-adapter";
import { readProjectScope, writeProjectScope } from "../shared/project-scope";
import { listenForPlanningIssues } from "../client/web/rust-planning";
import { rustProfileUsage, rustProjectArchive } from "../client/rust-contracts";
import { profileUsage } from "../client/settings-profile-helpers";
import { nightlyProviders } from "./support/pool-shapes";
import type { HostList } from "../client/hosts-settings";
import type {
  RustCachedCatalog,
  RustLane,
  RustBrowserSession,
  RustProfileUsage,
} from "../client/web/rust-api";

/**
 * The Rust engine's board adapter (Spec 070 ruling 4): the shared screens'
 * contracts answered from the engine's paired API. The fake below speaks the
 * engine's wire shapes (`engine/crates/nucleus-service/src/web/settings.rs`),
 * including a field this client does not know, and records every write.
 */

function engine(laneByProject: Record<string, RustLane> = {}) {
  const questions = new Map<string, string>();
  let session: RustBrowserSession = {
    id: "operator-session",
    canEditSettings: true,
    planningProjects: null,
  };
  const denied = new Set<string>();
  let dispatch = {
    usage: "normal",
    usageUntilMs: null,
    heavySlots: 2,
    normalSlots: 1,
    lightSlots: 1,
    projectDefaultSlots: 2,
    projectSlotOverrides: { Orbit_Main: 3, lantern: 1 },
    mode: "running",
  };
  let t3Settings: { endpoint: string; credentialRef: string } | null = {
    endpoint: "http://127.0.0.1:3773/",
    credentialRef: "T3",
  };
  let profiles: Record<string, unknown> = {
    profiles: [
      {
        name: "Worker",
        group: "team",
        selection: {
          id: "w",
          provider: "codex",
          model: "m",
          effort: "high",
          capability: "worker",
          weight: "default",
        },
        unrated: true,
        providerInstanceId: "codex-1",
      },
    ],
    pausedGroups: [],
  };
  let offeredGroups: Record<string, string> = {};
  let projects = {
    projects: {
      Orbit_Main: {
        name: "Orbit",
        archived: false,
        plannerClaim: { thread: "claimed-thread", occurrence: "claim-1" } as
          | { thread: string; occurrence: string }
          | undefined,
        repositories: [
          {
            origin: "example/orbit",
            path: "/work/orbit",
            base: "main",
            hostProjectTitle: "Orbit",
          },
          {
            origin: "example/orbit-docs",
            path: "/work/orbit-docs",
            base: "main",
            hostProject: "t3-orbit-docs",
          },
        ],
      },
      lantern: {
        name: "Lantern",
        archived: false,
        repositories: [
          {
            origin: "example/lantern",
            path: "/work/lantern",
            base: "main",
          },
        ],
      },
    },
  };
  let removalReceipt:
    | {
        repositories: Array<{ origin: string; path: string }>;
        removedAtMs: number;
      }
    | undefined;
  let loseRemovalReply = false;
  let catalog: RustCachedCatalog = {
    providers: null,
    readAtMs: null,
    status: "pending",
  };
  const empty = { counts: {}, groups: {}, sample: 0 };
  let usage: RustProfileUsage = {
    recent: empty,
    worker: empty,
    reviewer: empty,
    totals: {},
    groupTotals: {},
  };
  const reads: string[] = [];
  const dispositions: unknown[] = [];
  const revisions: Record<string, number> = {
    dispatch: 1,
    profiles: 1,
    projects: 1,
  };
  const writes: Array<{
    domain: string;
    body: { revision: string; value: unknown };
  }> = [];
  const snap = (value: unknown, domain: string) => ({
    value,
    revision: String(revisions[domain] ?? 1),
    configured: true,
  });
  const views: Record<string, () => unknown> = {
    dispatch: () => snap(dispatch, "dispatch"),
    profiles: () => {
      const groups = new Map(Object.entries(offeredGroups));
      if (Array.isArray(profiles.profiles)) {
        for (const entry of profiles.profiles) {
          const profile = namedProfile.parse(entry);
          const configured = profile.group ?? profile.providerInstanceId;
          if (configured) groups.set(profile.selection.id, configured);
        }
      }
      return {
        ...snap(profiles, "profiles"),
        effectiveGroups: Object.fromEntries(groups),
      };
    },
    projects: () => ({
      settings: snap(projects, "projects"),
      resolvedPlanners: { Orbit_Main: "thread-1" },
      verifiedPlanners: { Orbit_Main: ["thread-1", "claimed-thread"] },
    }),
    hosts: () => ({
      settings: snap({ t3: t3Settings }, "hosts"),
      active: { endpoint: "http://127.0.0.1:3773/", status: "reachable" },
    }),
    storage: () => ({
      settings: snap(
        {
          enabled: true,
          workRoot: null,
          scratchRoot: null,
          logRoot: null,
          retention: { keepNewest: 5, maxAgeDays: null },
        },
        "storage",
      ),
      active: {
        databaseRoot: "/e/db",
        workRoot: "/e/work",
        backupRoot: "/e/backups",
        scratchRoot: "/e/scratch",
        logRoot: "/e/logs",
      },
      configBackups: {
        complete: true,
        issues: 1,
        verified: [{ id: "c1", createdAt: "2026-11-25T09:00:00Z" }],
      },
      backups: {
        complete: true,
        issues: 0,
        verified: [{ id: "b1", createdAt: "2026-11-24T08:00:00Z" }],
      },
    }),
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace("/api/engine", "");
    assert.equal(new Headers(init?.headers).get("x-nucleus-board"), "1");
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    reads.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/session") return json(session);
    if (path === "/profiles/catalog") return json(catalog);
    if (path === "/profiles/usage") return json(usage);
    if (path === "/settings")
      return json(
        Object.fromEntries(
          Object.entries(views).map(([key, view]) => [key, view()]),
        ),
      );
    if (path === "/tasks") return json([]);
    if (path === "/settings/projects/Orbit_Main/clear-planner") {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), {
        revision: String(revisions.projects),
      });
      projects.projects.Orbit_Main.plannerClaim = undefined;
      revisions.projects = (revisions.projects ?? 1) + 1;
      return json(views.projects!());
    }
    if (path === "/settings/projects/Orbit_Main/removal") {
      const project = projects.projects.Orbit_Main;
      if (init?.method !== "POST") {
        return json({ project, digest: "confirmed-revision", tasks: [] });
      }
      assert.deepEqual(JSON.parse(String(init.body)), {
        digest: "confirmed-revision",
        reason: "Retired",
      });
      if (!removalReceipt) {
        projects = { projects: { ...projects.projects } };
        Reflect.deleteProperty(projects.projects, "Orbit_Main");
        removalReceipt = {
          repositories: project.repositories.map(({ origin, path }) => ({
            origin,
            path,
          })),
          removedAtMs: 1_790_000_000_000,
        };
        if (loseRemovalReply) throw new TypeError("removal reply lost");
      }
      return json(removalReceipt);
    }
    if (path === "/settings/projects/reassign") {
      const body = JSON.parse(String(init?.body)) as {
        revision: string;
        origin: string;
        toProject: string;
      };
      writes.push({
        domain: "reassign",
        body: { revision: body.revision, value: body },
      });
      type FixtureRepository = {
        origin: string;
        path: string;
        base: string;
        hostProject?: string;
        hostProjectTitle?: string;
      };
      const all: Record<string, { repositories: FixtureRepository[] }> =
        projects.projects;
      const from = Object.values(all).find((project) =>
        project.repositories.some((repo) => repo.origin === body.origin),
      )!;
      const repo = from.repositories.find(
        (candidate) => candidate.origin === body.origin,
      )!;
      from.repositories = from.repositories.filter(
        (candidate) => candidate !== repo,
      );
      all[body.toProject]!.repositories.push(repo);
      revisions.projects = (revisions.projects ?? 1) + 1;
      return json(views.projects!());
    }
    const domain = /^\/settings\/(\w+)$/.exec(path)?.[1];
    if (domain && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        revision: string;
        value: never;
      };
      if (Number(body.revision) !== revisions[domain]) {
        return new Response(
          JSON.stringify({ error: { message: "Revision changed" } }),
          { status: 409 },
        );
      }
      writes.push({ domain, body });
      if (domain === "projects") projects = body.value;
      if (domain === "dispatch") dispatch = body.value;
      if (domain === "profiles") profiles = body.value;
      if (domain === "projects") projects = body.value;
      revisions[domain] = (revisions[domain] ?? 1) + 1;
    }
    if (domain) return json(views[domain]!());
    const [, project, collection] =
      /^\/planning\/([^/]+)\/(plan|items|decisions)$/.exec(
        path.split("?")[0]!,
      ) ?? [];
    if (
      project &&
      (denied.has(project) ||
        (session.planningProjects !== null &&
          !session.planningProjects.includes(project)))
    ) {
      return Response.json(
        { error: "controller is not authorized for this project" },
        { status: 403 },
      );
    }
    const [, laneProject, laneKey, laneAction] =
      /^\/planning\/([^/]+)\/lanes\/([^/]+)(?:\/(status))?$/.exec(path) ?? [];
    if (laneProject && laneKey && laneByProject[laneProject]?.key === laneKey) {
      const lane = laneByProject[laneProject]!;
      const input = JSON.parse(String(init?.body));
      if (init?.method === "PUT" && !laneAction) {
        if (input.version !== lane.version) {
          return Response.json(
            { error: "Lane version changed" },
            { status: 409 },
          );
        }
        lane.version++;
        lane.document = input.document;
        return json(lane);
      }
      if (init?.method === "POST" && laneAction === "status") {
        dispositions.push(input);
        if (
          !["open", "done", "dropped"].includes(input.status) ||
          (input.status !== "open" && !input.note?.trim())
        ) {
          return Response.json(
            { error: "Invalid lane disposition" },
            { status: 400 },
          );
        }
        lane.status = input.status;
        lane.note = input.note;
        return json(lane);
      }
    }
    if (collection === "plan")
      return json({
        version: 1,
        lanes: [
          {
            key: laneByProject[project ?? ""]?.key ?? "delivery",
            horizon: "now",
            doneWhen: "",
            statusNote: "In progress",
          },
        ],
        documents: [
          laneByProject[project ?? ""] ?? {
            key: "delivery",
            version: 1,
            title: "Delivery",
            aim: "Ship the change",
            document: "Fixture Markdown",
            status: "open",
          },
        ],
        idle: false,
      });
    if (collection === "items")
      return json([
        {
          id: `i-${project}`,
          kind: "lead",
          author: "planner",
          title: "An idea",
          body: "Fixture idea",
          lanes: ["delivery"],
          state: "open",
          version: 1,
          createdAtMs: 10,
        },
        {
          id: "promoted",
          kind: "papercut",
          author: "planner",
          title: "Fixed",
          body: "",
          lanes: [],
          state: "promoted",
          taskId: "finished",
          taskLinks: ["finished"],
          createdAtMs: 100,
          updatedAtMs: 200,
          version: 17,
        },
      ]);
    if (collection === "decisions")
      return json([
        {
          id: `d-${project}`,
          projectId: project,
          author: "planner",
          question:
            questions.get(project ?? "") ?? "Which path should we take?",
          createdAtMs: 1_790_000_000_000,
          options: [
            { id: "first", label: "First" },
            { id: "second", label: "Second" },
          ],
          answer: null,
        },
      ]);
    if (/^\/planning\/[^/]+\/history\/item\/[^/]+$/.test(path)) return json([]);
    return new Response(JSON.stringify({ error: { message: "no route" } }), {
      status: 404,
    });
  }) as typeof fetch;
  return {
    fetcher,
    writes,
    reads,
    denied,
    questions,
    dispositions,
    loseNextRemovalReply: () => {
      loseRemovalReply = true;
    },
    planningReads: () =>
      reads.filter((path) => path.startsWith("GET /planning/")),
    setSession: (next: RustBrowserSession) => {
      session = next;
    },
    setProfiles: (next: unknown, pausedGroups: string[]) => {
      profiles = { profiles: next, pausedGroups };
    },
    mode: () => dispatch.mode,
    setCatalog: (next: RustCachedCatalog) => {
      catalog = next;
    },
    setOfferedGroups: (next: Record<string, string>) => {
      offeredGroups = next;
    },
    setUsage: (next: RustProfileUsage) => {
      usage = next;
    },
    setT3: (next: typeof t3Settings) => {
      t3Settings = next;
    },
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
  assert.deepEqual(
    board.projects.map((project) => [project.key, project.name]),
    [
      [projectKey("Orbit_Main"), "Orbit"],
      ["lantern", "Lantern"],
    ],
  );
  assert.deepEqual(
    board.projects[0]!.repositories.map((repo) => repo.origin),
    ["example/orbit", "example/orbit-docs"],
  );
  assert.deepEqual(board.projectLimitOverrides, {
    [projectKey("Orbit_Main")]: 3,
    lantern: 1,
  });
  assert.deepEqual(
    board.pool.map((entry) => [entry.profileId, entry.group]),
    [["w", "team"]],
  );
  assert.deepEqual(fake.reads, ["GET /settings", "GET /session"]);
  const storage = await adapter.rpc(api.workStorage, {});
  assert.deepEqual(storage.backups, {
    newestAt: "2026-11-24T08:00:00Z",
    verified: 1,
    issues: 0,
  });
  assert.deepEqual(storage.configBackups, {
    newestAt: "2026-11-25T09:00:00Z",
    verified: 1,
    issues: 1,
  });
  assert.ok(board.repositoryBadges?.["/work/orbit"]);
});

test("the Rust Hosts panel hides the default picker below two registered hosts", async () => {
  useNativeStubs();
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  const { HostsPanel } = await import("../client/hosts-settings");
  const h = React.createElement;
  const mountPanel = (
    list: HostList,
    defaultHostKind: api.CapacityAuthorityValues["operatorDefaultHostKind"],
    saveDefaultHost: () => Promise<void> = async () => {},
  ) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = mount(
      h(QueryClientProvider, {
        client,
        children: h(PluginRpcProvider, {
          invoke: (async () => ({})) as never,
          children: h((props) => props.children, {
            children: h(HostsPanel, {
              c: new Proxy({}, { get: () => "#123" }) as never,
              list,
              loading: false,
              loadError: null,
              retry: () => {},
              defaultValues: {
                operatorDefaultHostKind: defaultHostKind,
              } as api.CapacityAuthorityValues,
              saveDefaultHost,
              remove: async () => {},
            }),
          }),
        }),
      }),
    );
    return {
      ui,
      close: () => {
        ui.update(h(React.Fragment));
        client.clear();
      },
    };
  };

  const list = await adapter.rpc(api.hostList, {});
  assert.deepEqual(
    list.hosts.map(({ kind }) => kind),
    ["t3code"],
  );
  let hiddenSaves = 0;
  const registered = mountPanel(list, "t3code", async () => {
    hiddenSaves++;
  });
  try {
    assert.ok(registered.ui.query("T3 Code host t3, Online, default"));
    assert.equal(registered.ui.query("Default host, T3 Code"), undefined);
    assert.doesNotMatch(registered.ui.text(), /Paseo|BB/);
    assert.equal(hiddenSaves, 0);
  } finally {
    registered.close();
  }

  // The current adapter reports only T3; retain its real row and add a registered
  // future-host fixture to exercise the two-host path the board keeps available.
  const secondHostList = api.hostList.output.parse({
    ...list,
    hosts: [
      ...list.hosts,
      {
        id: "bb:fixture",
        kind: "bb",
        label: "BB",
        endpoint: "bb-data-dir:/synthetic/bb",
        state: "offline",
        reason: "Fixture host",
        isDefault: false,
        versions: [],
        dependents: [],
        removalBlockers: [],
      },
    ],
  });
  const multiple = mountPanel(secondHostList, "t3code");
  try {
    multiple.ui.press("Default host, T3 Code");
    assert.deepEqual(
      multiple.ui
        .all(/^Default host: /)
        .map(({ props }) => props.accessibilityLabel)
        .sort(),
      ["Default host: BB", "Default host: Planner's host", "Default host: T3 Code"],
    );
  } finally {
    multiple.close();
  }

  fake.setT3(null);
  const noRegistration = await adapter.rpc(api.hostList, {});
  assert.deepEqual(noRegistration.hosts, []);
  let saves = 0;
  const unavailable = mountPanel(noRegistration, "bb", async () => {
    saves++;
  });
  try {
    assert.equal(unavailable.ui.query("Default host, Unavailable"), undefined);
    assert.doesNotMatch(unavailable.ui.text(), /Paseo|BB/);
    assert.equal(saves, 0);
  } finally {
    unavailable.close();
  }
});

test("Rust Settings opens an adapter project without requesting owner candidates", async () => {
  useNativeStubs();
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let candidateReads = 0;
  const invoke = async (method: string, input: unknown) => {
    if (method === "project.owner-candidates") {
      candidateReads++;
      throw new RustUnsupported(method);
    }
    const contract = Object.values(api).find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "name" in value &&
        value.name === method,
    );
    if (!contract) throw new Error(`Unknown RPC ${method}`);
    return adapter.rpc(contract as never, input as never);
  };
  const h = React.createElement;
  const { QueueSettingsScreen } = await import("../client/settings-screen");
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h((props) => props.children, {
        children: h(PluginRpcProvider, {
          invoke: invoke as never,
          children: h(QueueSettingsScreen as never, {
            theme: { colors: new Proxy({}, { get: () => "#123" }) },
            layout: { compact: false, platform: "ios" },
            host: { id: "t3", label: "T3 Code" },
          }),
        }),
      }),
    }),
  );
  try {
    ui.get("Nucleus settings").props.onLayout({
      nativeEvent: { layout: { width: 1024 } },
    });
    await waitFor(
      () => Boolean(ui.query("Usage level")),
      HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS,
      "Settings loads through the Rust adapter",
    );
    ui.press("Projects");
    await waitFor(
      () => ui.text().includes("Orbit"),
      HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS,
      "the adapter project appears",
    );
    ui.press("Orbit");
    await waitFor(
      () => Boolean(ui.query("Project name")),
      HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS,
      "the adapter project opens",
    );
    assert.equal(candidateReads, 0);
    assert.doesNotMatch(ui.text(), /Couldn't load threads/);
  } finally {
    ui.update(React.createElement(React.Fragment));
    client.clear();
  }
});

test("the board identifies malformed projects and profiles without losing healthy siblings", async () => {
  const fake = engine();
  let corrupt = true;
  const fetcher: typeof fetch = async (url, init) => {
    const response = await fake.fetcher(url, init);
    const path = String(url);
    if (
      !corrupt ||
      (!path.endsWith("/settings") && !path.endsWith("/settings/projects"))
    )
      return response;
    const wire = await response.json();
    const domain = path.endsWith("/projects") ? wire : wire.projects;
    domain.settings.value.projects.broken = {
      name: "Broken",
      repositories: false,
      archived: false,
    };
    domain.settings.value.projects.renamed = {
      ...domain.settings.value.projects.lantern,
      name: "",
    };
    if (wire.profiles)
      wire.profiles.value.profiles.push({ name: "Damaged", selection: null });
    return Response.json(wire);
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  const read = async () => {
    const board = await adapter.rpc(api.uiSnapshot, {});
    assert.ok(!("unchanged" in board));
    return board;
  };
  const board = await read();
  assert.deepEqual(
    board.projects.map((row) => row.name),
    ["Orbit", "Lantern"],
  );
  assert.deepEqual(
    board.profiles.map((row) => row.name),
    ["Worker"],
  );
  assert.match(board.error, /Project broken: repositories/);
  assert.match(board.error, /Project renamed: name/);
  assert.match(board.error, /Profile Damaged: selection/);
  await assert.rejects(
    adapter.rpc(rustProjectArchive, { project: "lantern", archived: true }),
  );
  assert.equal(fake.writes.length, 0);
  fake.setSession({
    id: "restricted",
    canEditSettings: false,
    planningProjects: ["lantern"],
  });
  await adapter.refreshSession();
  assert.doesNotMatch((await read()).error, /broken|renamed/);
  corrupt = false;
  assert.equal((await read()).error, "");
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
  assert.deepEqual(
    fake.writes.map((write) => write.body.revision),
    ["1", "2", "3", "4"],
  );
});

test("a profile write keeps the engine's fields this client does not know", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  const result = await adapter.rpc(api.configureProfile, {
    profileId: "w",
    enabled: true,
    group: "team-b",
    capability: "heavyweight",
    weight: "more",
  });
  assert.equal(result.entry?.group, "team-b");
  const written = fake.writes[0]!.body.value as {
    profiles: Array<Record<string, unknown>>;
  };
  assert.equal(written.profiles[0]!.unrated, true);
  assert.equal(written.profiles[0]!.providerInstanceId, "codex-1");
  assert.deepEqual(written.profiles[0]!.selection, {
    id: "w",
    provider: "codex",
    model: "m",
    effort: "high",
    capability: "heavyweight",
    weight: "more",
  });
});

test("shared Limits writes sparse project overrides and the two Dispatch defaults", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  await adapter.rpc(api.uiSnapshot, {});
  const { effective, revision } = await adapter.rpc(api.capacityState, {});
  assert.ok(revision);
  assert.equal(effective.projectLimit, 2);
  await adapter.rpc(api.configureCapacity, {
    revision,
    heavySlots: 6,
    projectLimit: 4,
  });
  for (const limit of [5, null, 0]) {
    const key = projectKey("Orbit_Main");
    await adapter.rpc(api.configureProjectDispatchLimit, {
      projectKey: key,
      limit,
    });
    const board = await adapter.rpc(api.uiSnapshot, {});
    assert.ok(!("unchanged" in board));
    assert.equal(board.globalLimit, 8);
    assert.equal(board.projectLimit, 4);
    assert.deepEqual(
      board.projectLimitOverrides,
      limit === null ? { lantern: 1 } : { lantern: 1, [key]: limit },
    );
  }
  assert.ok(fake.writes.every((write) => write.domain === "dispatch"));
});

test("two Limits tabs preserve untouched slots and refuse an edit against an older view", async () => {
  const fake = engine();
  const first = createRustAdapter(createRustApi(fake.fetcher));
  const second = createRustAdapter(createRustApi(fake.fetcher));
  const before = await second.rpc(api.capacityState, {});
  assert.ok(before.revision);
  const initial = await first.rpc(api.capacityState, {});
  assert.ok(initial.revision);
  await first.rpc(api.configureCapacity, {
    revision: initial.revision,
    normalSlots: 93,
  });
  await assert.rejects(
    second.rpc(api.configureCapacity, {
      revision: before.revision,
      projectLimit: 3,
    }),
    /limits changed/,
  );
  assert.equal(fake.writes.length, 1);
  const refreshed = await second.rpc(api.capacityState, {});
  assert.equal(refreshed.effective.globalLimit, 96);
  assert.deepEqual(
    [refreshed.effective.heavySlots, refreshed.effective.normalSlots, refreshed.effective.lightSlots],
    [2, 93, 1],
  );
  assert.ok(refreshed.revision);
  await second.rpc(api.configureCapacity, {
    revision: refreshed.revision,
    projectLimit: 3,
  });
  const saved = await first.rpc(api.capacityState, {});
  assert.equal(saved.effective.globalLimit, 96);
  assert.equal(saved.effective.projectLimit, 3);
});

test("retired machinery is refused by name instead of guessed", async () => {
  const adapter = createRustAdapter(createRustApi(engine().fetcher));
  await assert.rejects(adapter.rpc(api.refreshCatalog, {}), RustUnsupported);
});

test("project keys round-trip independent of the registry, including the encoding prefix", () => {
  const ids = [
    "orbit",
    "p-orbit-main",
    "Orbit_Main",
    "orbit.main",
    "rust-id-41",
    "A",
    "9",
    "_",
  ];
  assert.equal(new Set(ids.map(projectKey)).size, ids.length);
  assert.deepEqual(
    ids.map((id) => projectId(projectKey(id))),
    ids,
  );
  assert.equal(projectKey("p-orbit-main"), "p-orbit-main");
});

test("a saved filter keeps its owner across a registry collision and a fresh board mount", async (t) => {
  const fake = engine();
  let ids = ["p-orbit-main"];
  const fetcher: typeof fetch = async (url, init) => {
    const response = await fake.fetcher(url, init);
    if (!String(url).endsWith("/settings")) return response;
    const settings = await response.json();
    const registry = settings.projects.settings.value;
    const template = registry.projects.lantern;
    registry.projects = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          ...template,
          name: id === "p-orbit-main" ? "Original" : "Arrival",
          repositories: [
            {
              ...template.repositories[0],
              path: "/work/" + id,
              origin: "example/" + id,
            },
          ],
        },
      ]),
    );
    return Response.json(settings);
  };
  useNativeStubs();
  const { MainSurface } = await import("../client/queue");
  const { bindBoardShell } = await import("../client/shell");
  const web = await import("../client/web/shell");
  bindBoardShell({ ...web, Icon: () => null });
  const storage = new Map<string, string>();
  const priorScope = readProjectScope(undefined);
  const priorStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  t.after(() => {
    if (priorStorage)
      Object.defineProperty(globalThis, "localStorage", priorStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    writeProjectScope(undefined, priorScope);
  });
  const key = "nucleus:project-scope";
  const seed = (selection: string) =>
    storage.set(key, JSON.stringify({ projects: [selection] }));
  const saved = () => JSON.parse(storage.get(key) ?? "{}").projects;
  seed("rust:p-orbit-main");
  const h = React.createElement;
  const open = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const adapter = createRustAdapter(createRustApi(fetcher));
    const ui = mount(
      h(QueryClientProvider, {
        client,
        children: h(web.WebContext.Provider, {
          value: { transport: adapter, settings: false },
          children: h((props) => props.children, {
            children: h(MainSurface, {
              theme: { colors: new Proxy({}, { get: () => "#123" }) as never },
              layout: { compact: false },
            }),
          }),
        }),
      }),
    );
    const close = () => {
      ui.update(h(React.Fragment));
      client.clear();
    };
    return { ui, client, close };
  };
  const wait = (test: () => boolean, label: string) =>
    waitFor(test, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, label);
  let board = open();
  t.after(() => {
    board.close();
    useNativeStubs();
  });
  await wait(
    () => Boolean(board.ui.query("Projects, Original")),
    "restore the previously saved filter",
  );
  assert.deepEqual(saved(), ["rust:p-orbit-main"]);
  ids = ["Orbit_Main", "p-orbit-main"];
  await board.client.refetchQueries({ queryKey: ["nucleus", "state"] });
  assert.ok(board.ui.query("Projects, Original"));
  board.close();
  board = open();
  await wait(
    () => Boolean(board.ui.query("Projects, Original")),
    "reload with both registry entries",
  );

  board.close();
  seed("p-orbit-main");
  board = open();
  await wait(
    () => board.ui.text().includes("uses an older format"),
    "an older filter asks for a new pick",
  );
  assert.deepEqual(saved(), ["p-orbit-main"]);
  board.ui.press("Projects, All projects");
  board.ui.press(/^Project Arrival,/);
  await wait(
    () => Boolean(board.ui.query("Projects, Arrival")),
    "a new pick binds to the chosen owner",
  );
  assert.deepEqual(saved(), ["rust:" + projectKey("Orbit_Main")]);

});

test("Projects shows and clears the claimed planner when another thread is most recently verified", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  const key = projectKey("Orbit_Main");
  const entry = async () =>
    (await adapter.rpc(api.projectSettings, { project: key })).projects[0]!;
  assert.equal((await entry()).project.planner?.agentId, "claimed-thread");
  assert.equal((await entry()).plannerLive, true);
  await adapter.rpc(api.projectSetPlanner, {
    key,
    agentId: null,
    setBy: "operator",
  });
  assert.equal((await entry()).project.planner, undefined);
});

test("a full-length Rust project name round-trips through the board and Settings beside its sibling", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  const entry = (await adapter.rpc(api.projectSettings, { project: "lantern" }))
    .projects[0]!;
  const name = "x".repeat(238) + "é";
  await adapter.rpc(api.projectUpsert, {
    key: entry.project.key,
    repositories: entry.project.repositories,
    name,
  });
  const board = await adapter.rpc(api.uiSnapshot, {});
  assert.ok(!("unchanged" in board));
  assert.deepEqual(
    board.projects.map((project) => project.name),
    ["Orbit", name],
  );
  const settings = await adapter.rpc(api.projectSettings, {
    project: "lantern",
  });
  assert.equal(settings.projects[0]?.project.name, name);
  await assert.rejects(
    adapter.rpc(api.projectUpsert, {
      key: entry.project.key,
      repositories: entry.project.repositories,
      name: name + "x",
    }),
    /240 UTF-8 bytes/,
  );
  assert.equal(fake.writes.length, 1);
});

test("the archive control writes the Projects domain", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  await adapter.rpc(api.uiSnapshot, {});
  await adapter.rpc(rustProjectArchive, {
    project: projectKey("Orbit_Main"),
    archived: true,
  });
  const projects = fake.writes.find((write) => write.domain === "projects")!
    .body.value as {
    projects: Record<string, { archived: boolean }>;
  };
  assert.equal(projects.projects.Orbit_Main!.archived, true);
  const board = await adapter.rpc(api.uiSnapshot, {});
  assert.ok(
    !("unchanged" in board) && board.projects.length === 1,
    "an archived project leaves the board",
  );
});

test("the Rust adapter ports project removal through one native resource", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  await adapter.rpc(api.uiSnapshot, {});
  const key = projectKey("Orbit_Main");
  const preview = await adapter.rpc(api.projectManagementPreview, { key });
  assert.equal(preview.project.name, "Orbit");
  assert.deepEqual(preview.tasks, []);
  const confirmation = {
    key,
    version: preview.project.version,
    digest: preview.digest,
    reason: "Retired",
  };
  fake.loseNextRemovalReply();
  await assert.rejects(
    adapter.rpc(api.projectManage, confirmation),
    /removal reply lost/,
  );
  const board = await adapter.rpc(api.uiSnapshot, {});
  assert.ok(
    !("unchanged" in board) &&
      !board.projects.some((project) => project.key === key),
  );
  const removed = await adapter.rpc(api.projectManage, confirmation);
  assert.deepEqual(removed, {
    key,
    reason: "Retired",
    removedAt: new Date(1_790_000_000_000).toISOString(),
    repositories: [
      { origin: "example/orbit", path: "/work/orbit" },
      { origin: "example/orbit-docs", path: "/work/orbit-docs" },
    ],
  });
  assert.deepEqual(
    fake.reads.filter((read) => read.endsWith("/removal")),
    [
      "GET /settings/projects/Orbit_Main/removal",
      "POST /settings/projects/Orbit_Main/removal",
      "POST /settings/projects/Orbit_Main/removal",
    ],
  );
});

test("moving a repository in the shared Projects editor reassigns it in the engine", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  await adapter.rpc(api.uiSnapshot, {});
  assert.deepEqual(
    await adapter.rpc(api.projectMergeCheck, {
      source: projectKey("Orbit_Main"),
    }),
    { blockers: [], carried: [] },
  );
  const moved = await adapter.rpc(api.projectMerge, {
    source: projectKey("Orbit_Main"),
    target: "lantern",
    versions: { source: 1, target: 1 },
    repository: "example/orbit-docs",
    reason: "Added to Lantern in Settings",
  });
  assert.deepEqual(
    moved.project.repositories.map((repo) => repo.origin),
    ["example/lantern", "example/orbit-docs"],
  );
  assert.deepEqual(
    moved.source?.repositories.map((repo) => repo.origin),
    ["example/orbit"],
  );
  const reassign = fake.writes.find((write) => write.domain === "reassign")!
    .body.value as Record<string, string>;
  assert.deepEqual(
    [reassign.origin, reassign.toProject],
    ["example/orbit-docs", "lantern"],
  );
  await assert.rejects(
    adapter.rpc(api.projectUpsert, {
      key: "lantern",
      name: "Lantern",
      repositories: [{ origin: "example/new", path: "" }],
    }),
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
  const stored = (await adapter.rust.storedProfiles()).value.profiles.at(-1);
  assert.ok(stored && stored.selection.id === id);
  assert.equal(Object.hasOwn(stored, "roles"), false);
  assert.equal(Object.hasOwn(stored, "scopes"), false);
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
      capability: "heavyweight",
      weight: "more",
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
      capability: "heavyweight",
      weight: "more",
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
  fake.setProfiles(
    [
      {
        name: "Worker",
        group: "team",
        selection: {
          id: "w",
          provider: "codex",
          model: "m",
          effort: "high",
          capability: "worker",
          weight: "default",
        },
      },
      {
        name: "Reserve",
        enabled: false,
        selection: {
          id: "r",
          provider: "codex",
          model: "team-only",
          effort: null,
          capability: "worker",
          weight: "default",
        },
      },
    ],
    ["team"],
  );
  fake.setOfferedGroups({ r: "codex-team" });
  const worker = { counts: { w: 50 }, groups: { team: 50 }, sample: 50 };
  const deadline = Date.now() + 86_400_000;
  fake.setUsage({
    recent: worker,
    worker,
    reviewer: { counts: {}, groups: {}, sample: 0 },
    totals: { w: 50 },
    groupTotals: { team: 50 },
    limitedGroups: { "codex-team": deadline },
    fallbackGroups: ["codex-team"],
  });
  useNativeStubs();
  const { ProfilesPanel } = await import("../client/settings-profiles");
  const clears: unknown[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/profiles/pauses/codex-team/clear")) {
      assert.equal(init?.method, "POST");
      clears.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    return fake.fetcher(url, init);
  };
  for (const canEditSettings of [true, false]) {
    const adapter = createRustAdapter(createRustApi(fetcher));
    fake.setSession({
      id: canEditSettings ? "operator-session" : "planner-session",
      canEditSettings,
      planningProjects: canEditSettings ? null : ["Orbit_Main"],
    });
    const board = await adapter.rpc(api.uiSnapshot, {});
    assert.ok(!("unchanged" in board));
    const usage = await adapter.rpc(rustProfileUsage, {});
    const state = {
      ...board,
      ...usage,
      availability: [
        ...board.availability,
        ...usage.availability.filter(
          ({ group }) => !board.availability.some((row) => row.group === group),
        ),
      ],
    };
    assert.equal(state.canEditSettings, canEditSettings);
    assert.deepEqual(
      state.pool.map(({ enabled }) => enabled),
      [true, false],
    );
    assert.deepEqual(
      state.pool.map(({ group }) => group),
      ["team", "codex-team"],
    );
    assert.deepEqual(
      state.availability.map(({ group, unavailable }) => [group, unavailable]),
      canEditSettings
        ? [
            ["team", true],
            ["codex-team", true],
          ]
        : [
            ["codex-team", true],
            ["team", true],
          ],
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const h = React.createElement;
    const ui = mount(
      h(QueryClientProvider, {
        client,
        children: h(PluginRpcProvider, {
          invoke: ((method: string, input: never) => {
            switch (method) {
              case "profile.list":
                return adapter.rpc(api.listNucleusProfiles, input);
              case "profile.compatibility":
                return adapter.rpc(api.readProfileCompatibility, input);
              case "profile.vocabulary":
                return adapter.rpc(api.readProfileVocabulary, input);
              default:
                throw new Error(`Unexpected profile RPC ${method}`);
            }
          }) as never,
          children: h((props) => props.children, {
            children: h(ProfilesPanel, {
              c: new Proxy({}, { get: () => "#123" }) as never,
              compact: false,
              inset: 0,
              state,
              repositories: [],
              busy: false,
              savePool: async () => {},
              savePoolList: async () => true,
              saveAvailability: async (input) => {
                await adapter.rpc(api.availabilityControl, input);
              },
            }),
          }),
        }),
      }),
    );
    t.after(() => {
      ui.update(h(React.Fragment));
      client.clear();
    });
    assert.ok(ui.query("Worker, all roles: 50 of 50 recent assignments"));
    assert.ok(ui.query("Reserve, all roles: 0 of 50 recent assignments"));
    assert.doesNotMatch(ui.text(), /Reading subscriptions/);
    assert.equal(Boolean(ui.query("Clear codex-team pause")), canEditSettings);
    if (canEditSettings) {
      assert.match(
        ui.text(),
        /Reset unknown, clear in Profiles after topping up/,
      );
      ui.press("Clear codex-team pause");
      await waitFor(() => clears.length === 1);
      assert.deepEqual(clears, [{ untilMs: deadline }]);
      assert.equal(ui.query("Pause codex"), undefined);
      ui.press("Edit codex-team");
      ui.press("Mark codex-team unavailable");
      await waitFor(() =>
        fake.writes.some(({ domain }) => domain === "profiles"),
      );
      const saved = await adapter.rust.storedProfiles();
      assert.deepEqual(saved.value.pausedGroups, ["codex-team", "team"]);
      const reserve = board.pool.find(({ profileId }) => profileId === "r");
      assert.ok(reserve);
      fake.setOfferedGroups({ r: "codex-other" });
      const updated = await adapter.rpc(api.configureProfile, {
        ...reserve,
        weight: "more",
        groupChanged: false,
      });
      assert.equal(updated.entry?.group, "codex-other");
      const edited = await adapter.rust.storedProfiles();
      assert.equal(
        edited.value.profiles.find(({ selection }) => selection.id === "r")
          ?.group,
        undefined,
      );
      fake.setOfferedGroups({ r: "codex-team" });
    }
    assert.equal(Boolean(ui.query("Edit Worker")), canEditSettings);
    assert.equal(
      ui.get(canEditSettings ? "Disable Worker" : "Worker: On").props.disabled,
      !canEditSettings,
    );
    assert.equal(
      ui.get(canEditSettings ? "Enable Reserve" : "Reserve: Off").props
        .disabled,
      !canEditSettings,
    );
  }
  assert.deepEqual(fake.planningReads(), []);
});

test("Rust board loads scoped collections on entry and shares them across views", async (t) => {
  const fake = engine();
  fake.setSession({
    id: "planner-session",
    canEditSettings: false,
    planningProjects: ["Orbit_Main"],
  });
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  useNativeStubs();
  const { useBoardState } = await import("../client/board-state");
  const { useRecordQueries } = await import("../client/board/use-board-data");
  const { useInboxBoard } = await import("../client/board/inbox-list");
  const { createPushInvalidator } = await import("../client/web/rust-board");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invoke = (method: string, input: never) => {
    switch (method) {
      case "queue.ui-snapshot":
        return adapter.rpc(api.uiSnapshot, input);
      case "queue.plans":
        return adapter.rpc(api.plans, input);
      case "lead.board":
        return adapter.rpc(api.leadBoard, input);
      case "decision.list":
        return adapter.rpc(api.decisionList, input);
      default:
        throw new Error(`Unexpected board RPC ${method}`);
    }
  };
  const h = React.createElement;
  function Records({
    view,
  }: {
    view: "needs" | "planning" | "leads" | "queue";
  }) {
    const { state, stateQuery } = useBoardState();
    const records = useRecordQueries();
    const inbox = useInboxBoard({
      state,
      selection: [],
      boardLeads: records.boardLeads,
      leadLinks: records.leadLinks,
      decisions: records.decisionsQuery.data,
      hiddenQueued: 0,
      triageTag: null,
    });
    return h(
      "result",
      {},
      JSON.stringify({
        projects: state?.projects.map(({ key }) => key),
        needs: inbox.counts.needs,
        decisions: records.decisionsQuery.data?.map(({ question }) => question),
        leads: records.leadsQuery.data?.cards.length,
        lanes: records.planQuery.data?.flatMap(
          ({ laneViews }) => laneViews?.map(({ title }) => title) ?? [],
        ),
      }),
    );
  }
  const render = (view: Parameters<typeof Records>[0]["view"]) =>
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: invoke as never,
        children: h((props) => props.children, {
          children: h(Records, { view }),
        }),
      }),
    });
  const ui = mount(render("queue"));
  t.after(() => {
    ui.update(h(React.Fragment));
    client.clear();
  });
  const wait = (pattern: RegExp) =>
    waitFor(
      () => pattern.test(ui.text()),
      HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS,
      pattern.source,
    );
  await wait(
    new RegExp(
      projectKey("Orbit_Main") +
        '.*"needs":1.*Which path should we take.*"leads":1,"lanes":\\["Delivery"\\]',
    ),
  );
  const scopedReads = [
    "GET /planning/Orbit_Main/decisions?pending=true",
    "GET /planning/Orbit_Main/items",
    "GET /planning/Orbit_Main/plan",
  ];
  assert.deepEqual(fake.planningReads().sort(), scopedReads);
  ui.update(render("planning"));
  ui.update(render("leads"));
  await client.refetchQueries({ queryKey: ["nucleus", "state"] });
  assert.deepEqual(
    fake.planningReads().sort(),
    scopedReads,
    "view changes and board revisions reuse the collections",
  );

  ui.update(render("queue"));
  const push = createPushInvalidator(client);
  push({ queryKey: ["nucleus", "decisions"] });
  await waitFor(
    () => fake.planningReads().length === 4,
    HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS,
    "decisions refresh outside Needs you",
  );
  assert.deepEqual(fake.planningReads().slice(3), [
    "GET /planning/Orbit_Main/decisions?pending=true",
  ]);
  assert.equal(await adapter.refreshSession(), false);
  push({ queryKey: ["nucleus"] });
  await waitFor(
    () => fake.planningReads().length === 7,
    HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS,
    "reconnect refresh",
  );
  assert.deepEqual(fake.planningReads().slice(4).sort(), scopedReads);
});

test("a stored Rust plan note survives the aggregate board read in full", async () => {
  const fake = engine();
  // Serialized from the store's PlanLane with a note longer than 200 characters.
  const step = {
    key: "delivery",
    horizon: "now",
    doneWhen: "",
    statusNote:
      "The intake is open for the next group. Reviewers have checked the first delivery and recorded the remaining dependencies. The project will keep the current order while the last two submissions are reviewed, and the planner will update this note when they are ready.",
  };
  const fetcher: typeof fetch = async (url, init) => {
    const response = await fake.fetcher(url, init);
    if (!String(url).endsWith("/planning/lantern/plan")) return response;
    const plan = await response.json();
    return Response.json({ ...plan, lanes: [step] });
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  const plans = await adapter.rpc(api.plans, {});
  assert.equal(plans.length, 2);
  const plan = plans.find((row) => row.project === "lantern");
  assert.equal(plan?.savedEntries?.[0]?.note, step.statusNote);
});

test("an older completion criterion stays readable and can be corrected", async () => {
  const fake = engine();
  const doneWhen = "first line\n" + "📦".repeat(150);
  const fetcher: typeof fetch = async (url, init) => {
    const response = await fake.fetcher(url, init);
    if (!String(url).endsWith("/planning/lantern/plan")) return response;
    const plan = await response.json();
    return Response.json({ ...plan, lanes: [{ ...plan.lanes[0], doneWhen }] });
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  const plans = await adapter.rpc(api.plans, {});
  assert.equal(plans.length, 2);
  const entry = plans.find((row) => row.project === "lantern")
    ?.savedEntries?.[0];
  assert.equal(entry?.doneWhen, doneWhen);
  assert.equal(api.planEntriesSchema.safeParse([entry]).success, false);
  assert.equal(
    api.planEntriesSchema.safeParse([{ ...entry, doneWhen: "Shipped" }])
      .success,
    true,
  );
});

test("long Rust decision questions retain their full detail and their healthy siblings", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  for (const length of [4001, 48001]) {
    const question = "Q".repeat(length);
    fake.questions.set("lantern", question);
    const rows = await adapter.rpc(api.decisionList, { status: "open" });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.question, "Which path should we take?");
    assert.equal(rows[1]?.question, api.clipDecisionQuestion(question));
    const detail = await adapter.rpc(api.decisionGet, { id: "d-lantern" });
    assert.equal(detail?.details, question);
  }
});

test("an unavailable project leaves the other project readable and clears its diagnostic on recovery", async () => {
  const fake = engine();
  let status = 500;
  const fetcher: typeof fetch = (url, init) => {
    if (status && String(url).endsWith("/planning/lantern/plan"))
      return Promise.resolve(
        Response.json({ error: "could not read plan" }, { status }),
      );
    return fake.fetcher(url, init);
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  const notices = new Map<string, string[]>();
  listenForPlanningIssues(adapter.rust, (key, issues) =>
    notices.set(key, issues),
  );
  assert.deepEqual(
    (await adapter.rpc(api.plans, {})).map((plan) => plan.project),
    [projectKey("Orbit_Main")],
  );
  assert.match(
    notices.get("Plans")?.join() ?? "",
    /lantern Plans:.*could not read plan/,
  );
  status = 0;
  assert.equal((await adapter.rpc(api.plans, {})).length, 2);
  assert.deepEqual(notices.get("Plans"), []);
  status = 401;
  await assert.rejects(adapter.rpc(api.plans, {}));
});

test("Needs you uses the pending inventory and history retains older task decisions", async () => {
  const fake = engine();
  const fetcher: typeof fetch = async (url, init) => {
    const response = await fake.fetcher(url, init);
    if (!String(url).endsWith("/planning/lantern/decisions")) return response;
    const rows = await response.json();
    return Response.json([
      ...rows,
      {
        ...rows[0],
        id: "obsolete",
        task: { taskId: "old-task", taskVersion: 2 },
      },
    ]);
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  const pending = await adapter.rpc(api.decisionList, { status: "open" });
  assert.deepEqual(
    pending.map((row) => row.id),
    ["d-Orbit_Main", "d-lantern"],
  );
  assert.ok(
    (await adapter.rpc(api.decisionList, {})).some(
      (row) => row.id === "obsolete",
    ),
  );
});

test("project-scoped decisions address the selected copy and ambiguous bare IDs refuse", async () => {
  const fake = engine();
  const writes: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/shared/answer")) {
      writes.push(path);
      const response = await fake.fetcher(path.replace("/shared/answer", ""), {
        headers: init?.headers,
      });
      const [decision] = await response.json();
      return Response.json({
        ...decision,
        id: "shared",
        answer: {
          optionId: "first",
          note: null,
          author: "operator",
          answeredAtMs: 5,
        },
      });
    }
    const response = await fake.fetcher(url, init);
    if (!path.endsWith("/decisions")) return response;
    const [decision] = await response.json();
    return Response.json([
      { ...decision, id: "shared", question: decision.projectId + " question" },
    ]);
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  const answer = {
    id: "shared",
    optionId: "first",
    answeredBy: "operator",
    version: 1,
  };
  await assert.rejects(
    adapter.rpc(api.decisionGet, { id: "shared" }),
    /ambiguous/,
  );
  await assert.rejects(adapter.rpc(api.decisionAnswer, answer), /ambiguous/);
  assert.equal(writes.length, 0);
  assert.equal(
    (await adapter.rpc(api.decisionGet, { id: "shared", project: "lantern" }))
      ?.question,
    "lantern question",
  );
  await adapter.rpc(api.decisionAnswer, { ...answer, project: "lantern" });
  assert.deepEqual(writes, [
    "/api/engine/planning/lantern/decisions/shared/answer",
  ]);
});

test("lane detail reads the full stored Markdown and edits use the native byte limit", async () => {
  const key = "delivery";
  const project = "lantern";
  const address = { project, key };
  const text = "é".repeat(2_000_000);
  const fake = engine({
    [project]: {
      key,
      version: 1,
      document: text,
      title: "Delivery",
      aim: "Ship",
      status: "open",
    },
  });
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  const saved = await adapter.rpc(api.laneDocumentGet, address);
  assert.equal(saved?.text.length, text.length);
  assert.equal(
    saved?.digest,
    "sha256:" + createHash("sha256").update(text).digest("hex"),
  );
  const edit = { ...address, version: 1, text, author: "planner" };
  assert.doesNotThrow(() => api.laneDocumentEdit.input.parse(edit));
  assert.throws(
    () => api.laneDocumentEdit.input.parse({ ...edit, text: text + "x" }),
    /4,000,000 UTF-8 bytes/,
  );
});

test("planning detail reads the requested revision from the scoped store history", async () => {
  const fake = engine();
  const project = "lantern";
  const key = "delivery";
  const step = {
    key,
    horizon: "now",
    statusNote: "Original note",
    doneWhen: "Tests pass",
  };
  const original = { version: 1, lanes: [step] };
  const lane = {
    key,
    version: 1,
    title: "Delivery",
    aim: "Ship",
    document: "First draft",
    status: "open",
  };
  const history = (action: string, sequence: number, snapshot: unknown) => ({
    sequence,
    action,
    snapshot,
    actor: "planner",
    atMs: 1000 * sequence,
  });
  const previous = {
    project,
    version: 3,
    entries: [{ lane: key, note: "Imported", horizon: "now" }],
    author: "original planner",
    createdAt: "2026-09-12T19:00:00.000Z",
  };
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/planning/lantern/history/plan/lantern"))
      return Response.json([
        history("set", 8, original),
        { ...history("import", 9, original), actor: "importer" },
        history("set", 12, { version: 2, lanes: [] }),
        history("legacy_version", 15, previous),
        history("import", 16, { ...original, version: 3 }),
      ]);
    if (path.endsWith("/planning/lantern/history/lane/delivery"))
      return Response.json([
        history("put", 6, lane),
        {
          ...history("status", 7, { ...lane, status: "done", note: "Shipped" }),
          actor: "closer",
        },
        history("put", 10, { ...lane, version: 2, document: "Second draft" }),
      ]);
    return fake.fetcher(url, init);
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  const plan = await adapter.rpc(api.planGet, { project, version: 1 });
  assert.deepEqual(plan, {
    project,
    version: 1,
    entries: [
      {
        lane: key,
        horizon: "now",
        doneWhen: step.doneWhen,
        note: step.statusNote,
      },
    ],
    author: "planner",
    createdAt: new Date(8000).toISOString(),
  });
  assert.deepEqual(
    await adapter.rpc(api.planGet, { project, version: 3 }),
    previous,
  );
  const doc = await adapter.rpc(api.laneDocumentGet, {
    project,
    key,
    version: 1,
  });
  assert.deepEqual(doc, {
    key,
    version: 1,
    text: lane.document,
    author: "planner",
    createdAt: new Date(6000).toISOString(),
    digest:
      "sha256:" + createHash("sha256").update(lane.document).digest("hex"),
  });
  await assert.rejects(
    adapter.rpc(api.planGet, { project, version: 4 }),
    /Version 4.*unavailable/,
  );
  await assert.rejects(
    adapter.rpc(api.laneDocumentGet, { project, key, version: 4 }),
    /Version 4.*unavailable/,
  );
});

test("unreadable planning records leave healthy siblings readable in lists and detail", async () => {
  const fake = engine();
  let badStep = false;
  const fetcher: typeof fetch = async (url, init) => {
    const response = await fake.fetcher(url, init);
    const path = String(url);
    if (!path.includes("/planning/lantern/")) return response;
    const data = await response.json();
    if (path.endsWith("/plan")) {
      data.documents.unshift({ key: "bad-lane", document: null });
      if (badStep) data.lanes.push({ key: "bad-step", horizon: "unknown" });
    } else if (path.endsWith("/items")) {
      data.unshift({ ...data[0], id: "bad-item", lanes: ["invalid/key"] });
    } else if (path.endsWith("/decisions")) {
      data.unshift({ ...data[0], id: "bad-decision", options: null });
    }
    return Response.json(data);
  };
  const notices = new Map<string, string[]>();
  const adapter = createRustAdapter(createRustApi(fetcher));
  listenForPlanningIssues(adapter.rust, (collection, issues) =>
    notices.set(collection, issues),
  );
  const plans = await adapter.rpc(api.plans, {});
  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans
      .find((plan) => plan.project === "lantern")
      ?.laneViews?.map((l) => l.key),
    ["delivery"],
  );
  const doc = await adapter.rpc(api.laneDocumentGet, {
    project: "lantern",
    key: "delivery",
  });
  assert.equal(doc?.text, "Fixture Markdown");
  const leads = await adapter.rpc(api.leadBoard, {});
  assert.deepEqual(
    leads.cards.map((card) => card.projectKey),
    [projectKey("Orbit_Main"), "lantern"],
  );
  assert.ok(leads.activity?.every((activity) => activity.id !== "bad-item"));
  assert.equal(
    (await adapter.rpc(api.itemGet, { id: "i-lantern" }))?.title,
    "An idea",
  );
  assert.equal((await adapter.rpc(api.decisionList, {})).length, 2);
  assert.equal(
    (await adapter.rpc(api.decisionGet, { id: "d-lantern" }))?.id,
    "d-lantern",
  );
  assert.match(notices.get("Plans")?.join() ?? "", /lantern lane bad-lane/);
  assert.match(notices.get("Items")?.join() ?? "", /lantern item bad-item/);
  assert.match(
    notices.get("Decisions")?.join() ?? "",
    /lantern decision bad-decision/,
  );
  badStep = true;
  const intact = await adapter.rpc(api.plans, {});
  assert.deepEqual(
    intact.map((plan) => plan.project),
    [projectKey("Orbit_Main")],
  );
  assert.match(
    notices.get("Plans")?.join() ?? "",
    /lantern plan step bad-step/,
  );
  assert.equal(fake.writes.length, 0);
});

test("a board click and action address the selected project's colliding decision and items", async (t) => {
  const fake = engine();
  const answers = new Map<string, string>();
  const dropped = new Map<
    string,
    { reason: string | null; disposition: string }
  >();
  const parked = new Set<string>();
  const assessments: unknown[] = [];
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    const match =
      /\/planning\/([^/]+)\/(decisions|items)(?:\/(shared|cut)\/(answer|drop|park|assess))?(?:\?pending=true)?$/.exec(
        path,
      );
    if (!match) return fake.fetcher(url, init);
    const project = match[1]!;
    calls.push(path);
    if (match[2] === "decisions") {
      if (match[4] === "answer")
        answers.set(project, JSON.parse(String(init?.body)).optionId);
      const record = {
        id: "shared",
        projectId: project,
        author: "planner",
        question: project + " decision",
        options: [
          { id: "first", label: "First" },
          { id: "second", label: "Second" },
        ],
        createdAtMs: 10,
        answer: answers.has(project)
          ? {
              optionId: answers.get(project),
              note: null,
              author: "operator",
              answeredAtMs: 20,
            }
          : null,
      };
      return Response.json(
        match[4]
          ? record
          : path.endsWith("?pending=true") && record.answer
            ? []
            : [record],
      );
    }
    if (match[4] === "assess") {
      assessments.push({ project, ...JSON.parse(String(init?.body)) });
    }
    if (match[4] === "park") parked.add(project);
    if (match[4] === "drop")
      dropped.set(project, JSON.parse(String(init?.body)));
    const item = {
      id: "shared",
      title: project + " lead",
      body: project + " lead body",
      kind: "lead",
      state: "open",
      author: "planner",
      lanes: [],
      version: 1,
      createdAtMs: 10,
    };
    const cut = {
      ...item,
      id: "cut",
      title: project + " cut",
      body: project + " cut body",
      kind: "papercut",
      state: dropped.has(project)
        ? "dropped"
        : parked.has(project)
          ? "parked"
          : "open",
      reason: parked.has(project) ? "Later" : null,
      ...dropped.get(project),
    };
    return Response.json(match[4] ? cut : [item, cut]);
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  useNativeStubs();
  const { MainSurface } = await import("../client/queue");
  const { bindBoardShell } = await import("../client/shell");
  const web = await import("../client/web/shell");
  bindBoardShell({ ...web, Icon: () => null });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const h = React.createElement;
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(web.WebContext.Provider, {
        value: { transport: adapter, settings: false },
        children: h((props) => props.children, {
          children: h(MainSurface, {
            theme: { colors: new Proxy({}, { get: () => "#123" }) as never },
            layout: { compact: false },
          }),
        }),
      }),
    }),
  );
  t.after(() => {
    ui.update(h(React.Fragment));
    client.clear();
    useNativeStubs();
  });
  const visible = async (label: string | RegExp) => {
    await waitFor(() => Boolean(ui.query(label)), 4000, String(label)).catch(
      (error) => {
        throw new Error(
          `${String(error)}; board text: ${ui.text()}; calls: ${calls.slice(-10).join(", ")}`,
        );
      },
    );
  };

  const press = async (label: string | RegExp) => {
    await visible(label);
    ui.press(label);
  };
  await press(/^Needs you, 2$/);
  await press(/^Decision: lantern decision,/);
  await press("Use option: Second");
  await press("Answer");
  await waitFor(() => answers.size > 0, 4000, "decision answer");
  assert.deepEqual([...answers], [["lantern", "second"]]);
  await press(/^Leads, 2$/);
  await press(/^Lead: lantern lead,/);
  await waitFor(
    () => ui.text().includes("lantern lead body"),
    4000,
    "second project lead",
  );
  await press(/^Papercuts, 2$/);
  await press(/^Papercut: Orbit_Main cut,/);
  await press("Send papercut to planner");
  await waitFor(() => assessments.length > 0, 4000, "assessment sent");
  assert.deepEqual(assessments, [
    {
      project: "Orbit_Main",
      version: 1,
    },
  ]);
  await press(/^Papercut: lantern cut,/);
  await press("Park papercut");
  await visible("Park reason");
  ui.type("Park reason", "Later");
  await press("Park");
  await visible("Reopen papercut");
  assert.ok(ui.query("State: Parked"));
  await press("Open drop for papercut");
  await press("Drop papercut");
  await waitFor(() => dropped.size > 0, 4000, "papercut closed");
  assert.deepEqual(
    [...dropped],
    [["lantern", { reason: null, disposition: "completed" }]],
  );
  const saved = await adapter.rpc(api.itemGet, {
    id: "cut",
    project: "lantern",
  });
  assert.equal(saved.disposition, "completed");
  assert.equal(saved.reason, null);
});

test("a fresh Rust board opens promoted and dropped items from the Closed filter", async (t) => {
  const fake = engine();
  const reopened: string[] = [];
  let dropped = true;
  const droppedCut = {
    id: "dropped-cut",
    kind: "papercut",
    author: "planner",
    title: "Dropped cut",
    body: "Gone",
    lanes: [],
    state: "dropped",
    disposition: "completed",
    reason: "Fixed elsewhere.",
    version: 30,
    createdAtMs: 10,
    updatedAtMs: 300,
  };
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path === "/api/engine/planning/lantern/items/dropped-cut/reopen") {
      reopened.push(String(init?.body));
      dropped = false;
      return Response.json({ ...droppedCut, state: "open", version: 31 });
    }
    if (path === "/api/engine/planning/lantern/items") {
      const response = await fake.fetcher(url, init);
      const items = (await response.json()) as unknown[];
      return Response.json([
        ...items,
        dropped
          ? droppedCut
          : { ...droppedCut, state: "open", disposition: undefined, reason: null, version: 31 },
      ]);
    }
    return fake.fetcher(url, init);
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  useNativeStubs();
  const { MainSurface } = await import("../client/queue");
  const { bindBoardShell } = await import("../client/shell");
  const web = await import("../client/web/shell");
  bindBoardShell({ ...web, Icon: () => null });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const h = React.createElement;
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(web.WebContext.Provider, {
        value: { transport: adapter, settings: false },
        children: h((props) => props.children, {
          children: h(MainSurface, {
            theme: { colors: new Proxy({}, { get: () => "#123" }) as never },
            layout: { compact: false },
          }),
        }),
      }),
    }),
  );
  t.after(() => {
    ui.update(h(React.Fragment));
    client.clear();
    useNativeStubs();
  });
  const press = async (label: string | RegExp) => {
    await waitFor(() => Boolean(ui.query(label)), 4000, String(label)).catch(
      (error) => {
        throw new Error(`${String(error)}; board text: ${ui.text()}`);
      },
    );
    ui.press(label);
  };
  await press(/^Papercuts, /);
  assert.equal(ui.query(/^Papercut: Fixed,/), undefined, "closed items stay out of the default list");
  await press(/^Filter papercuts by state, /);
  await press("Filter papercuts by state: Closed");
  await waitFor(
    () => ui.all(/^Papercut: Fixed, Status: Promoted$/).length === 2,
    4000,
    "each project's promoted papercut",
  );
  assert.equal(ui.all(/^Papercut: /).length, 3);
  // The project selection scopes the Closed rows and their count like the open cards.
  await press("Projects, All projects");
  await press(/^Project Lantern,/);
  await waitFor(
    () => ui.all(/^Papercut: /).length === 2 && ui.text().includes("2 items"),
    4000,
    "Lantern's closed papercuts only",
  );
  assert.equal(ui.all(/^Papercut: Fixed, Status: Promoted$/).length, 1);
  await press("Projects, Lantern");
  await press("Clear project selection");
  await waitFor(() => ui.all(/^Papercut: /).length === 3, 4000, "every project again");
  // The newest closed item leads the list.
  assert.match(
    String(ui.all(/^Papercut: /)[0]?.props.accessibilityLabel),
    /^Papercut: Dropped cut, Status: Dropped · completed$/,
  );
  ui.all(/^Papercut: Fixed, Status: Promoted$/)[0]!.props.onPress();
  await waitFor(() => Boolean(ui.query("State: Promoted")), 4000, "promoted detail");
  assert.ok(ui.query("Open task finished"), "the linked task card");
  await press("Papercut: Dropped cut, Status: Dropped · completed");
  await waitFor(() => Boolean(ui.query("State: Dropped · completed")), 4000, "dropped detail");
  assert.match(ui.text(), /Fixed elsewhere\./);
  await press("Reopen papercut");
  await waitFor(() => Boolean(ui.query("State: Open")), 4000, "reopened");
  assert.deepEqual(reopened, [JSON.stringify({ version: 30 })]);
  await waitFor(
    () => !ui.query(/^Papercut: Dropped cut, Status: Dropped/),
    4000,
    "the reopened item leaves the Closed list",
  );
});

test("the mounted Rust board counts parked leads and papercuts like their All lists", async (t) => {
  const fake = engine();
  const openLead = {
    id: "open-lead",
    kind: "lead",
    author: "Planner",
    title: "Open lead",
    body: "An open idea",
    lanes: [],
    state: "open",
    createdAtMs: 10,
  };
  const items = [
    openLead,
    {
      ...openLead,
      id: "parked-lead",
      title: "Parked lead",
      state: "parked",
      reason: "Later",
    },
    {
      ...openLead,
      id: "parked-papercut",
      kind: "papercut",
      title: "Parked papercut",
      state: "parked",
      reason: "Later",
    },
  ];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path === "/api/engine/planning/Orbit_Main/items")
      return Response.json(items);
    if (path === "/api/engine/planning/lantern/items") return Response.json([]);
    return fake.fetcher(url, init);
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  useNativeStubs();
  const { MainSurface } = await import("../client/queue");
  const { bindBoardShell } = await import("../client/shell");
  const web = await import("../client/web/shell");
  bindBoardShell({ ...web, Icon: () => null });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const h = React.createElement;
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(web.WebContext.Provider, {
        value: { transport: adapter, settings: false },
        children: h((props) => props.children, {
          children: h(MainSurface, {
            theme: { colors: new Proxy({}, { get: () => "#123" }) as never },
            layout: { compact: false },
          }),
        }),
      }),
    }),
  );
  t.after(() => {
    ui.update(h(React.Fragment));
    client.clear();
    useNativeStubs();
  });
  const press = async (label: string | RegExp) => {
    await waitFor(() => Boolean(ui.query(label)), 4000, String(label));
    ui.press(label);
  };

  await press(/^Leads, 2$/);
  await waitFor(
    () =>
      ui.text().includes("2 items") && Boolean(ui.query(/^Lead: Parked lead,/)),
    4000,
    "All leads and matching menu count",
  );
  assert.ok(ui.query(/^Lead: Open lead,/));
  await press(/^Papercuts, 1$/);
  await waitFor(
    () =>
      ui.text().includes("1 item") &&
      Boolean(ui.query(/^Papercut: Parked papercut,/)),
    4000,
    "All papercuts and matching menu count",
  );
});

test("the board reads, edits, and closes the selected project's lane when keys collide", async (t) => {
  const lane = (name: string): RustLane => ({
    key: "Delivery_Q4",
    version: 1,
    title: `${name} delivery`,
    aim: `Ship the ${name} change`,
    document: `# ${name} document`,
    status: "open",
  });
  const lanes = {
    Orbit_Main: lane("Orbit"),
    lantern: lane("Lantern"),
    meadow: lane("Meadow"),
  };
  const fake = engine(lanes);
  fake.setSession({
    id: "scoped-planner-session",
    canEditSettings: false,
    planningProjects: ["Orbit_Main", "lantern", "meadow"],
  });
  const adapter = createRustAdapter(
    createRustApi(async (url, init) => {
      const response = await fake.fetcher(url, init);
      const path = String(url);
      if (path.endsWith("/settings")) {
        const settings = await response.json();
        settings.projects.settings.value.projects.meadow = {
          name: "Meadow",
          repositories: [],
          archived: false,
        };
        return Response.json(settings);
      }
      const owner = /\/planning\/(\w+)\/items$/.exec(path)?.[1];
      if (owner && response.ok)
        return Response.json([
          {
            id: "shared",
            author: "planner",
            kind: "lead",
            title: owner + " idea",
            body: "Work to plan",
            state: "open",
            lanes: ["Delivery_Q4"],
            createdAtMs: 10,
          },
        ]);
      return response;
    }),
  );
  const logStart = fake.reads.length;
  const missing = { key: "Delivery_Q4" };
  await assert.rejects(
    adapter.rpc(api.laneDocumentGet, missing as never),
    /project/,
  );
  await assert.rejects(
    adapter.rpc(api.laneDocumentEdit, {
      ...missing,
      version: 1,
      text: "Wrong lane",
      author: "fixture",
    } as never),
    /project/,
  );
  await assert.rejects(
    adapter.rpc(api.laneStatus, { ...missing, status: "done" } as never),
    /project/,
  );
  assert.deepEqual(fake.reads.slice(logStart), []);
  await assert.rejects(
    adapter.rpc(api.laneDocumentGet, {
      ...missing,
      project: "missing",
    }),
    /no accessible plan/,
  );
  assert.deepEqual(fake.planningReads(), []);

  useNativeStubs();
  const { MainSurface } = await import("../client/queue");
  const { bindBoardShell } = await import("../client/shell");
  const web = await import("../client/web/shell");
  bindBoardShell({ ...web, Icon: () => null });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rows = [
    {
      ...rustTaskCard("orbit-live", "queued", "orbit#1", "example/orbit-docs"),
      title: "Orbit work",
      lanes: ["Delivery_Q4"],
    },
    {
      ...rustTaskCard(
        "lantern-live",
        "working",
        "lantern#2",
        "example/lantern",
      ),
      title: "Lantern work",
      attention: "attention",
      wait: "permission",
      lanes: ["Delivery_Q4"],
    },
    {
      ...rustTaskCard("other-lane", "queued", "lantern#3", "example/lantern"),
      title: "Different lane",
      lanes: ["elsewhere"],
    },
    {
      ...rustTaskCard("finished", "done", "lantern#4", "example/lantern"),
      title: "Finished work",
    },
  ];
  const transport = createRustBoardTransport(async () => Response.json(rows));
  client.setQueryData(
    ["rust-board", "list"],
    await transport.list(new AbortController().signal),
  );
  const h = React.createElement;
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(web.WebContext.Provider, {
        value: { transport: adapter, settings: false },
        children: h((props) => props.children, {
          children: h(MainSurface, {
            theme: { colors: new Proxy({}, { get: () => "#123" }) as never },
            layout: { compact: false },
            rustBoard: createRustInvalidator(client),
          }),
        }),
      }),
    }),
  );
  t.after(() => {
    ui.update(h(React.Fragment));
    client.clear();
    useNativeStubs();
  });
  const visible = async (label: string | RegExp) => {
    await waitFor(() => Boolean(ui.query(label)), 4000, String(label)).catch(
      (error) => {
        throw new Error(
          `${String(error)}; board text: ${ui.text()}; calls: ${fake.reads.join(", ")}`,
        );
      },
    );
  };

  ui.press(/^Planning(?:,|$)/);
  await visible("Project row Orbit");
  ui.press("Project row Meadow");
  await visible("Open lane Meadow delivery");
  ui.press("Open lane Meadow delivery");
  await visible("Open lead meadow idea");
  assert.equal(ui.query("Open lead lantern idea"), undefined);
  ui.press("Project row Orbit");
  await visible("Open lane Orbit delivery");
  ui.press("Open lane Orbit delivery");
  await visible("Read full document for Orbit delivery");
  assert.match(ui.text(), /Orbit document/);
  await visible("orbit#1, Orbit work");
  assert.equal(ui.query("lantern#2, Lantern work"), undefined);

  ui.press("Project row Lantern");
  await visible("Open lane Lantern delivery");
  const beforeOpen = fake.reads.length;
  ui.press("Open lane Lantern delivery");
  await visible("Read full document for Lantern delivery");
  assert.match(ui.text(), /Lantern document/);
  assert.doesNotMatch(ui.text(), /Orbit document/);
  assert.deepEqual(
    fake.reads.slice(beforeOpen).filter((path) => path.includes("/planning/")),
    ["GET /planning/lantern/plan"],
  );

  await visible("lantern#2, Lantern work");
  await visible("Open lead lantern idea");
  assert.equal(ui.query("Open lead meadow idea"), undefined);
  await visible("Live tasks: 1");
  await visible("Need you: 1");
  assert.equal(ui.query("orbit#1, Orbit work"), undefined);
  assert.doesNotMatch(
    ui.text(),
    /Different lane|Finished work|Couldn’t load work/,
  );
  ui.press("lantern#2, Lantern work");
  await visible("Task detail");
  assert.match(ui.text(), /lantern#2/);
  assert.match(ui.text(), /Lantern work/);
  ui.query("Close task")!.props.onPress();
  const laneQueries = client
    .getQueryCache()
    .findAll({ queryKey: ["nucleus", "lane-tasks"] });
  assert.ok(
    laneQueries.every(
      (query) =>
        query.state.fetchFailureCount === 0 &&
        query.state.dataUpdateCount === 0,
    ),
  );

  ui.press("Edit the Lantern delivery document");
  await visible("Lane document text");
  assert.equal(ui.get("Lane document text").props.value, "# Lantern document");
  ui.type("Lane document text", "# Revised Lantern document");
  ui.press("Save the Lantern delivery document");
  await waitFor(
    () => ui.text().includes("Revised Lantern document"),
    HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS,
    "the selected lane displays its saved document",
  );
  assert.equal(lanes.lantern.version, 2);

  await assert.rejects(
    adapter.rpc(api.laneDocumentEdit, {
      ...missing,
      project: "lantern",
      version: 1,
      text: "Stale",
      author: "fixture",
    }),
    /Lane version changed/,
  );
  ui.press("Mark done Lantern delivery");
  assert.match(ui.text(), /1 live task\./);
  ui.type("Closing note", "Landed.");
  ui.press("Mark Lantern delivery done");
  await waitFor(
    () => lanes.lantern.status === "done",
    HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS,
    "Lantern lane closes",
  );
  await assert.rejects(
    adapter.rpc(api.laneStatus, {
      ...missing,
      project: "lantern",
      status: "paused",
    }),
    /supports Open/,
  );
  await visible("Reopen lane Lantern delivery");
  ui.press("Reopen lane Lantern delivery");
  await visible("Mark done Lantern delivery");
  ui.press("Show details for Lantern delivery");
  assert.equal(ui.query("Set lane Delivery_Q4 paused"), undefined);
  ui.press("Set lane Delivery_Q4 abandoned");
  ui.type("Closing note", "Superseded by the release lane.");
  ui.press("Abandon Lantern delivery");
  await waitFor(
    () => lanes.lantern.status === "dropped",
    HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS,
    "Lantern lane dropped",
  );
  const nativeCases = JSON.parse(
    readFileSync("test/fixtures/lane-dispositions.json", "utf8"),
  );
  assert.deepEqual(fake.dispositions, nativeCases);
  assert.deepEqual(lanes.Orbit_Main, lane("Orbit"));
  assert.equal(lanes.lantern.document, "# Revised Lantern document");
  assert.equal(lanes.lantern.version, 2);
  assert.deepEqual(
    fake.reads.filter((path) => /^(PUT|POST) \/planning\//.test(path)),
    [
      "PUT /planning/lantern/lanes/Delivery_Q4",
      "PUT /planning/lantern/lanes/Delivery_Q4",
      "POST /planning/lantern/lanes/Delivery_Q4/status",
      "POST /planning/lantern/lanes/Delivery_Q4/status",
      "POST /planning/lantern/lanes/Delivery_Q4/status",
    ],
  );
});

test("item assessment sends the version seen to the selected project", async () => {
  const fake = engine();
  const sent: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (
      String(input) !==
      "/api/engine/planning/Orbit_Main/items/i-Orbit_Main/assess"
    )
      return fake.fetcher(input, init);
    assert.equal(init?.method, "POST");
    sent.push(JSON.parse(String(init.body)));
    return Response.json({
      id: "i-Orbit_Main",
      title: "Orbit item",
      kind: "lead",
      author: "planner",
      state: "open",
      body: "Assess this",
      lanes: [],
      version: 2,
      createdAtMs: 10,
    });
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  const detail = await adapter.rpc(api.itemAssess, {
    id: "i-Orbit_Main",
    project: projectKey("Orbit_Main"),
    version: 1,
  });
  assert.equal(detail.id, "i-Orbit_Main");
  assert.deepEqual(sent, [{ version: 1 }]);
});

test("a project refusal settles lists until the paired session changes", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  fake.denied.add("lantern");
  const decisions = () => adapter.rpc(api.decisionList, { status: "open" });
  assert.deepEqual(
    (await decisions()).map(({ id }) => id),
    ["d-Orbit_Main"],
  );
  assert.deepEqual(fake.planningReads(), [
    "GET /planning/Orbit_Main/decisions?pending=true",
    "GET /planning/lantern/decisions?pending=true",
  ]);
  fake.denied.clear();
  assert.equal(
    await adapter.refreshSession(),
    false,
    "the same session reconnects",
  );
  await adapter.rpc(api.plans, {});
  const leads = await adapter.rpc(api.leadBoard, {});
  assert.deepEqual(
    leads.cards.map((card) => card.id),
    ["i-Orbit_Main"],
  );
  assert.deepEqual(
    leads.activity?.map(({ id, at, taskIds }) => [id, at, taskIds]),
    [
      ["i-Orbit_Main", new Date(10).toISOString(), []],
      ["promoted", new Date(200).toISOString(), ["finished"]],
    ],
  );
  assert.deepEqual(
    (await decisions()).map(({ id }) => id),
    ["d-Orbit_Main"],
  );
  assert.equal(
    fake.planningReads().filter((path) => path.includes("/lantern/")).length,
    1,
  );
  fake.setSession({
    id: "new-operator-session",
    canEditSettings: true,
    planningProjects: null,
  });
  assert.equal(await adapter.refreshSession(), true);
  assert.deepEqual(
    (await decisions()).map(({ id }) => id),
    ["d-Orbit_Main", "d-lantern"],
  );
});

test("the selected item's project scopes detail, drop, reopen and assessment", async () => {
  const fake = engine();
  const writes: Array<{ path: string; body: unknown }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    const match =
      /\/planning\/([^/]+)\/items(?:\/shared\/(drop|reopen|assess))?$/.exec(
        path,
      );
    if (!match) return fake.fetcher(url, init);
    const item = {
      id: "shared",
      title: match[1] + " item",
      kind: "papercut",
      author: "planner",
      state: "open",
      body: "Repair this",
      lanes: [],
      version: 1,
      createdAtMs: 10,
    };
    if (!match[2]) return Response.json([item]);
    writes.push({ path, body: JSON.parse(String(init?.body)) });
    if (match[2] === "reopen" || match[2] === "assess")
      return Response.json({ ...item, version: 9 });
    return Response.json({ ...item, state: "dropped" });
  };
  const adapter = createRustAdapter(createRustApi(fetcher));
  const id = "shared",
    project = "lantern";
  await assert.rejects(adapter.rpc(api.itemGet, { id }), /ambiguous/);
  assert.equal(writes.length, 0);
  const detail = await adapter.rpc(api.itemGet, { project, id });
  assert.equal(detail.title, "lantern item");
  assert.equal(detail.projectKey, "lantern");
  assert.deepEqual(detail.repositories, [
    { origin: "example/lantern", bound: false },
  ]);
  await adapter.rpc(api.itemDrop, {
    project,
    id,
    disposition: "completed",
    note: "Resolved",
  });
  await adapter.rpc(api.itemReopen, { project, id, version: 1 });
  await adapter.rpc(api.itemAssess, { project, id, version: 1 });
  assert.deepEqual(writes, [
    {
      path: "/api/engine/planning/lantern/items/shared/drop",
      body: { reason: "Resolved", disposition: "completed" },
    },
    {
      path: "/api/engine/planning/lantern/items/shared/reopen",
      body: { version: 1 },
    },
    {
      path: "/api/engine/planning/lantern/items/shared/assess",
      body: { version: 1 },
    },
  ]);
});

test("item editing refuses ambiguous and out-of-scope records before a write", async () => {
  const fake = engine();
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  await assert.rejects(
    adapter.rpc(api.itemGet, { id: "promoted" }),
    /ambiguous/,
  );
  fake.setSession({
    id: "planner",
    canEditSettings: false,
    planningProjects: ["Orbit_Main"],
  });
  await adapter.refreshSession();
  const scoped = await adapter.rpc(api.itemGet, { id: "promoted" });
  assert.equal(scoped.projectKey, projectKey("Orbit_Main"));
  await assert.rejects(
    adapter.rpc(api.itemEdit, {
      id: scoped.id,
      project: "lantern",
      version: scoped.version,
      title: "Wrong project",
      body: "Body",
    }),
    /accessible projects/,
  );
  assert.deepEqual(
    fake.reads.filter((path) => path.startsWith("PUT /planning/")),
    [],
  );
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
        children: h((props) => props.children, {
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

test("Planning preserves native lane titles, aims and closing notes", async () => {
  const title = "a".repeat(201);
  const aim = "a".repeat(2001);
  const note = "n".repeat(4001);
  const lane: RustLane = {
    key: "long",
    version: 1,
    title,
    aim,
    document: "Hello",
    status: "done",
    note,
  };
  const adapter = createRustAdapter(
    createRustApi(engine({ lantern: lane }).fetcher),
  );
  const plans = await adapter.rpc(api.plans, {});
  const view = plans.find((plan) => plan.project === "lantern")?.laneViews?.[0];
  assert.deepEqual([view?.title, view?.aim, view?.note], [title, aim, note]);
});

test("retained items preserve all valid native lane keys", async () => {
  const fake = engine();
  const lanes = Array.from({ length: 33 }, (_, index) => "lane-" + index);
  const adapter = createRustAdapter(
    createRustApi(async (url, init) => {
      const response = await fake.fetcher(url, init);
      if (!String(url).endsWith("/planning/lantern/items")) return response;
      const items = await response.json();
      items[0].lanes = lanes;
      return Response.json(items);
    }),
  );
  const leads = await adapter.rpc(api.leadBoard, {});
  assert.deepEqual(
    leads.cards.find((card) => card.projectKey === "lantern")?.lanes,
    lanes,
  );
});

test("reassigning the final repository leaves its source project and lanes readable", async () => {
  const lane: RustLane = {
    key: "retained",
    version: 1,
    title: "Retained lane",
    aim: "Ship",
    document: "Roadmap",
    status: "open",
  };
  const fake = engine({ lantern: lane });
  const adapter = createRustAdapter(createRustApi(fake.fetcher));
  await adapter.rpc(api.uiSnapshot, {});
  await adapter.rpc(api.projectMerge, {
    source: "lantern",
    target: projectKey("Orbit_Main"),
    versions: { source: 1, target: 1 },
    repository: "example/lantern",
    reason: "Move the last repository",
  });
  const fresh = createRustAdapter(createRustApi(fake.fetcher));
  const board = await fresh.rpc(api.uiSnapshot, {});
  assert.ok(!("unchanged" in board));
  const project = board.projects.find((item) => item.key === "lantern");
  assert.deepEqual(project?.repositories, []);
  assert.equal(project?.primary, null);
  const plans = await fresh.rpc(api.plans, {});
  const saved = plans.find((plan) => plan.project === "lantern")
    ?.laneViews?.[0];
  assert.deepEqual([saved?.key, saved?.repositories], ["retained", []]);
  assert.equal(
    (
      await fresh.rpc(api.laneDocumentGet, {
        project: "lantern",
        key: "retained",
      })
    )?.text,
    "Roadmap",
  );
});
