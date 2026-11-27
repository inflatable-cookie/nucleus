import { test } from "node:test";

const iconOf = (node: {
  type: string;
  props: Record<string, any>;
  children: unknown[];
}): string | undefined => {
  if (node.type === "Icon") return node.props.name;
  for (const child of node.children)
    if (typeof child !== "string") {
      const found = iconOf(child as never);
      if (found) return found;
    }
  return undefined;
};
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import {
  type Project,
  type ProjectSettings,
  type ProjectSettingsRow,
  type RepositorySettings,
} from "../shared/contracts";

useNativeStubs();
const h = React.createElement;
const syntheticHome = ["", "Users", "example"].join("/");
const dark = {
  accent: "#1f6feb",
  accentForeground: "#fff",
  surface0: "#0d1117",
  surface1: "#161b22",
  surface2: "#30363d",
  border: "#30363d",
  foreground: "#f0f6fc",
  foregroundMuted: "#8b949e",
  statusSuccess: "#3fb950",
  statusWarning: "#f0883e",
  statusDanger: "#f85149",
} as never;
async function settle(probe: () => boolean, label = "screen") {
  for (const deadline = Date.now() + 3_000; Date.now() < deadline; ) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} did not settle`);
}
const textOf = (node: HostNode | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const done = (ui: { update(next: React.ReactElement): void }) =>
  ui.update(h("View"));

type Repo = { origin: string | null; path: string };
const repo = (origin: string): Repo => ({
  origin,
  path: `/workspace/user/Dev/${origin.split("/")[1]}`,
});
const settingsRow = (
  repository: Repo,
  extra: Partial<RepositorySettings> = {},
): RepositorySettings => ({
  repository,
  scratchNamespace: null,
  closeout: null,
  validation: null,
  reviewer: null,
  qa: null,
  affectedTests: null,
  checksPolicy: null,
  hostKind: null,
  workspaceProvider: null,
  note: "",
  updatedAt: "2026-11-08T00:00:00.000Z",
  revision: 1,
  ...extra,
});
function row(
  key: string,
  name: string,
  repos: Repo[],
  extra: Partial<ProjectSettingsRow> & {
    settings?: Array<RepositorySettings | null>;
    planner?: string;
  } = {},
): ProjectSettingsRow {
  const { settings, planner, ...rest } = extra;
  return {
    project: {
      key,
      name,
      version: 3,
      
      repositories: repos,
      primary: repos[0]!,
      drain: null,
      ...(planner
        ? {
            planner: {
              agentId: planner,
              setBy: "operator",
              setAt: "2026-11-08T00:00:00.000Z",
            },
          }
        : {}),
    },
    repositories: repos.map((repository, index) => ({
      repository,
      primary: index === 0,
      settings: settings?.[index] ?? null,
    })),
    slots: { value: 4, override: null },
    plannerLive: planner ? true : null,
    plannerTicket: planner ? "issued" : null,
    problems: [],
    ...rest,
  } as ProjectSettingsRow;
}
const implicit = (origin: string) =>
  row(
    `repo-${Buffer.from(origin).toString("hex").padEnd(20, "0").slice(0, 20)}`,
    origin.split("/")[1]!,
    [repo(origin)],
  );
const settingsOf = (projects: ProjectSettingsRow[]): ProjectSettings => ({
  defaultSlots: 4,
  projects,
});
const candidates = [
  {
    id: "agent-planner",
    title: "Nucleus planner",
    workspaceId: null,
    kind: "planner" as const,
  },
  {
    id: "agent-other-planner",
    title: "Consumer planner",
    workspaceId: null,
    kind: "planner" as const,
  },
  {
    id: "agent-worker",
    title: "950: a task thread",
    workspaceId: null,
    kind: "worker" as const,
  },
  {
    id: "agent-reviewer",
    title: "Review 950",
    workspaceId: null,
    kind: "reviewer" as const,
  },
];

type Call = [string, any];
function harness(
  initial: ProjectSettings,
  options: {
    refuse?: (method: string, input: any) => string | null;
    refreshFailure?: string;
    blockers?: (input: any) => Promise<unknown>;
    mergeCheck?: (input: any) => Promise<unknown>;
    candidates?: {
      data: typeof candidates | undefined;
      error: unknown;
      isPending: boolean;
    };
  } = {},
) {
  const calls: Call[] = [];
  let data = initial,
    error: unknown = null,
    refreshes = 0;
  const reply = (method: string, input: any, result: unknown) => {
    calls.push([method, input]);
    const refusal = options.refuse?.(method, input);
    if (refusal) return Promise.reject(new Error(refusal));
    return Promise.resolve(result);
  };
  const projectOf = (key: string): Project =>
    data.projects.find((entry) => entry.project.key === key)!.project;
  const edit = {
    saveProject: (input: any) =>
      reply("project.upsert", input, {
        ...projectOf(input.key),
        ...input,
        version: projectOf(input.key).version + 1,
      }),
    setPlanner: (input: any) =>
      reply("project.set-planner", input, {
        ...projectOf(input.key),
        version: projectOf(input.key).version + 1,
      }),
    registerAgent: (input: any) =>
      reply("agent.register", input, {
        ...projectOf(input.project),
        version: projectOf(input.project).version + 1,
        agents: [
          ...(projectOf(input.project).agents ?? []),
          {
            name: input.name,
            purpose: input.purpose,
            agentId: input.agentId,
            hostId: "host",
            registeredBy: "operator (board)",
            registeredAt: "2026-11-11T10:00:00.000Z",
          },
        ],
      }),
    unregisterAgent: (input: any) =>
      reply("agent.unregister", input, {
        ...projectOf(input.project),
        version: projectOf(input.project).version + 1,
        agents: (projectOf(input.project).agents ?? []).filter(
          (agent) => agent.name !== input.name,
        ),
      }),
    setSlots: (input: any) =>
      reply("queue.project-dispatch-limit", input, { ok: true }),
    setRepository: (input: any) => reply("repository.set", input, {}),
    repositoryBlockers: (input: any) => {
      calls.push(["project.removal-blockers", input]);
      return options.blockers ? options.blockers(input) : Promise.resolve([]);
    },
    removeRepository: (input: any) =>
      reply("project.remove-repository", input, {
        project: {
          ...projectOf(input.key),
          repositories: projectOf(input.key).repositories.filter(
            (member) => member.origin !== input.repository,
          ),
          version: input.version + 1,
        },
        tombstone: {
          key: "repo-x",
          repositories: [],
          reason: input.reason,
          removedAt: "now",
        },
      }),
    mergeCheck: (input: any) => {
      calls.push(["project.merge-check", input]);
      return options.mergeCheck
        ? options.mergeCheck(input)
        : Promise.resolve({ blockers: [], carried: [] });
    },
    merge: (input: any) => {
      const source = projectOf(input.source),
        target = projectOf(input.target);
      const moving = input.repository
        ? source.repositories.filter(
            (member) => member.origin === input.repository,
          )
        : source.repositories;
      const rest = source.repositories.filter(
        (member) => !moving.includes(member),
      );
      return reply("project.merge", input, {
        project: {
          ...target,
          repositories: [...target.repositories, ...moving],
          version: input.versions.target + 1,
        },
        source: rest.length
          ? {
              ...source,
              repositories: rest,
              version: input.versions.source + 1,
            }
          : null,
        tombstone: rest.length
          ? null
          : {
              key: source.key,
              repositories: source.repositories,
              reason: input.reason,
              removedAt: "now",
            },
      });
    },
    refresh: async () => {
      refreshes++;
      if (options.refreshFailure) throw new Error(options.refreshFailure);
    },
    candidates: options.candidates ?? {
      data: candidates,
      error: null,
      isPending: false,
    },
  };
  let ui!: ReturnType<typeof mount>;
  let render!: () => React.ReactElement;
  return {
    calls,
    get refreshes() {
      return refreshes;
    },
    async mount(compact: boolean) {
      const { ProjectsSection } = await import("../client/projects-settings");
      const { PopoverHost } = await import("../client/popover");
      render = () =>
        h(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          h(PluginRpcProvider, {
            invoke: async () => assert.fail("the board reads nothing here"),
            children: h(
              PopoverHost,
              null,
              h(ProjectsSection, {
                c: dark,
                compact,
                inset: compact ? 16 : 24,
                query: { data, error, isPending: false, refetch: () => {} },
                edit: edit as never,
              }),
            ),
          }),
        );
      ui = mount(render());
      return ui;
    },
    set(next: { data?: ProjectSettings; error?: unknown }) {
      if (next.data) data = next.data;
      if ("error" in next) error = next.error;
      ui.update(render());
    },
  };
}

test("a failed project settings refresh is visible in the save status", async () => {
  const app = harness(
    settingsOf([row("nucleus", "Nucleus", [repo("acme/nucleus")])]),
    { refreshFailure: "settings read failed" },
  );
  const ui = await app.mount(false);
  try {
    ui.press("Nucleus");
    ui.type("Project name", "Renamed");
    ui.get("Project name").props.onBlur();
    await settle(
      () => app.refreshes === 1 && /Refresh failed/.test(ui.text()),
      "refresh failure",
    );
    assert.equal(
      ui.get("Nucleus save status").children.join(""),
      "Refresh failed",
      "the project write succeeded; only the refresh failed",
    );
    ui.press("Refresh failed help");
    await settle(
      () => /settings read failed/.test(ui.text()),
      "refresh reason",
    );
  } finally {
    done(ui);
  }
});

test("helpers: commands split like a shell and join back", async () => {
  const { splitCommand, joinCommand } = await import(
    "../client/project-helpers"
  );
  assert.deepEqual(splitCommand("effigy qa"), { argv: ["effigy", "qa"] });
  assert.deepEqual(
    splitCommand(`  npm run "test all"  --grep 'a b' x\\ y "q\\"t" `),
    { argv: ["npm", "run", "test all", "--grep", "a b", "x y", 'q"t'] },
  );
  assert.deepEqual(splitCommand(""), { argv: [] });
  assert.deepEqual(
    splitCommand(`""`),
    { argv: [""] },
    "an empty quoted word is a word",
  );
  assert.deepEqual(splitCommand(`echo "open`), {
    error: "a quote is not closed",
  });
  for (const argv of [
    ["effigy", "qa"],
    ["sh", "-c", "it's a test"],
    ["node", "--flag=a b", ""],
    ["a\\b", "$HOME"],
  ])
    assert.deepEqual(
      splitCommand(joinCommand(argv)),
      { argv },
      `round trip ${JSON.stringify(argv)}`,
    );
  assert.equal(
    joinCommand(["effigy", "qa", "--timeout=120"]),
    "effigy qa --timeout=120",
    "plain words stay bare",
  );
});

test("the empty name is held back with its reason and never sent; a repository change keeps the stored name", async () => {
  const app = harness(
    settingsOf([
      implicit("acme/book"),
      row("nucleus", "Nucleus", [repo("acme/nucleus")]),
    ]),
  );
  const ui = await app.mount(false);
  try {
    ui.press("Nucleus");
    ui.type("Project name", "  ");
    assert.equal(ui.get("Nucleus save status").children.join(""), "Not saved");
    ui.press("Not saved help");
    assert.match(ui.text(), /Name is empty/);
    ui.press("Add repository, +");
    ui.press("Add repository: acme/book");
    await settle(() => app.calls.length === 1, "add");
    assert.deepEqual(app.calls[0], [
      "project.upsert",
      {
        key: "nucleus",
        name: "Nucleus",
        repositories: [repo("acme/nucleus"), repo("acme/book")],
        primary: repo("acme/nucleus"),
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      ui.get("Nucleus save status").children.join(""),
      "Not saved",
      "the repository change landed, but the empty name is still held back, never Saved",
    );
    assert.equal(
      ui.get("Project name").props.value,
      "  ",
      "the draft name stays",
    );
    assert.equal(
      ui.get("Not saved help").props.accessibilityHint,
      "Name is empty",
    );
    ui.type("Project name", "Nucleus core");
    ui.get("Project name").props.onBlur();
    await settle(() => app.calls.length === 2, "valid name");
    assert.equal(app.calls[1]![1].name, "Nucleus core");
    await settle(
      () => ui.query("Nucleus save status")?.children.join("") === "Saved",
      "saved once the name is valid",
    );
  } finally {
    done(ui);
  }
});

test("the Rust board can move a project's first repository on its own", async () => {
  const { MoveRepositoryConfirm } = await import("../client/project-editor/management");
  const primary = repo("acme/tools");
  const source = row("tools", "Tools", [primary, repo("acme/kit")]).project;
  let moves = 0;
  const ui = mount(h((props) => props.children, {
    children: h(MoveRepositoryConfirm, {
      c: dark, repo: primary, source, target: "Site",
      onMoveRepository: () => { moves += 1; },
      onCancel: () => {},
    }),
  }));
  assert.equal(ui.query("Move all of Tools into Site"), undefined);
  ui.press("Move acme/tools into Site");
  assert.equal(moves, 1);
  done(ui);
});

test("parking is retired: Settings → Projects has no Park or Unpark", async () => {
  const app = harness(
    settingsOf([
      row("nucleus", "Nucleus", [repo("acme/nucleus")]),
      row("dormant", "Dormant", [repo("acme/dormant")]),
    ]),
  );
  const ui = await app.mount(true);
  try {
    for (const name of ["Nucleus", "Dormant"]) {
      ui.press(name);
      assert.equal(ui.query(`Park ${name}`), undefined, `${name}: no Park`);
      assert.equal(ui.query(`Unpark ${name}`), undefined, `${name}: no Unpark`);
      assert.doesNotMatch(ui.text(), /Parked/);
      ui.press(`Back to Projects`);
    }
    assert.deepEqual(app.calls.filter(([method]) => method === "project.park" || method === "project.unpark"), []);
  } finally {
    done(ui);
  }
});

test("Rust Settings opens a project without requesting owner candidates or showing a planner warning", async () => {
  const data = settingsOf([
    row("suite", "Suite", [repo("acme/suite")], {
      planner: "paseo-synthetic:planner-paseo",
      plannerLive: null,
    }),
  ]);
  const never = () => new Promise<never>(() => {});
  const writes: Array<[string, unknown]> = [];
  const board = {
    revision: 1,
    connected: true,
    hostId: "t3code:synthetic",
    paused: false,
    error: "",
    quiet: true,
    activeWorkers: 0,
    unsettled: 0,
    globalLimit: 32,
    projectLimit: 4,
    tasks: [],
    profiles: [],
    pool: [],
    availability: [],
    assignments: {},
    recentAssignments: {},
    lanes: [],
    projects: [],
    projectLimitOverrides: {},
    projectInFlightLimitOverrides: {},
    projectCapacities: [],
    prStates: {},
    usage: { level: "normal", setLevel: "normal", until: null, expired: false },
    backup: { newestSnapshotAt: new Date().toISOString(), localError: null },
  };
  const { QueueSettingsScreen } = await import("../client/settings-screen");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let candidateReads = 0;
  const invoke = async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") return board;
    if (method === "backup.list") return { snapshots: [], localError: null };
    if (method === "project.upsert") {
      writes.push([method, input]);
      return {
        ...data.projects[0]!.project,
        name: (input as { name: string }).name,
        version: 4,
      };
    }
    // The saved list answers at once, and so does the focused read of the open project.
    if (method === "project.settings") return data;
    if (method === "project.owner-candidates") {
      candidateReads++;
      throw new Error("Transport not connected (status: disconnected)");
    }
    return never();
  };
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h((props) => props.children, {
        children: h(PluginRpcProvider, {
          invoke: invoke as never,
          children: h(QueueSettingsScreen as never, {
            theme: { colors: dark },
            layout: { compact: false, platform: "ios" },
            host: { id: "t3code:synthetic", label: "T3" },
          }),
        }),
      }),
    }),
  );
  try {
    ui.get("Nucleus settings").props.onLayout({
      nativeEvent: { layout: { width: 1024 } },
    });
    await settle(() => ui.text().includes("Usage level"), "limits");
    ui.press("Projects");
    await settle(
      () => Boolean(ui.query("Suite")),
      "list renders with the Paseo host offline",
    );
    ui.press("Suite");
    await settle(() => Boolean(ui.query("Project name")), "opened project is visible");
    assert.equal(candidateReads, 0);
    assert.doesNotMatch(ui.text(), /Couldn't load threads/);
    // The planner is shown by its saved id and is not reported gone; saved fields stay enabled.
    assert.equal(ui.text().includes("Gone"), false);
    assert.ok(ui.query("Project name"));
    assert.equal(ui.text().includes("Live status is unavailable"), false);
    // An ordinary edit saves in the same condition: the rename autosaves and the planner is not written.
    ui.type("Project name", "Suite renamed");
    await settle(
      () => writes.length === 1,
      "rename saved with the Paseo host offline",
    );
    assert.deepEqual(writes[0], [
      "project.upsert",
      {
        key: "suite",
        name: "Suite renamed",
        repositories: [repo("acme/suite")],
      },
    ]);
  } finally {
    done(ui);
  }
});
