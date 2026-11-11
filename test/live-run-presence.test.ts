import { observeIdle } from './support/fakes';
/**
 * Live run presence (task 530): while a test, QA or proof run is live, the
 * operator sees one terminal tab in the owning workspace following the run's
 * live output, and a coloured label on that workspace.
 *
 * Every fixture here is a fresh mktemp and a fake daemon: no live database, no
 * Paseo, and no real run is started. The fake daemon keeps its own workspace,
 * terminal and label state, so a second pass reads back what a first pass
 * changed and the projection is exercised the way the real daemon would answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_RUN_PRESENCE_INTERVAL_MS,
  RUN_TERMINAL_FOLLOWER,
  LiveRunPresence,
  liveRunPresenceTargets,
  type LiveRunPresenceWorkspace,
  type RunPresenceDaemon,
  type RunPresenceTerminal,
  type RunTerminalPointer,
} from "../core/telemetry/live-run-presence";
import { hostRunSupervisorPaths } from "../service/callbacks/host-run-endpoint";
import { projectValidationSupervisorPaths } from "../core/qa/project-validation-supervisor";
import {
  qaRunLiveOutputPath,
  qaRunRootPath,
} from "../core/qa/project-qa-supervisor";
import type {
  HostRunInternalRecord,
  ProjectQaRun,
  Task,
} from "../shared/contracts";
import { hostRunSettlementSchema } from "../shared/contracts";
import { QueueRuntime } from "../service/runtime-owner";
import type { Adapter } from "../core/host";

const scratch = (t: any): string => {
  const root = mkdtempSync(join(tmpdir(), "queue-live-run-presence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
// Anchored to this test's own clock: a fixed date would make a fresh run look
// overdue (or a settled one look live) depending on when the suite runs.
const t0 = Date.now();
const at = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

/** A launched client-protocol run: the projection reads only these fields. */
const clientRun = (
  id: string,
  path: string,
  selector = "test unit",
  overrides: Partial<HostRunInternalRecord> = {},
) =>
  ({
    id,
    epoch: 1,
    state: "running",
    submissionSource: "client",
    caller: `client:${id}`,
    repository: { origin: null, path },
    selector,
    runClass: "heavy",
    classSource: "default",
    submittedAt: at(0),
    launchedAt: at(1_000),
    runTimeoutMs: 30 * 60_000,
    settlement: null,
    ...overrides,
  }) as unknown as HostRunInternalRecord;

const taskAt = (
  directory: string,
  workspaceId: string,
  overrides: { projectValidation?: unknown } = {},
) =>
  ({
    id: `task-${workspaceId}`,
    directory,
    workspaceId,
    resolution: { projectValidation: overrides.projectValidation ?? null },
    proofExecutions: [],
  }) as unknown as Task;

const qaRun = (
  id: string,
  key: string,
  overrides: Partial<ProjectQaRun> = {},
) =>
  ({
    id,
    key,
    state: "running",
    selector: "qa:stage:rust",
    exitCode: null,
    durationMs: 0,
    steps: [],
    ...overrides,
  }) as unknown as ProjectQaRun;

interface FakeState {
  workspaces: Array<{ id: string; directory: string | null; labels: string[] }>;
  terminals: Array<{
    id: string;
    name: string;
    workspaceId: string;
    cwd: string;
    command?: string;
    args?: string[];
  }>;
  creates: RunPresenceTerminal[];
  ensured: string[];
  assignments: Array<{ workspaceId: string; name: string; assigned: boolean }>;
  workspaceReads: number;
  opened: Array<{ directory: string; requestId: string }>;
  fail: {
    workspaces: number;
    createTerminal: number;
    assign: number;
    openWorkspace: number;
  };
}

function fakeDaemon(workspaces: LiveRunPresenceWorkspace[]): {
  daemon: RunPresenceDaemon;
  state: FakeState;
} {
  const state: FakeState = {
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      directory: workspace.directory,
      labels: [...workspace.labels],
    })),
    terminals: [],
    creates: [],
    ensured: [],
    assignments: [],
    workspaceReads: 0,
    opened: [],
    fail: { workspaces: 0, createTerminal: 0, assign: 0, openWorkspace: 0 },
  };
  const daemon: RunPresenceDaemon = {
    workspaces: async () => {
      state.workspaceReads++;
      if (state.fail.workspaces > 0) {
        state.fail.workspaces--;
        throw new Error("daemon unavailable");
      }
      return state.workspaces.map((workspace) => ({
        id: workspace.id,
        directory: workspace.directory,
        labels: [...workspace.labels],
      }));
    },
    listTerminals: async (workspaceId) =>
      state.terminals
        .filter((terminal) => terminal.workspaceId === workspaceId)
        .map((terminal) => ({ id: terminal.id, name: terminal.name })),
    openWorkspace: async (input) => {
      state.opened.push(input);
      if (state.fail.openWorkspace > 0) {
        state.fail.openWorkspace--;
        throw new Error("opening the workspace was refused");
      }
      // A real open registers one sidebar entry on that checkout: no worktree.
      const workspace = {
        id: `workspace-opened-${state.workspaces.length + 1}`,
        directory: input.directory,
        labels: [] as string[],
      };
      state.workspaces.push(workspace);
      return { id: workspace.id, directory: workspace.directory };
    },
    createTerminal: async (input) => {
      if (state.fail.createTerminal > 0) {
        state.fail.createTerminal--;
        throw new Error("terminal refused");
      }
      state.creates.push(input);
      const terminal = {
        id: `terminal-${state.terminals.length + 1}`,
        workspaceId: input.workspaceId,
        name: input.name,
        cwd: input.cwd,
        command: input.command,
        args: input.args,
      };
      state.terminals.push(terminal);
      return { id: terminal.id };
    },
    ensureWorkspaceLabel: async (label) => {
      state.ensured.push(label.name);
    },
    assignWorkspaceLabel: async (input) => {
      if (state.fail.assign > 0) {
        state.fail.assign--;
        throw new Error("label refused");
      }
      state.assignments.push({
        workspaceId: input.workspaceId,
        name: input.label.name,
        assigned: input.assigned,
      });
      const workspace = state.workspaces.find(
        (candidate) => candidate.id === input.workspaceId,
      );
      if (!workspace) return;
      workspace.labels = input.assigned
        ? [...new Set([...workspace.labels, input.label.name])]
        : workspace.labels.filter((name) => name !== input.label.name);
    },
  };
  return { daemon, state };
}

interface PresenceInput {
  runs: () => HostRunInternalRecord[];
  settledRun?: (id: string) => HostRunInternalRecord | null;
  tasks?: () => Task[];
  qaRun?: (id: string) => ProjectQaRun | null;
  now?: () => number;
}

const presenceFor = (
  root: string,
  daemon: RunPresenceDaemon,
  input: PresenceInput,
) =>
  new LiveRunPresence({
    dataDir: join(root, "data"),
    stateDir: join(root, "host-run"),
    runs: input.runs,
    settledRun: input.settledRun ?? (() => null),
    tasks: input.tasks ?? (() => []),
    qaRun: input.qaRun ?? (() => null),
    daemon: () => daemon,
    log: () => {},
    ...(input.now ? { now: input.now } : {}),
  });

const pointerOf = (
  root: string,
  presence: LiveRunPresence,
  key: string,
): RunTerminalPointer =>
  JSON.parse(
    readFileSync(presence.pointerPath(key), "utf8"),
  ) as RunTerminalPointer;

test("a live task run opens one tab in the task workspace and labels it Testing", async (t) => {
  const root = scratch(t);
  const directory = join(root, "worktree");
  mkdirSync(directory, { recursive: true });
  const { daemon, state } = fakeDaemon([
    { id: "ws-task", directory, labels: [] },
  ]);
  const run = clientRun("run-1", directory);
  const presence = presenceFor(root, daemon, {
    runs: () => [run],
    tasks: () => [taskAt(directory, "ws-task")],
  });

  await presence.reconcile();

  assert.equal(state.creates.length, 1, "exactly one tab is opened");
  const created = state.creates[0]!;
  assert.equal(created.workspaceId, "ws-task");
  assert.equal(created.cwd, directory, "the tab opens in the task workspace");
  assert.equal(created.name, "Testing · test unit");
  assert.equal(created.command, "/usr/bin/env");
  assert.deepEqual(created.args, [
    "ELECTRON_RUN_AS_NODE=1",
    process.execPath,
    RUN_TERMINAL_FOLLOWER.script,
    presence.pointerPath(`test|${directory}|test unit`),
  ]);
  const pointer = pointerOf(root, presence, `test|${directory}|test unit`);
  assert.equal(pointer.runId, "run-1");
  assert.equal(pointer.settledLine, null);
  const retained = hostRunSupervisorPaths(join(root, "host-run"), "run-1");
  assert.deepEqual(
    pointer.outputs,
    [retained.stdoutPath, retained.stderrPath],
    "a client-protocol run is followed through the retained output its supervisor writes",
  );
  assert.deepEqual(state.assignments, [
    { workspaceId: "ws-task", name: "Testing", assigned: true },
  ]);
  assert.deepEqual(
    state.ensured,
    ["Testing"],
    "the label definition exists before it is assigned",
  );
  // A colour comes with the label; the workspace title is never touched.
  assert.deepEqual(state.workspaces[0]!.labels, ["Testing"]);
});

test("a second run of the same selector reuses the one tab and repoints its follower", async (t) => {
  const root = scratch(t);
  const directory = join(root, "worktree");
  mkdirSync(directory, { recursive: true });
  const { daemon, state } = fakeDaemon([
    { id: "ws-task", directory, labels: [] },
  ]);
  let runs = [clientRun("run-1", directory)];
  const presence = presenceFor(root, daemon, {
    runs: () => runs,
    tasks: () => [taskAt(directory, "ws-task")],
  });
  await presence.reconcile();
  const key = `test|${directory}|test unit`;
  const first = pointerOf(root, presence, key);
  assert.equal(first.sessionId, "run-1@" + at(1_000));

  runs = [
    clientRun("run-2", directory, "test unit", {
      submittedAt: at(60_000),
      launchedAt: at(61_000),
    }),
  ];
  await presence.reconcile();
  await presence.reconcile();

  assert.equal(
    state.creates.length,
    1,
    "the workspace keeps one tab for this selector",
  );
  const second = pointerOf(root, presence, key);
  assert.equal(second.runId, "run-2");
  assert.equal(
    second.sessionId,
    "run-2@" + at(61_000),
    "a new run starts a new following session in the same tab",
  );
  const retained2 = hostRunSupervisorPaths(join(root, "host-run"), "run-2");
  assert.deepEqual(second.outputs, [
    retained2.stdoutPath,
    retained2.stderrPath,
  ]);
  assert.equal(second.settledLine, null);
  // A steady pass over a live run rewrites nothing: the follower polls a file
  // that says the same thing, so its stamp does not move either.
  const steady = readFileSync(presence.pointerPath(key), "utf8");
  await presence.reconcile();
  assert.equal(readFileSync(presence.pointerPath(key), "utf8"), steady);
});

test("a settled run clears its label and leaves the tab on the final status line", async (t) => {
  const root = scratch(t);
  const directory = join(root, "worktree");
  mkdirSync(directory, { recursive: true });
  const { daemon, state } = fakeDaemon([
    { id: "ws-task", directory, labels: [] },
  ]);
  let runs = [clientRun("run-1", directory)];
  const settled = clientRun("run-1", directory, "test unit", {
    state: "settled",
    launchedAt: at(1_000),
    settlement: {
      format: "host.run.settlement",
      version: 1,
      runId: "run-1",
      outcome: "failed",
      launched: true,
      settledAt: at(96_000),
      result: {
        format: "host.run.result",
        version: 1,
        runId: "run-1",
        epoch: 1,
        pgid: 4242,
        startIdentity: "identity",
        exitCode: 1,
        signal: null,
        startedAt: at(1_000),
        endedAt: at(96_000),
        wallMs: 95_000,
        cpuMs: 10,
        escapedDescendants: [],
      },
      containers: [],
    },
  });
  const presence = presenceFor(root, daemon, {
    runs: () => runs,
    tasks: () => [taskAt(directory, "ws-task")],
    settledRun: () => settled,
  });
  await presence.reconcile();
  runs = [];
  await presence.reconcile();

  const pointer = pointerOf(root, presence, `test|${directory}|test unit`);
  assert.equal(
    pointer.settledLine,
    "Testing · test unit · failed (exit 1) in 1m 35s",
  );
  assert.deepEqual(state.assignments.at(-1), {
    workspaceId: "ws-task",
    name: "Testing",
    assigned: false,
  });
  assert.deepEqual(state.workspaces[0]!.labels, []);
  assert.equal(
    state.creates.length,
    1,
    "settling neither kills nor replaces the tab",
  );
});

test("a milestone QA run opens the project main workspace when none is open on it", async (t) => {
  const root = scratch(t);
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  const { daemon, state } = fakeDaemon([]);
  let runs = [
    clientRun("qa-run-1", checkout, "qa:stage:rust", {
      submissionSource: "queue",
      caller: "queue:milestone-qa",
    }),
  ];
  const qa = qaRun("qa-run-1", "acme/app");
  const presence = presenceFor(root, daemon, {
    runs: () => runs,
    qaRun: (id) => (id === qa.id ? qa : null),
  });

  await presence.reconcile();
  assert.deepEqual(
    state.opened.map((entry) => entry.directory),
    [checkout],
    "the registered checkout is opened once",
  );
  assert.equal(state.creates.length, 1, "the run still gets its tab");
  assert.equal(state.creates[0]!.workspaceId, "workspace-opened-1");
  assert.equal(state.creates[0]!.cwd, checkout);
  assert.equal(state.creates[0]!.name, "QA · qa:stage:rust");
  assert.deepEqual(
    state.assignments,
    [
      {
        workspaceId: "workspace-opened-1",
        name: "QA running",
        assigned: true,
      },
    ],
    "the workspace it opened carries its own label",
  );
  assert.equal(
    state.workspaces[0]!.labels.includes("QA running"),
    true,
    "the opened workspace keeps the label",
  );

  await presence.reconcile();
  assert.equal(state.opened.length, 1, "the entry is reused, never opened twice");
  assert.equal(state.creates.length, 1, "one tab for one workspace and selector");

  runs = [];
  await presence.reconcile();
  assert.deepEqual(
    state.workspaces[0]!.labels,
    [],
    "settling clears the label on the workspace Queue opened",
  );
});

test("a refused workspace open is logged and retried, and never touches the run", async (t) => {
  const root = scratch(t);
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  const { daemon, state } = fakeDaemon([]);
  const run = clientRun("qa-run-1", checkout, "qa:stage:rust", {
    submissionSource: "queue",
  });
  const logged: string[] = [];
  const presence = new LiveRunPresence({
    dataDir: join(root, "data"),
    stateDir: join(root, "host-run"),
    runs: () => [run],
    settledRun: () => null,
    tasks: () => [],
    qaRun: () => qaRun("qa-run-1", "acme/app"),
    daemon: () => daemon,
    log: (message) => logged.push(message),
  });

  state.fail.openWorkspace = 1;
  await presence.reconcile();
  assert.equal(state.creates.length, 0, "no tab without a workspace");
  assert.ok(
    logged.some((message) =>
      message.includes("could not be opened"),
    ),
    `the refusal is logged: ${logged.join(" | ")}`,
  );
  assert.equal(run.state, "running", "the run is untouched");

  await presence.reconcile();
  assert.equal(state.creates.length, 1, "the next pass opens it and places the tab");
  assert.equal(run.state, "running", "a failed daemon call changes nothing about the run");
});

test("a milestone QA run uses the project main workspace, its own live log and QA running", async (t) => {
  const root = scratch(t);
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  const { daemon, state } = fakeDaemon([
    { id: "ws-main", directory: checkout, labels: [] },
  ]);
  let runs = [
    clientRun("qa-run-1", checkout, "qa:stage:rust", {
      submissionSource: "queue",
      caller: "queue:milestone-qa",
    }),
  ];
  let qa = qaRun("qa-run-1", "acme/app");
  const presence = presenceFor(root, daemon, {
    runs: () => runs,
    qaRun: (id) => (id === qa.id ? qa : null),
  });
  await presence.reconcile();

  assert.equal(state.creates.length, 1);
  assert.equal(state.creates[0]!.workspaceId, "ws-main");
  assert.equal(state.creates[0]!.cwd, checkout);
  assert.equal(state.creates[0]!.name, "QA · qa:stage:rust");
  const pointer = pointerOf(
    root,
    presence,
    `milestone_qa|${checkout}|qa:stage:rust`,
  );
  assert.deepEqual(pointer.outputs, [
    qaRunLiveOutputPath(
      qaRunRootPath(join(root, "data"), "acme/app"),
      "qa-run-1",
    ),
  ]);
  assert.deepEqual(state.assignments, [
    { workspaceId: "ws-main", name: "QA running", assigned: true },
  ]);

  // The QA row and its host run settle together, so the run leaves the live set.
  qa = qaRun("qa-run-1", "acme/app", {
    state: "passed",
    exitCode: 0,
    durationMs: 192_000,
  });
  runs = [];
  await presence.reconcile();
  assert.equal(
    pointerOf(root, presence, `milestone_qa|${checkout}|qa:stage:rust`)
      .settledLine,
    "QA · qa:stage:rust · passed (exit 0) in 3m 12s",
  );
  assert.deepEqual(state.assignments.at(-1), {
    workspaceId: "ws-main",
    name: "QA running",
    assigned: false,
  });
});

test("a task validation run follows the validation supervisor's own live log", async (t) => {
  const root = scratch(t);
  const directory = join(root, "worktree"),
    candidate = join(root, "isolation", "candidate");
  mkdirSync(directory, { recursive: true });
  const { daemon, state } = fakeDaemon([
    { id: "ws-task", directory, labels: [] },
  ]);
  const run = clientRun("validation-1", candidate, "qa:changed", {
    submissionSource: "queue",
    caller: "queue:validation:task-ws-task:head",
  });
  const task = taskAt(directory, "ws-task", {
    projectValidation: {
      hostRunId: "validation-1",
      state: "running",
      selector: "qa:changed",
      exitCode: null,
      durationMs: 0,
    },
  });
  const presence = presenceFor(root, daemon, {
    runs: () => [run],
    tasks: () => [task],
  });
  await presence.reconcile();
  const pointer = pointerOf(root, presence, `test|${directory}|qa:changed`);
  assert.deepEqual(pointer.outputs, [
    projectValidationSupervisorPaths(join(root, "data"), "validation-1")
      .liveOutputPath,
  ]);
  assert.equal(state.creates[0]!.name, "Testing · qa:changed");
});

test("a restart restores live runs and clears what settled while Queue was down", async (t) => {
  const root = scratch(t);
  const directory = join(root, "worktree"),
    checkout = join(root, "checkout");
  mkdirSync(directory, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  const workspaces: LiveRunPresenceWorkspace[] = [
    { id: "ws-task", directory, labels: ["Testing"] },
    { id: "ws-main", directory: checkout, labels: ["QA running"] },
  ];
  const { daemon, state } = fakeDaemon(workspaces);
  // Before this service started: one tab exists, and both labels are still on.
  state.terminals.push({
    id: "terminal-existing",
    name: "Testing · test unit",
    workspaceId: "ws-task",
    cwd: directory,
  });

  const settled = clientRun("run-old", directory, "test unit", {
    state: "settled",
    launchedAt: at(1_000),
    settlement: {
      format: "host.run.settlement",
      version: 1,
      runId: "run-old",
      outcome: "passed",
      launched: true,
      settledAt: at(11_000),
      result: {
        format: "host.run.result",
        version: 1,
        runId: "run-old",
        epoch: 1,
        pgid: 4,
        startIdentity: "identity",
        exitCode: 0,
        signal: null,
        startedAt: at(1_000),
        endedAt: at(11_000),
        wallMs: 10_000,
        cpuMs: 1,
        escapedDescendants: [],
      },
      containers: [],
    },
  });
  const live = clientRun("run-live", directory, "test unit", {
    submittedAt: at(20_000),
    launchedAt: at(21_000),
  });
  const presence = presenceFor(root, daemon, {
    runs: () => [live],
    tasks: () => [taskAt(directory, "ws-task")],
    settledRun: (id) => (id === settled.id ? settled : null),
  });
  // A pointer the previous service left behind for the run that has since settled.
  const stale = presence.pointerPath(`test|${directory}|test unit`);
  mkdirSync(join(root, "data", "run-terminal"), {
    recursive: true,
    mode: 0o700,
  });
  const abandoned = JSON.stringify({
    format: "queue.run-terminal",
    version: 1,
    key: `test|${directory}|test unit`,
    workspaceId: "ws-task",
    tabName: "Testing · test unit",
    sessionId: "run-old@" + at(1_000),
    runId: "run-old",
    outputs: [
      hostRunSupervisorPaths(join(root, "host-run"), "run-old").stdoutPath,
    ],
    settledLine: null,
    updatedAt: at(1_000),
  });
  writeFileSync(stale, abandoned);

  await presence.reconcile();

  assert.equal(
    state.creates.length,
    0,
    "the tab that already exists is reused, never duplicated",
  );
  assert.equal(
    pointerOf(root, presence, `test|${directory}|test unit`).runId,
    "run-live",
    "the live run takes the tab over",
  );
  assert.deepEqual(
    state.workspaces.find((workspace) => workspace.id === "ws-main")!.labels,
    [],
    "a milestone QA label whose run settled while Queue was down is cleared",
  );
  assert.deepEqual(
    state.assignments.filter(
      (assignment) => assignment.workspaceId === "ws-main",
    ),
    [{ workspaceId: "ws-main", name: "QA running", assigned: false }],
  );

  // Now the same restart with nothing live: the abandoned pointer still gets the run's own final line.
  const idle = presenceFor(root, daemon, {
    runs: () => [],
    settledRun: (id) => (id === settled.id ? settled : null),
  });
  writeFileSync(idle.pointerPath(`test|${directory}|test unit`), abandoned);
  await idle.reconcile();
  assert.equal(
    pointerOf(root, idle, `test|${directory}|test unit`).settledLine,
    "Testing · test unit · passed (exit 0) in 10s",
  );
});

test("a failed daemon call is logged and leaves the run alone", async (t) => {
  const root = scratch(t);
  const directory = join(root, "worktree");
  mkdirSync(directory, { recursive: true });
  const { daemon, state } = fakeDaemon([
    { id: "ws-task", directory, labels: [] },
  ]);
  const run = clientRun("run-1", directory);
  const logged: string[] = [];
  const presence = new LiveRunPresence({
    dataDir: join(root, "data"),
    stateDir: join(root, "host-run"),
    runs: () => [run],
    settledRun: () => null,
    tasks: () => [taskAt(directory, "ws-task")],
    qaRun: () => null,
    daemon: () => daemon,
    log: (message) => logged.push(message),
  });

  state.fail.workspaces = 1;
  await presence.reconcile();
  assert.equal(state.creates.length, 0, "no workspace inventory, no placement");
  assert.ok(
    logged.some((message) =>
      message.includes("workspace inventory is unavailable"),
    ),
  );

  state.fail.createTerminal = 1;
  await presence.reconcile();
  assert.equal(
    state.creates.length,
    0,
    "the refused open is not recorded as a tab",
  );
  assert.ok(logged.some((message) => message.includes("could not be opened")));
  assert.ok(
    existsSync(presence.pointerPath(`test|${directory}|test unit`)),
    "the pointer is written before the tab is opened",
  );

  state.fail.assign = 1;
  state.workspaces[0]!.labels = [];
  await presence.reconcile();
  assert.deepEqual(
    state.workspaces[0]!.labels,
    [],
    "the refused assignment is retried, not assumed",
  );
  await presence.reconcile();
  assert.equal(
    state.creates.length,
    1,
    "the next pass opens the tab it could not open before",
  );
  assert.deepEqual(state.workspaces[0]!.labels, ["Testing"]);
  assert.equal(run.state, "running", "nothing about the run changed");
});

test("an Electron follower gets node mode and an exited tab is not reopened for the same session", async (t) => {
  const root = scratch(t);
  const directory = join(root, "worktree");
  mkdirSync(directory, { recursive: true });
  const { daemon, state } = fakeDaemon([
    { id: "ws-task", directory, labels: [] },
  ]);
  let runs = [clientRun("run-electron", directory)];
  const logged: string[] = [];
  const presence = new LiveRunPresence({
    dataDir: join(root, "data"),
    stateDir: join(root, "host-run"),
    runs: () => runs,
    settledRun: () => null,
    tasks: () => [taskAt(directory, "ws-task")],
    qaRun: () => null,
    daemon: () => daemon,
    follower: {
      command:
        "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
      script: RUN_TERMINAL_FOLLOWER.script,
    },
    log: (message) => logged.push(message),
  });

  await presence.reconcile();
  assert.equal(state.creates.length, 1);
  assert.equal(state.creates[0]!.command, "/usr/bin/env");
  assert.deepEqual(state.creates[0]!.args.slice(0, 3), [
    "ELECTRON_RUN_AS_NODE=1",
    "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
    RUN_TERMINAL_FOLLOWER.script,
  ]);

  state.terminals = [];
  await presence.reconcile();
  await presence.reconcile();
  assert.equal(state.creates.length, 1, "a vanished follower is not recreated");
  assert.equal(
    logged.filter((message) =>
      message.includes("exited during run run-electron"),
    ).length,
    1,
    "the follower exit is logged once for this run session",
  );

  const nextRun = clientRun("run-electron-next", directory, "test unit", {
    submittedAt: at(20_000),
    launchedAt: at(21_000),
  });
  runs = [nextRun];
  await presence.reconcile();
  assert.equal(
    state.creates.length,
    2,
    "a later run session gets a follower attempt",
  );
});

test("a quiet service reads the daemon's inventory once, not on every pass", async (t) => {
  const root = scratch(t);
  const directory = join(root, "worktree");
  mkdirSync(directory, { recursive: true });
  const { daemon, state } = fakeDaemon([
    { id: "ws-task", directory, labels: [] },
  ]);
  let runs: HostRunInternalRecord[] = [];
  const presence = presenceFor(root, daemon, {
    runs: () => runs,
    tasks: () => [taskAt(directory, "ws-task")],
  });

  await presence.reconcile();
  await presence.reconcile();
  await presence.reconcile();
  assert.equal(
    state.workspaceReads,
    1,
    "an idle audit happens once, then nothing is asked",
  );

  runs = [clientRun("run-1", directory)];
  await presence.reconcile();
  assert.equal(
    state.creates.length,
    1,
    "a live run is still placed immediately",
  );
  await presence.reconcile();
  runs = [];
  await presence.reconcile();
  await presence.reconcile();
  assert.equal(
    state.workspaceReads,
    4,
    "the audit re-arms while a run is live, then quiets again after it settles",
  );
});

test("the service runtime projects its own live run set into a daemon that offers presence", async (t) => {
  const root = scratch(t);
  const dataDir = join(root, "data");
  const directory = join(root, "worktree");
  mkdirSync(directory, { recursive: true });
  const { daemon, state } = fakeDaemon([
    { id: "ws-task", directory, labels: [] },
  ]);
  const adapter = {
    client: { isConnected: true },
    hostId: "fixture-host",
    socketPath: join(dataDir, "callback.sock"),
    helperPath: join(dataDir, "worker-helper.mjs"),
    connect: async () => {},
    close: async () => {},
    profiles: async () => [],
    observe: observeIdle("ws", "worker"),
    liveRunPresence: daemon,
  } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir, adapterFactory: () => adapter, timers: false });
  t.after(() => runtime.stop());
  const presence = (
    runtime as unknown as { liveRunPresence: LiveRunPresence | null }
  ).liveRunPresence;
  assert.ok(presence, "the runtime wires the adapter's projection");

  const launched: string[] = [];
  const scheduler = runtime.hostRuns;
  scheduler.submit(
    {
      id: "run-1",
      epoch: 1,
      caller: "client:run-1",
      submissionSource: "client",
      repository: { origin: null, path: directory },
      selector: "test unit",
      runClass: "light",
      classSource: "default",
      priority: "interactive",
      runTimeoutMs: 60_000,
    },
    { launch: (run) => { scheduler.markLaunched(run.id); launched.push(run.id); } },
  );
  assert.deepEqual(launched, ["run-1"]);

  await presence.reconcile();
  assert.equal(state.creates.length, 1, "the live scheduler run opens one tab");
  assert.equal(state.creates[0]!.name, "Testing · test unit");
  assert.deepEqual(state.workspaces[0]!.labels, ["Testing"]);

  const launchedAt = scheduler.get("run-1")!.launchedAt!;
  const endedAt = new Date(Date.parse(launchedAt) + 12_000).toISOString();
  scheduler.settle(
    "run-1",
    hostRunSettlementSchema.parse({
      format: "host.run.settlement",
      version: 1,
      runId: "run-1",
      outcome: "passed",
      launched: true,
      settledAt: endedAt,
      result: {
        format: "host.run.result",
        version: 1,
        runId: "run-1",
        epoch: 1,
        pgid: 9000,
        startIdentity: "identity-run-1",
        exitCode: 0,
        signal: null,
        startedAt: launchedAt,
        endedAt,
        wallMs: 12_000,
        cpuMs: 100,
        escapedDescendants: [],
      },
      containers: [],
    }),
  );
  await presence.reconcile();
  assert.deepEqual(state.workspaces[0]!.labels, [], "the settled run clears its label");
  assert.equal(
    pointerOf(root, presence, `test|${directory}|test unit`).settledLine,
    "Testing · test unit · passed (exit 0) in 12s",
  );
});

test("only launched runs with a placed workspace become presence", () => {
  const root = mkdtempSync(join(tmpdir(), "queue-live-run-presence-targets-"));
  try {
    const directory = join(root, "worktree");
    const workspace = { id: "ws-task", directory, labels: [] };
    const queued = clientRun("queued", directory, "test unit", {
      state: "queued",
      launchedAt: null,
    });
    const overdue = clientRun("overdue", directory, "test unit", {
      submittedAt: at(-60 * 60_000),
      launchedAt: at(-50 * 60_000),
      runTimeoutMs: 60_000,
    });
    const unplaced = clientRun(
      "unplaced",
      join(root, "elsewhere"),
      "test unit",
    );
    const live = clientRun("live", directory, "test unit", {
      submittedAt: at(5_000),
    });
    const duplicate = clientRun("duplicate", directory, "test unit", {
      submittedAt: at(1_000),
    });
    const targets = liveRunPresenceTargets({
      runs: [queued, overdue, unplaced, live, duplicate],
      tasks: [taskAt(directory, "ws-task")],
      qaRun: () => null,
      workspaces: [workspace],
      dataDir: join(root, "data"),
      stateDir: join(root, "host-run"),
      nowMs: Date.parse(at(10_000)),
    });

    assert.equal(
      targets.length,
      1,
      "one tab per workspace and selector, and only for a launched, placed run",
    );
    assert.equal(
      targets[0]!.runId,
      "duplicate",
      "the oldest live run of that selector keeps the tab",
    );
    assert.equal(LIVE_RUN_PRESENCE_INTERVAL_MS > 0, true);

    // A milestone QA run whose registered checkout has no workspace yet still
    // becomes a target: Queue opens that workspace instead of going quiet.
    const checkout = join(root, "checkout");
    const qa = qaRun("qa-run-1", "acme/app");
    const qaTargets = liveRunPresenceTargets({
      runs: [clientRun("qa-run-1", checkout, "qa:stage:rust")],
      tasks: [],
      qaRun: (id) => (id === qa.id ? qa : null),
      workspaces: [workspace],
      dataDir: join(root, "data"),
      stateDir: join(root, "host-run"),
      nowMs: Date.parse(at(10_000)),
    });
    assert.equal(qaTargets.length, 1);
    assert.equal(qaTargets[0]!.workspaceId, null);
    assert.equal(qaTargets[0]!.openDirectory, checkout);
    assert.equal(qaTargets[0]!.cwd, checkout);
    assert.equal(qaTargets[0]!.key, `milestone_qa|${checkout}|qa:stage:rust`);

    // A task run whose workspace is gone is never served by opening a checkout:
    // the operator's task workspace is the only place it belongs.
    const taskTargets = liveRunPresenceTargets({
      runs: [clientRun("task-run", join(root, "elsewhere"))],
      tasks: [taskAt(directory, "ws-archived")],
      qaRun: () => null,
      workspaces: [workspace],
      dataDir: join(root, "data"),
      stateDir: join(root, "host-run"),
      nowMs: Date.parse(at(10_000)),
    });
    assert.deepEqual(taskTargets, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the tab's follower renders the live log and stops at the service's final line", async (t) => {
  const root = scratch(t);
  const pointerPath = join(root, "pointer.json");
  const logPath = join(root, "live.log");
  writeFileSync(logPath, "compiling\n");
  const pointer = (overrides: Partial<RunTerminalPointer> = {}) =>
    writeFileSync(
      pointerPath,
      JSON.stringify({
        format: "queue.run-terminal",
        version: 1,
        key: "test|ws|test unit",
        workspaceId: "ws",
        tabName: "Testing · test unit",
        sessionId: "run-1@" + at(1_000),
        runId: "run-1",
        outputs: [logPath],
        settledLine: null,
        updatedAt: at(1_000),
        ...overrides,
      }),
    );
  pointer();

  const child = spawn(
    process.execPath,
    [RUN_TERMINAL_FOLLOWER.script, pointerPath],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        QUEUE_RUN_TERMINAL_POLL_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    return predicate();
  };
  assert.ok(
    await waitFor(() => output.includes("compiling")),
    `the follower shows live output: ${output}`,
  );

  writeFileSync(logPath, "compiling\nlinking\n");
  assert.ok(
    await waitFor(() => output.includes("linking")),
    "the follower keeps following",
  );
  pointer({ settledLine: "Testing · test unit · passed (exit 0) in 12s" });
  assert.ok(
    await waitFor(() =>
      output.includes("Testing · test unit · passed (exit 0) in 12s"),
    ),
    `the tab keeps the final status line: ${output}`,
  );
  assert.ok(
    output.includes("following run-1"),
    "the tab names the run it follows",
  );
});
