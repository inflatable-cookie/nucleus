import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnedTools } from "../core/machine/owned-tool";
import type { Resolution } from "../core/resolution";
import type { AgentObservation } from "../core/host";
import type { HostProcessFact, TimelinePage } from "../core/host/types";
import { workspaceToolProcessIssue } from "../core/recovery/stall";
import { toolTimelinePage } from "./support/tool-timeline";
import { bbProcessFixture } from "./support/bb-process-fixture";

function fixture(t: TestContext, bb = false) {
  const root = mkdtempSync(join(tmpdir(), "bounded-tool-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "workspace"),
    temporaryDirectory = join(root, "run-scratch");
  const task = {
    id: "synthetic-task",
    agentId: "synthetic-agent",
    workspaceId: "synthetic-workspace",
    runId: "synthetic-run",
    directory,
    temporaryDirectory,
    hostId: bb ? "bb:fixture" : "paseo-fixture",
    resolution: { ownerSettlements: [] },
  };
  let observation: Partial<AgentObservation> | null = {
    id: task.agentId,
    workspaceId: task.workspaceId,
    status: "idle",
    active: false,
    activeTurnId: null,
    permissions: false,
    error: "",
  };
  let processes: HostProcessFact[] | null = [];
  let runs: Array<{
    id: string;
    taskId: string;
    workspaceId: string;
    agentId: string;
    role: string;
    hostId: string;
  }> = [];
  let page: TimelinePage | null = toolTimelinePage([], {
    projection: "bounded",
    hasOlder: true,
    pendingBackgroundTasks: [],
  });
  const adapter = {
    agentTimelinePage: async () => page,
    hostProcessListing: async () => processes,
    noLiveWorkspaceProcesses: async (
      _workspace: string,
      _runs: readonly string[],
      threads: readonly string[] = [],
    ) =>
      processes
        ? workspaceToolProcessIssue(processes, directory, [task.runId], threads)
        : "host process listing is unreadable",
  };
  const resolution = {
    adapter,
    host: {
      agentTimelinePage: adapter.agentTimelinePage,
      observe: async () => observation,
    },
    store: {
      task: () => task,
      run: () => null,
      runs: () => runs,
      eventsAll: () => [],
      event: () => {},
    },
  } as unknown as Resolution;
  const tools = new OwnedTools(resolution);
  const proof = () =>
    tools.ownedToolHold(task.agentId, {
      taskId: task.id,
      runId: task.runId,
      workspaceId: task.workspaceId,
      requireCompleteEvidence: true,
    });
  const processAt = (cwd: string): HostProcessFact => ({
    pid: 42,
    ppid: 1,
    pgid: 42,
    uid: 501,
    startIdentity: "synthetic-start",
    command: "synthetic-detached-command",
    cwd,
  });
  return {
    task,
    proof,
    processAt,
    state: () => observation!,
    setState: (value: Partial<AgentObservation> | null) => {
      observation = value;
    },
    setProcesses: (value: HostProcessFact[] | null) => {
      processes = value;
    },
    setRuns: (value: typeof runs) => {
      runs = value;
    },
    setPage: (value: TimelinePage | null) => {
      page = value;
    },
    page: () => page!,
  };
}

test("BB bridge and session are bound runtime, while their commands and unknown identities hold", async (t) => {
  const f = fixture(t, true);
  const facts = await bbProcessFixture(f.task.directory, f.task.agentId);
  f.setProcesses(facts);
  assert.equal(await f.proof(), null);
  f.setProcesses([
    ...facts,
    { ...facts[2]!, pid: 104, ppid: 102, command: "node build.mjs" },
  ]);
  assert.match((await f.proof())!, /process 104 remains/);
  f.setProcesses([
    ...facts,
    {
      ...facts[2]!,
      pid: 105,
      ppid: 103,
      command: "sh -c build",
      cwd: "/elsewhere",
    },
  ]);
  assert.match((await f.proof())!, /process 105 remains/);
  for (const thread of ["other-thread", null]) {
    f.setProcesses(await bbProcessFixture(f.task.directory, thread));
    assert.match((await f.proof())!, /process 101 remains/);
  }
});

test("both BB participants in a shared workspace are runtime, but either session can run work", async (t) => {
  const f = fixture(t, true);
  f.setRuns([
    {
      id: "review-run",
      taskId: f.task.id,
      workspaceId: f.task.workspaceId,
      agentId: "reviewer",
      role: "reviewer",
      hostId: f.task.hostId,
    },
  ]);
  const worker = await bbProcessFixture(f.task.directory, f.task.agentId);
  const reviewer = (await bbProcessFixture(f.task.directory, "reviewer")).map(
    (fact) => ({
      ...fact,
      pid: fact.pid + 1000,
      ppid: fact.ppid === 1 ? 1 : fact.ppid! + 1000,
    }),
  );
  f.setProcesses([...worker, ...reviewer]);
  assert.equal(await f.proof(), null);
  for (const parent of [102, 1102]) {
    f.setProcesses([
      ...worker,
      ...reviewer,
      { ...worker[2]!, pid: 3000, ppid: parent, command: "node build.mjs" },
    ]);
    assert.match((await f.proof())!, /process 3000 remains/);
  }
});

test("bounded tools clear only with idle observation, a clear newest window and no owned processes", async (t) => {
  const f = fixture(t);
  assert.equal(
    await f.proof(),
    null,
    "older history does not prevent three positive signals clearing",
  );
});

test("an active run or pending runtime request holds even when the bounded window is empty", async (t) => {
  const f = fixture(t);
  f.setState({
    ...f.state(),
    active: true,
    activeTurnId: "synthetic-turn",
    status: "running",
  });
  assert.match((await f.proof())!, /active run or pending runtime request/);
  f.setState({
    ...f.state(),
    active: false,
    activeTurnId: null,
    status: "idle",
    permissions: true,
  });
  assert.match((await f.proof())!, /active run or pending runtime request/);
});

test("a live native tool or retained provider background task holds despite a finished parent and empty process table", async (t) => {
  const f = fixture(t);
  f.setPage(
    toolTimelinePage(
      [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          item: {
            type: "tool_call",
            callId: "synthetic-call",
            name: "file_change",
            status: "running",
            detail: { type: "edit" },
          },
        },
      ],
      { projection: "bounded", pendingBackgroundTasks: [] },
    ),
  );
  assert.match((await f.proof())!, /owned tool is still live/);
  f.setPage(
    toolTimelinePage([], {
      projection: "bounded",
      pendingBackgroundTasks: ["subagent synthetic-child"],
    }),
  );
  assert.match(
    (await f.proof())!,
    /outstanding background work: subagent synthetic-child/,
  );
});

test("an older detached command in either the workspace or run TMPDIR holds with no visible tool row", async (t) => {
  const f = fixture(t);
  for (const root of [f.task.directory, f.task.temporaryDirectory]) {
    f.setProcesses([f.processAt(join(root, "child"))]);
    assert.match(
      (await f.proof())!,
      /process 42 remains in the task workspace process tree/,
    );
  }
  f.setProcesses([]);
  assert.equal(await f.proof(), null);
});

test("any unknown bounded signal is inconclusive", async (t) => {
  const f = fixture(t);
  f.setState(null);
  assert.match((await f.proof())!, /inconclusive/);
  f.setState({
    id: "synthetic-other-agent",
    workspaceId: f.task.workspaceId,
    status: "idle",
    active: false,
    activeTurnId: null,
    permissions: false,
  });
  assert.match((await f.proof())!, /identity is unavailable/);
  f.setState({
    id: f.task.agentId,
    workspaceId: f.task.workspaceId,
    status: "idle",
    active: false,
    permissions: false,
  });
  assert.match((await f.proof())!, /inactivity is unproven/);
  f.setState({ ...f.state(), activeTurnId: null });
  f.setProcesses(null);
  assert.match((await f.proof())!, /unreadable/);
  f.setProcesses([
    { ...f.processAt(f.task.directory), pid: 7 },
    { ...f.processAt("/synthetic/unrelated"), pid: 8, ppid: 7, cwd: null },
  ]);
  assert.match((await f.proof())!, /unreadable working directory/);
  f.setProcesses([
    { ...f.processAt("/synthetic/unrelated"), pid: 8, cwd: null },
  ]);
  assert.equal(
    await f.proof(),
    null,
    "an unreadable process with a known unrelated parent is ignored",
  );
  f.setProcesses([]);
  const saved = f.page();
  f.setPage(
    toolTimelinePage(
      [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          item: {
            type: "tool_call",
            name: "synthetic-tool",
            status: "running",
          },
        },
      ],
      { projection: "bounded", pendingBackgroundTasks: [] },
    ),
  );
  assert.match((await f.proof())!, /inconclusive.*incomplete identity/);
  f.setPage(
    toolTimelinePage(
      [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          item: {
            type: "tool_call",
            callId: "synthetic-call",
            name: "synthetic-tool",
            status: "future-state",
          },
        },
      ],
      { projection: "bounded", pendingBackgroundTasks: [] },
    ),
  );
  assert.match((await f.proof())!, /inconclusive/);
  f.setPage(null);
  assert.match((await f.proof())!, /inconclusive/);
  f.setPage({ ...saved, pendingBackgroundTasks: undefined });
  assert.match((await f.proof())!, /lack pending-background-task evidence/);
  f.setPage(saved);
  f.task.temporaryDirectory = "";
  assert.match((await f.proof())!, /temporary directory is unrecorded/);
});
