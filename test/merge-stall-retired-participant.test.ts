/**
 * A merge that meets a retired or replaced native participant owns it: the
 * participant's own work ticket keeps the run root it was started under, so the
 * ordinary owned-tool proof can scan it and clear, or refuse for a fact only its
 * owner can settle — and then the owner hears about it exactly once.
 *
 * The stored shapes are the ones a worker replacement leaves: `task.runId` and the
 * task's recorded leaf belong to the worker holding the task now, while the
 * retired worker record names the ticket it displaced with no run row of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import { submissionSchema, type Run, type Task } from "../shared/contracts";
import type { Adapter, AgentObservation } from "../core/host/adapter";
import { OwnedTools } from "../core/machine/owned-tool";
import type { Resolution } from "../core/resolution";
import type { HostProcessFact, TimelinePage } from "../core/host/types";
import { workspaceToolProcessIssue } from "../core/recovery/stall";
import { toolTimelinePage } from "./support/tool-timeline";
import { runTemporaryDirectory } from "../core/workspaces/run-scratch";
import { participantTemporaryDirectory } from "../core/machine/participant-roots";
import { noticeId } from "../core/questions/origin";

const base = "b".repeat(40);

function scratch(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-merge-retired-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function processAt(cwd: string, pid = 42): HostProcessFact {
  return {
    pid,
    ppid: 1,
    pgid: pid,
    uid: 501,
    startIdentity: "synthetic-start",
    command: "synthetic-detached-command",
    cwd,
  };
}

/**
 * The proof's fixture: one task whose recorded leaf belongs to its current worker
 * ticket and one retired worker ticket with no run row, exactly as a replacement
 * leaves them. Nothing here is written to a real checkout.
 */
function proofFixture(t: { after(fn: () => void): void }, root: string) {
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const scratchRoot = join(root, "scratch", "nucleus");
  const ticket = "current-worker-ticket",
    retiredTicket = "retired-worker-ticket";
  const task = {
    id: "synthetic-task",
    agentId: "synthetic-agent",
    workspaceId: "synthetic-workspace",
    runId: ticket,
    directory: workspace,
    temporaryDirectory: runTemporaryDirectory(ticket, scratchRoot),
    hostId: "host-a",
    retiredWorkers: [
      {
        agentId: "retired-agent",
        runId: retiredTicket,
        profile: null,
        reason: "replacement",
        hostId: "host-a",
      },
    ],
    resolution: { ownerSettlements: [] as unknown[] },
  } as unknown as Task;
  // The revision run a replacement also leaves: it names the same retired agent
  // and keeps its own recorded leaf, while the displaced ticket has no run row.
  const revisionRun = {
    id: "retired-revision-run",
    taskId: task.id,
    role: "revision",
    agentId: "retired-agent",
    workspaceId: "synthetic-workspace",
    hostId: "host-a",
    released: true,
    status: "superseded",
    temporaryDirectory: runTemporaryDirectory(
      "retired-revision-run",
      scratchRoot,
    ),
  } as unknown as Run;
  const runs: Run[] = [revisionRun];
  let processes: HostProcessFact[] | null = [];
  const observation: AgentObservation = {
    id: task.agentId!,
    workspaceId: task.workspaceId!,
    status: "idle",
    active: false,
    activeTurnId: null,
    permissions: false,
    error: "",
  };
  const adapter = {
    agentTimelinePage: async (): Promise<TimelinePage> =>
      toolTimelinePage([], {
        projection: "bounded",
        pendingBackgroundTasks: [],
      }),
    hostProcessListing: async () => processes,
    noLiveWorkspaceProcesses: async (
      _workspace: string,
      runIds: readonly string[],
    ) =>
      processes
        ? workspaceToolProcessIssue(processes, workspace, runIds)
        : "host process listing is unreadable",
  };
  const resolution = {
    adapter,
    host: {
      agentTimelinePage: adapter.agentTimelinePage,
      observe: async (id: string) => ({ ...observation, id }),
    },
    store: {
      task: () => task,
      run: (id: string) => runs.find((run) => run.id === id) ?? null,
      runs: () => runs,
      eventsAll: () => [],
      event: () => {},
    },
  } as unknown as Resolution;
  return {
    task,
    runs,
    adapter,
    scratchRoot,
    retiredTicket,
    retiredLeaf: runTemporaryDirectory(retiredTicket, scratchRoot),
    tools: new OwnedTools(resolution),
    setProcesses: (value: HostProcessFact[] | null) => {
      processes = value;
    },
    retiredRevisionRun: revisionRun.id,
    retiredRevisionLeaf: revisionRun.temporaryDirectory!,
    proof: async (
      agentId: string,
      runIds: string[],
    ): Promise<string | null> => {
      const result = await new OwnedTools(resolution).ownedToolHold(agentId, {
        requireCompleteEvidence: true,
        runId: runIds[0],
        runIds,
        taskId: task.id,
        workspaceId: task.workspaceId!,
      });
      return result.kind === "clear" ? null : result.reason;
    },
  };
}

test("a retired worker ticket keeps the run root its own identity names", (t) => {
  const root = scratch(t);
  const f = proofFixture(t, root);
  assert.equal(
    participantTemporaryDirectory(f.task, [], f.retiredTicket),
    f.retiredLeaf,
    "the displaced ticket is rooted beside the recorded leaf, as the launcher named it",
  );
  assert.equal(
    participantTemporaryDirectory(f.task, [], f.task.runId!),
    f.task.temporaryDirectory,
    "the retained worker keeps the task leaf",
  );
  assert.equal(
    participantTemporaryDirectory(
      {
        ...f.task,
        retiredWorkers: [{ ...f.task.retiredWorkers[0]!, hostId: "host-b" }],
      },
      [],
      f.retiredTicket,
    ),
    undefined,
    "another host's ticket never borrows this host's root",
  );
});

test("a retired native participant reconciles through its own root and positively proves quiescence", async (t) => {
  const root = scratch(t);
  const f = proofFixture(t, root);
  // The live shape: the participant's revision run is the bound run and the
  // displaced ticket rides beside it, exactly as `participantToolRunIds` orders
  // them for a retired worker.
  const participantRuns = [f.retiredRevisionRun, f.retiredTicket];
  assert.equal(
    await f.proof("retired-agent", participantRuns),
    null,
    "a clear host table and the retired ticket's own root prove quiescence",
  );
  for (const [label, leaf] of [
    ["revision root", f.retiredRevisionLeaf],
    ["retired ticket root", f.retiredLeaf],
  ] as const) {
    f.setProcesses([processAt(join(leaf, "job"))]);
    assert.match(
      (await f.proof("retired-agent", participantRuns))!,
      /process 42 remains in the task workspace process tree/,
      `a process living in the ${label} still holds the proof`,
    );
  }
  f.setProcesses(null);
  assert.match(
    (await f.proof("retired-agent", participantRuns))!,
    /unreadable/,
    "an unreadable host table is never read as clear",
  );
  // A ticket this task never recorded and a recorded leaf in no shape Queue
  // writes keep the ordinary refusal: the proof does not invent a root.
  f.setProcesses([]);
  assert.match(
    (await f.proof("retired-agent", ["ticket-this-task-never-recorded"]))!,
    /temporary directory is unrecorded/,
  );
  f.task.temporaryDirectory = join(root, "shared-legacy-root");
  assert.match(
    (await f.proof("retired-agent", participantRuns))!,
    /temporary directory is unrecorded/,
  );
});

/**
 * The merge lease's own fixture: one idle participant in one task, with the
 * owned-tool proof stubbed so the test can choose what it refuses for.
 */
async function leaseFixture(
  t: { after(fn: () => void): void },
  options: { graceMs: number; holdRefusal: string },
) {
  const root = scratch(t);
  const directory = join(root, "worktree");
  mkdirSync(directory);
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  const task = store.insert(
    submissionSchema.parse({
      submissionId: "merge-lease",
      title: "Merge lease",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "h.md",
      originAgentId: "origin",
    }),
    "host",
    "h.md",
    base,
    { originHostId: "host", originWorkspaceId: "origin-workspace" },
  );
  store.update(task.id, {
    phase: "verifying",
    reason: "Mechanical verification satisfied the merge gates",
    workspaceId: "workspace",
    directory,
    agentId: "worker-agent",
    runId: "worker-ticket",
    temporaryDirectory: join(root, "worker-scratch"),
    agentActive: false,
    lastAgentStatus: "idle",
  });
  const adapter = {
    observe: async (id: string) => ({
      id,
      workspaceId: "workspace",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
    }),
    hostProcessListing: async () => [],
    notify: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, options.graceMs);
  t.after(() => engine.stop());
  engine.resolution.ownedToolHold = async () => ({
    kind: "hold",
    reason: options.holdRefusal,
  });
  return { store, engine, taskId: task.id, current: () => store.task(task.id) };
}

test("a participant hold the merge cannot settle is the owner's, and its notice arrives once", async (t) => {
  const f = await leaseFixture(t, {
    graceMs: 0,
    holdRefusal:
      "owned tool process proof did not clear: a participant run temporary directory is unrecorded",
  });
  f.store.event(
    f.taskId,
    "owned_tool_hold",
    JSON.stringify({ runId: "worker-ticket", reason: "stray" }),
  );
  assert.equal(await f.engine.resolution.executionLease(f.current()), false);
  const stop = f.current().resolution.stop!;
  assert.equal(
    stop.reason,
    "operator_needed",
    "the unreachable proof is not a wait that clears by itself",
  );
  assert.deepEqual(stop.suggestedVerbs, ["retry_effect"]);
  assert.match(
    stop.detail,
    /Merge waits for participant worker-agent: owned tool process proof did not clear/,
  );
});

test("a participant hold inside its grace is a timed wait the next pass re-reads", async (t) => {
  const f = await leaseFixture(t, {
    graceMs: 60_000,
    holdRefusal:
      "an owned tool is still live: observed tool Bash (shell) is running",
  });
  f.store.event(
    f.taskId,
    "owned_tool_hold",
    JSON.stringify({ runId: "worker-ticket", reason: "stray" }),
  );
  assert.equal(await f.engine.resolution.executionLease(f.current()), false);
  assert.equal(f.current().resolution.stop!.reason, "lifecycle");
  assert.match(f.current().reason, /stray-tool grace ends at/);
});

/**
 * The notice fixture: one open task whose owner is a live origin thread on its
 * own host, so delivery goes through the ordinary durable notice path.
 */
function noticeFixture(t: { after(fn: () => void): void }) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  const messages: Array<{ agentId: string; messageId: string }> = [];
  const adapter = {
    supportsCoordinatorRecovery: true,
    observe: async (id: string) => ({
      id,
      workspaceId: id === "origin" ? "origin-workspace" : "workspace",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
    }),
    notify: async (agentId: string, messageId: string) => {
      messages.push({ agentId, messageId });
    },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  t.after(() => engine.stop());
  engine.identifyOriginHost = async () => "host";
  engine.hostAvailable = () => true;
  const task = store.insert(
    submissionSchema.parse({
      submissionId: "notice-task",
      title: "Notice task",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "h.md",
      originAgentId: "origin",
    }),
    "host",
    "h.md",
    base,
    { originHostId: "host", originWorkspaceId: "origin-workspace" },
  );
  store.update(task.id, {
    phase: "merging",
    reason: "Merge requested for the reviewed head",
    workspaceId: "workspace",
    directory: "/worktree",
    agentId: "worker-agent",
    runId: "worker-ticket",
  });
  const current = () => store.task(task.id);
  return { store, engine, taskId: task.id, current, messages };
}

test("an owner-blocked merge wait is delivered once and survives ordinary rechecks", async (t) => {
  const f = noticeFixture(t);
  const detail =
    "Merge waits for participant retired-agent: owned tool process proof did not clear: a participant run temporary directory is unrecorded";
  f.engine.resolution.waiting(f.current(), detail, "operator_needed", {
    suggestedVerbs: ["retry_effect"],
  });
  const id = noticeId(f.current());
  await f.engine.resolution.deliverNotices();
  const first = f.store.notices(f.taskId);
  assert.deepEqual(
    first.map((notice) => [notice.id, notice.status]),
    [[id, "delivered"]],
  );
  assert.deepEqual(f.messages, [{ agentId: "origin", messageId: id }]);
  assert.match(first[0]!.text, /retry_effect/);
  await f.engine.resolution.deliverNotices();
  await f.engine.resolution.deliverNotices();
  assert.equal(
    f.messages.length,
    1,
    "ordinary rechecks never send the same episode twice",
  );
  assert.equal(f.store.notices(f.taskId).length, 1);
});

test("a pending notice survives the merge wait while the stop is the owner's", async (t) => {
  const f = noticeFixture(t);
  f.engine.resolution.waiting(
    f.current(),
    "Merge waits for participant retired-agent: a participant run temporary directory is unrecorded",
    "operator_needed",
    { suggestedVerbs: ["retry_effect"] },
  );
  f.store.putNotice({
    id: noticeId(f.current()),
    taskId: f.taskId,
    agentId: "origin",
    recipientAgentId: "origin",
    workspaceId: "origin-workspace",
    sources: [],
    originEntry: true,
    kind: "attention",
    status: "pending",
    error: "",
    text: "Nucleus needs attention",
  });
  await f.engine.resolution.deliverNotices();
  assert.equal(f.store.notices(f.taskId)[0]!.status, "delivered");
  assert.deepEqual(f.messages, [
    { agentId: "origin", messageId: noticeId(f.current()) },
  ]);
});

test("a transient wait supersedes its notice with the reason, and a later block is a new episode", async (t) => {
  const f = noticeFixture(t);
  f.engine.resolution.waiting(
    f.current(),
    "Merge waits for participant worker-agent: Assigned thread is active (running)",
    "lifecycle",
  );
  const transient = noticeId(f.current());
  f.store.putNotice({
    id: transient,
    taskId: f.taskId,
    agentId: "origin",
    recipientAgentId: "origin",
    workspaceId: "origin-workspace",
    sources: [],
    originEntry: true,
    kind: "attention",
    status: "pending",
    error: "",
    text: "Nucleus needs attention",
  });
  await f.engine.resolution.deliverNotices();
  const settled = f.store.notices(f.taskId)[0]!;
  assert.equal(settled.status, "superseded");
  assert.equal(
    settled.error,
    "The task waits on a condition that clears on its own; no owner action is owed",
  );
  assert.deepEqual(
    f.messages,
    [],
    "a conclusively transient wait recovers quietly",
  );
  // The same task's genuine blocker afterwards is a new episode with its own notice.
  f.engine.resolution.waiting(
    f.current(),
    "Merge waits for participant worker-agent: owned tool process proof did not clear: a participant run temporary directory is unrecorded",
    "operator_needed",
    { suggestedVerbs: ["retry_effect"] },
  );
  assert.notEqual(noticeId(f.current()), transient);
  await f.engine.resolution.deliverNotices();
  assert.equal(f.messages.length, 1);
  assert.equal(f.store.notices(f.taskId).length, 2);
});
