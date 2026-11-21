import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "../core/host/adapter";
import { Store } from "../core/store/store";
import {
  buildProjectSettings,
} from "../core/planning/project-settings";
import { QueueRuntime } from "../service/runtime-owner";
import {
  DEFAULT_PROJECT_LIMIT,
  ownerCandidateKind,
  PROJECT_OWNER_CANDIDATE_KINDS,
  projectOwnerCandidates,
  projectOwnerCandidateSchema,
  projectSchema,
  projectSettings,
  projectSettingsSchema,
  repositorySettingsSchema,
  type Project,
  type RepositorySettings,
} from "../shared/contracts";
import { formatAgentId } from "../shared/agent-identity";
import { wireLabels } from "../shared/wire-labels";

const alpha = { origin: "acme/alpha", path: "/repos/alpha" };
const beta = { origin: "acme/beta", path: "/repos/beta" };

function project(input: {
  key: string;
  repositories?: Array<{ origin: string | null; path: string }>;
  primary?: { origin: string | null; path: string };
  planner?: { agentId: string; setBy?: string; setAt?: string } | null;
}): Project {
  const repositories = input.repositories ?? [alpha];
  return projectSchema.parse({
    key: input.key,
    name: input.key,
    repositories,
    primary: input.primary ?? repositories[0],
    planner: input.planner
      ? {
          agentId: input.planner.agentId,
          setBy: input.planner.setBy ?? "operator",
          setAt: input.planner.setAt ?? "2026-11-08T00:00:00.000Z",
        }
      : input.planner === null
        ? null
        : undefined,
  });
}

function settingsRow(
  repository: { origin: string | null; path: string },
  revision = 1,
): RepositorySettings {
  return repositorySettingsSchema.parse({
    repository,
    note: "row",
    updatedAt: "2026-11-08T00:00:00.000Z",
    revision,
  });
}

function settings(input: Parameters<typeof buildProjectSettings>[0]) {
  return projectSettingsSchema.parse(buildProjectSettings(input));
}

test("ownerCandidateKind classifies planners apart from task threads", () => {
  assert.equal(ownerCandidateKind(undefined), "planner");
  assert.equal(ownerCandidateKind({}), "planner");
  assert.equal(ownerCandidateKind(wireLabels({})), "planner");
  assert.equal(
    ownerCandidateKind(wireLabels({ role: "worker", task: "t1", run: "r1" })),
    "worker",
  );
  assert.equal(
    ownerCandidateKind(wireLabels({ task: "t1", run: "r1" })),
    "worker",
  );
  // A thread created before Nucleus carries only the recorded label; it is history, not a live alias.
  assert.equal(ownerCandidateKind({ "northstar.task": "t1" }), "planner");
  assert.equal(
    ownerCandidateKind(
      wireLabels({ role: "reviewer", task: "t1", run: "r1", reviewer: "rev" }),
    ),
    "reviewer",
  );
  assert.equal(ownerCandidateKind(wireLabels({ reviewer: "rev" })), "reviewer");
  assert.equal(
    ownerCandidateKind(wireLabels({ role: "recovery", task: "t1" })),
    "recovery",
  );
  assert.equal(
    ownerCandidateKind(wireLabels({ role: "closeout", task: "t1" })),
    "closeout",
  );
  assert.equal(
    ownerCandidateKind(wireLabels({ role: "coordinator", task: "t1" })),
    "coordinator",
  );
  assert.equal(
    ownerCandidateKind(wireLabels({ role: "executor", task: "t1" })),
    "executor",
  );
  assert.equal(ownerCandidateKind(wireLabels({ decider: "q1" })), "other");
  assert.equal(
    ownerCandidateKind({
      "nucleus.role": "worker",
      "northstar.role": "reviewer",
    }),
    "other",
  );
  assert.deepEqual(
    [...PROJECT_OWNER_CANDIDATE_KINDS],
    [
      "planner",
      "worker",
      "reviewer",
      "recovery",
      "closeout",
      "coordinator",
      "executor",
      "other",
    ],
  );
});

test("project.owner-candidates requires kind and refuses a candidate without one", () => {
  const candidate = {
    id: "agent",
    title: "Planner",
    workspaceId: "ws",
    kind: "planner" as const,
  };
  assert.deepEqual(projectOwnerCandidateSchema.parse(candidate), candidate);
  assert.equal(
    projectOwnerCandidateSchema.safeParse({
      id: "agent",
      title: "Planner",
      workspaceId: null,
    }).success,
    false,
  );
  assert.equal(
    projectOwnerCandidates.output.safeParse([candidate]).success,
    true,
  );
});

test("project.settings inherits slots, reports planner state, and matches repository rows", () => {
  const live = project({ key: "live", planner: { agentId: "planner-live" } });
  const gone = project({ key: "gone", planner: { agentId: "planner-gone" } });
  const empty = project({
    key: "empty",
    repositories: [alpha, beta],
    primary: alpha,
  });
  const row = settings({
    projects: [live, gone, empty],
    repositories: [settingsRow(alpha)],
    overrides: { gone: 2 },
    defaultSlots: DEFAULT_PROJECT_LIMIT,
    liveAgentIds: new Set(["planner-live"]),
    liveKnown: true,
  });
  assert.equal(row.defaultSlots, DEFAULT_PROJECT_LIMIT);
  assert.equal("inFlight" in row, false);

  const liveRow = row.projects[0];
  assert.deepEqual(liveRow.slots, {
    value: DEFAULT_PROJECT_LIMIT,
    override: null,
  });
  assert.equal(liveRow.plannerLive, true);
  assert.deepEqual(liveRow.problems, []);
  assert.equal(liveRow.repositories[0].primary, true);
  assert.equal(
    liveRow.repositories[0].settings?.repository.origin,
    alpha.origin,
  );

  const goneRow = row.projects[1];
  assert.deepEqual(goneRow.slots, { value: 2, override: 2 });
  assert.equal(goneRow.plannerLive, false);
  assert.deepEqual(goneRow.problems, []);

  const emptyRow = row.projects[2];
  assert.equal(emptyRow.plannerLive, null);
  assert.deepEqual(emptyRow.problems, []);
  assert.equal(emptyRow.repositories[0].primary, true);
  assert.equal(emptyRow.repositories[1].primary, false);
  assert.equal(emptyRow.repositories[1].settings, null);
  assert.equal("inFlight" in emptyRow, false);
});

test("project.settings treats unknown live inventory as unknown", () => {
  const named = project({ key: "named", planner: { agentId: "planner" } });
  const unknown = settings({
    projects: [named],
    repositories: [],
    overrides: {},
    defaultSlots: 5,
    liveAgentIds: new Set(),
    liveKnown: false,
  });
  assert.equal(unknown.projects[0].plannerLive, null);
  assert.deepEqual(unknown.projects[0].problems, []);
});

function liveAdapter(
  dir: string,
  live: () => Array<{
    id: string;
    title: string;
    workspaceId: string | null;
    labels?: Record<string, string>;
  }>,
  options: { throwLive?: boolean } = {},
): Adapter {
  return {
    client: { isConnected: true },
    isConnected: () => true,
    hostId: "fixture-host",
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "helper.mjs"),
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
    listLiveAgents: async () => {
      if (options.throwLive)
        throw new Error("Live agent inventory was incomplete");
      return live();
    },
  } as unknown as Adapter;
}

function muteAdapter(dir: string): Adapter {
  return {
    client: { isConnected: true },
    isConnected: () => true,
    hostId: "fixture-host",
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "helper.mjs"),
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
  } as unknown as Adapter;
}

test("project.owner-candidates returns classified live threads and an empty list when the host cannot list them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nsq-owner-candidates-"));
  const live = [
    {
      id: "planner",
      title: "Nucleus",
      workspaceId: "ws",
      labels: wireLabels({}),
    },
    {
      id: "worker",
      title: "Worker",
      workspaceId: "ws",
      labels: wireLabels({ role: "worker", task: "t1", run: "r1" }),
    },
    {
      id: "reviewer",
      title: "Review",
      workspaceId: null,
      labels: wireLabels({ role: "reviewer", reviewer: "rev" }),
    },
    {
      id: "recovery",
      title: "Recovery",
      workspaceId: "ws",
      labels: wireLabels({ role: "recovery", task: "t1" }),
    },
  ];
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => liveAdapter(dir, () => live),
    timers: false,
  });
  try {
    await runtime.started;
    const candidates = projectOwnerCandidates.output.parse(
      await runtime.projectOwnerCandidates(),
    );
    assert.deepEqual(
      candidates.map((entry) => ({ id: entry.id, kind: entry.kind })),
      [
        { id: "planner", kind: "planner" },
        { id: "worker", kind: "worker" },
        { id: "reviewer", kind: "reviewer" },
        { id: "recovery", kind: "recovery" },
      ],
    );
    assert.equal("labels" in candidates[0], false);
  } finally {
    await runtime.stop();
  }

  const muteDir = mkdtempSync(join(tmpdir(), "nsq-owner-candidates-mute-"));
  const mute = new QueueRuntime({
    dataDir: muteDir,
    adapterFactory: () => muteAdapter(muteDir),
    timers: false,
  });
  try {
    await mute.started;
    assert.deepEqual(await mute.projectOwnerCandidates(), []);
  } finally {
    await mute.stop();
  }
});

/** An adapter whose live inventory can be made to hang, the way an offline host stalls. */
function stallableAdapter(
  dir: string,
  state: { hang: boolean; throwLive?: boolean },
): Adapter {
  return {
    ...(muteAdapter(dir) as object),
    listLiveAgents: () => {
      if (state.throwLive)
        return Promise.reject(new Error("Live agent inventory was incomplete"));
      if (state.hang) return new Promise(() => {});
      return Promise.resolve([
        { id: "planner-live", title: "Planner", workspaceId: "ws", labels: {} },
      ]);
    },
  } as unknown as Adapter;
}

test("project.settings reads saved data only; the focused project adds live state, and a stalled or failing host never blocks the list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nsq-project-settings-rpc-"));
  const state = { hang: false, throwLive: false };
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => stallableAdapter(dir, state),
    timers: false,
  });
  try {
    await runtime.started;
    runtime.store.upsertProject({
      key: "suite",
      name: "Suite",
      repositories: [alpha, beta],
      primary: alpha,
    });
    runtime.store.setProjectPlanner({
      key: "suite",
      agentId: "planner-live",
      setBy: "operator",
    });
    runtime.store.setProjectDispatchLimitOverride("suite", 3);
    runtime.store.putRepository(alpha, null, "alpha-row");
    // The warm healthy list: saved rows, with planner liveness unknown because no host was read.
    const list = projectSettings.output.parse(await runtime.projectSettings());
    const listed = list.projects.find((entry) => entry.project.key === "suite");
    assert.ok(listed);
    assert.deepEqual(listed.slots, { value: 3, override: 3 });
    assert.equal(listed.plannerLive, null);
    assert.equal(listed.responsibleThread, undefined);
    assert.deepEqual(listed.problems, []);
    assert.equal(listed.repositories[0].settings?.note, "alpha-row");
    assert.equal(listed.repositories[1].settings, null);

    // The focused read is the one place a host is read: the planner is live here.
    const focused = projectSettings.output.parse(
      await runtime.projectSettings({ project: "suite" }),
    );
    assert.deepEqual(
      focused.projects.map((entry) => entry.project.key),
      ["suite"],
    );
    assert.equal(focused.projects[0].plannerLive, true);

    // A hung inventory: the list still answers before the host settles, and the focused row goes unknown.
    state.hang = true;
    const hungList = await Promise.race([
      runtime.projectSettings(),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 1000).unref(),
      ),
    ]);
    assert.notEqual(hungList, "timeout");
    const hungFocus = projectSettings.output.parse(
      await runtime.projectSettings({ project: "suite" }),
    );
    assert.equal(hungFocus.projects[0].plannerLive, null);
    assert.equal(hungFocus.projects[0].slots.value, 3);
    state.hang = false;

    // A failing inventory never fails either read; the saved row stays.
    state.throwLive = true;
    const failingList = projectSettings.output.parse(
      await runtime.projectSettings(),
    );
    assert.equal(failingList.projects[0].plannerLive, null);
    const failingFocus = projectSettings.output.parse(
      await runtime.projectSettings({ project: "suite" }),
    );
    assert.equal(failingFocus.projects[0].plannerLive, null);
    assert.equal(failingFocus.projects[0].slots.value, 3);
    state.throwLive = false;

    // An unknown project is a real failure, not an empty row.
    await assert.rejects(
      () => runtime.projectSettings({ project: "missing" }),
      /Unknown project missing/,
    );
  } finally {
    await runtime.stop();
  }

  const muteDir = mkdtempSync(join(tmpdir(), "nsq-project-settings-mute-"));
  const mute = new QueueRuntime({
    dataDir: muteDir,
    adapterFactory: () => muteAdapter(muteDir),
    timers: false,
  });
  try {
    await mute.started;
    mute.store.upsertProject({
      key: "suite",
      name: "Suite",
      repositories: [alpha],
    });
    mute.store.setProjectPlanner({
      key: "suite",
      agentId: "planner-gone",
      setBy: "operator",
    });
    const page = await mute.projectSettings();
    assert.equal(page.projects[0].plannerLive, null);
    assert.deepEqual(page.projects[0].problems, []);
  } finally {
    await mute.stop();
  }
});

test("project.upsert with create refuses an existing key atomically: a stale list never rewrites another project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nsq-project-create-"));
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => muteAdapter(dir),
    timers: false,
  });
  const gamma = { origin: "acme/gamma", path: "" };
  try {
    await runtime.started;
    // Another client created "suite" after this client's list loaded.
    const existing = runtime.store.upsertProject({
      key: "suite",
      name: "Suite",
      repositories: [alpha, beta],
      primary: alpha,
    });
    runtime.store.setProjectPlanner({
      key: "suite",
      agentId: "planner-suite",
      setBy: "operator",
    });
    const before = runtime.store.projectByKey("suite");
    // The stale client picks the same key with a new primary that would replace the membership.
    assert.throws(
      () =>
        runtime.store.upsertProject({
          key: "suite",
          name: "Other",
          repositories: [gamma, alpha],
          primary: gamma,
          create: true,
        }),
      /Project suite already exists\. Nothing changed/,
    );
    assert.deepEqual(
      runtime.store.projectByKey("suite"),
      before,
      "the existing project, its membership and planner are untouched",
    );
    assert.equal(before?.version, existing.version);
    assert.equal(
      runtime.store.projectFor("", "acme/gamma")?.key ?? null,
      null,
      "no default project was made for the refused repository either",
    );
    // A free key creates; without create the call stays an upsert.
    const made = runtime.store.upsertProject({
      key: "suite-2",
      name: "Other",
      repositories: [gamma],
      create: true,
    });
    assert.equal(made.version, 1);
    assert.equal(
      runtime.store.upsertProject({
        key: "suite",
        name: "Suite renamed",
        repositories: [alpha, beta],
        primary: alpha,
      }).name,
      "Suite renamed",
    );
  } finally {
    await runtime.stop();
  }
});

test("T3-only with a saved offline Paseo planner: the list answers from saved data, and the planner reads unknown, never gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nsq-project-settings-t3-"));
  const planner = formatAgentId("paseo-synthetic", "planner-paseo");
  const state = { hang: false, reject: false };
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () =>
      ({
        ...(muteAdapter(dir) as object),
        hostId: "t3code:synthetic",
        listLiveAgents: () => {
          if (state.reject)
            return Promise.reject(
              new Error("Transport not connected (status: disconnected)"),
            );
          if (state.hang) return new Promise(() => {});
          return Promise.resolve([]);
        },
      }) as unknown as Adapter,
    timers: false,
  });
  try {
    await runtime.started;
    runtime.store.upsertProject({
      key: "suite",
      name: "Suite",
      repositories: [alpha],
    });
    runtime.store.setProjectPlanner({
      key: "suite",
      agentId: planner,
      setBy: "operator",
    });

    // The T3 inventory hangs: the saved list still answers, with the planner unknown.
    state.hang = true;
    const list = await Promise.race([
      runtime.projectSettings(),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 1000).unref(),
      ),
    ]);
    if (list === "timeout") assert.fail("the saved list waited on a host");
    const listed = projectSettings.output.parse(list).projects[0];
    assert.equal(listed.plannerLive, null);
    assert.deepEqual(listed.problems, []);
    state.hang = false;

    // A healthy T3 inventory cannot observe a Paseo planner: unknown, never gone.
    const observed = projectSettings.output.parse(
      await runtime.projectSettings({ project: "suite" }),
    );
    assert.equal(observed.projects[0].plannerLive, null);
    assert.equal(observed.projects[0].slots.value, DEFAULT_PROJECT_LIMIT);

    // An offline T3 transport: the focused row still returns, and the planner stays unknown.
    state.reject = true;
    const offline = projectSettings.output.parse(
      await runtime.projectSettings({ project: "suite" }),
    );
    assert.equal(offline.projects[0].plannerLive, null);
    assert.equal(offline.projects[0].project.planner?.agentId, planner);
  } finally {
    await runtime.stop();
  }
});

test("T3 healthy with the saved Paseo host offline: the list renders, the Paseo planner is unknown, and an ordinary edit still saves", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "nsq-project-settings-paseo-offline-"),
  );
  const paseo = "paseo-synthetic";
  const t3 = "t3code:synthetic";
  const planner = formatAgentId(paseo, "planner-paseo");
  // The configured daemon is Paseo: the saved primary, whose transport is down.
  const seed = new Store(join(dir, "queue.sqlite"));
  seed.setMeta("hostRegistry", [
    { id: paseo, endpoint: "ws://127.0.0.1:6767/ws" },
  ]);
  seed.close();
  const down = () =>
    Promise.reject(new Error("Transport not connected (status: disconnected)"));
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () =>
      ({
        ...(muteAdapter(dir) as object),
        hostId: paseo,
        client: { isConnected: false },
        isConnected: () => false,
        connect: down,
        listLiveAgents: down,
      }) as unknown as Adapter,
    timers: false,
  });
  try {
    await runtime.started;
    // T3 is a second, connected host: it is online while the saved Paseo daemon is offline.
    runtime.hostRegistry.connect(t3, "ws://127.0.0.1:6768/ws", {} as never);
    const hosts = runtime.hostList().hosts;
    assert.equal(hosts.find((host) => host.id === t3)?.state, "online");
    assert.equal(hosts.find((host) => host.id === paseo)?.state, "offline");
    runtime.store.upsertProject({
      key: "suite",
      name: "Suite",
      repositories: [alpha],
    });
    runtime.store.setProjectPlanner({
      key: "suite",
      agentId: planner,
      setBy: "operator",
    });

    const list = projectSettings.output.parse(await runtime.projectSettings());
    assert.equal(
      list.projects[0].plannerLive,
      null,
      "the list does not read the offline Paseo host",
    );
    const focused = projectSettings.output.parse(
      await runtime.projectSettings({ project: "suite" }),
    );
    assert.equal(
      focused.projects[0].plannerLive,
      null,
      "an offline Paseo planner is unknown, never gone",
    );

    // An ordinary edit saves while Paseo is offline, and the saved planner is untouched.
    await runtime.upsertProject({
      key: "suite",
      name: "Suite renamed",
      repositories: [{ origin: alpha.origin, path: "" }],
    });
    const renamed = projectSettings.output.parse(
      await runtime.projectSettings(),
    );
    assert.equal(renamed.projects[0].project.name, "Suite renamed");
    assert.equal(renamed.projects[0].project.planner?.agentId, planner);
  } finally {
    await runtime.stop();
  }
});
