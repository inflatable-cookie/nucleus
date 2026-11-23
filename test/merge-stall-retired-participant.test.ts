import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import { submissionSchema, type Task } from "../shared/contracts";
import type { Adapter } from "../core/host/adapter";
import { runTemporaryDirectory } from "../core/workspaces/run-scratch";
import { participantTemporaryDirectory } from "../core/machine/participant-roots";
import { noticeId } from "../core/questions/origin";

const base = "b".repeat(40);

function scratch(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-merge-retired-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a retired worker ticket keeps the run root its own identity names", (t) => {
  const root = scratch(t);
  const runId = "current-worker-ticket";
  const retiredTicket = "retired-worker-ticket";
  const task = {
    runId,
    hostId: "host-a",
    temporaryDirectory: runTemporaryDirectory(runId, root),
    retiredWorkers: [{ agentId: "retired-agent", runId: retiredTicket, hostId: "host-a" }],
  } as Task;
  assert.equal(
    participantTemporaryDirectory(task, [], retiredTicket),
    runTemporaryDirectory(retiredTicket, root),
    "the displaced ticket is rooted beside the recorded leaf, as the launcher named it",
  );
  assert.equal(
    participantTemporaryDirectory(task, [], task.runId!),
    task.temporaryDirectory,
    "the retained worker keeps the task leaf",
  );
  assert.equal(
    participantTemporaryDirectory(
      {
        ...task,
        retiredWorkers: [{ ...task.retiredWorkers[0]!, hostId: "host-b" }],
      },
      [],
      retiredTicket,
    ),
    undefined,
    "another host's ticket never borrows this host's root",
  );
});

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
