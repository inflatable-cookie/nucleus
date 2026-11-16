import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { submissionSchema, type Profile, type Task } from "../shared/contracts";
import { ACCEPTED_PR_RECONCILIATION_REASON } from "../core/recovery/task-reasons";
import { AcceptedPrWorkspace, type AcceptedPrWorkspaceContext } from "../core/workspaces/workspace-continuation";

/**
 * The accepted-PR workspace reconciliation, at the boundary that decides it.
 *
 * The module was the second owner inside `workspace-continuation.ts`. These
 * witnesses pin what the split and the one shared decision must keep: a pass is
 * advanced exactly for the two parked states that can be answered, the operator's
 * request confirms an available workspace, a retained delivery recovers a lost
 * one, and a host that cannot look a registration up never reads as "none found".
 */

const head = "a".repeat(40), base = "b".repeat(40);
const profile: Profile = {
  id: "reviewer", name: "Reviewer", provider: "test", model: "test", notes: "",
  available: true, problem: "", supportedThinking: [],
};

interface Fixture {
  store: Store;
  task: Task;
  attention: string[];
  adapter: {
    workspaceAvailable?: (id: string) => Promise<boolean>;
    findWorkspaces?: (task: Task) => Promise<{ id: string; directory: string }[]>;
    recoverTaskWorkspace?: (task: Task) => Promise<{ id: string; directory: string }>;
    verifyPrIdentity?: (task: Task, number: number) => Promise<{ url: string; head: string }>;
  };
  workspace: AcceptedPrWorkspace;
}

function fixture(t: TestContext): Fixture {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const task = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: "Accepted PR", repoPath: "/repo", planningCommit: base,
    handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", base);
  const attention: string[] = [];
  const adapter: Fixture["adapter"] = { workspaceAvailable: async () => true };
  const context = {
    adapter, store, attention: (_task: Task, reason: string) => { attention.push(reason); },
    startsNoRuns: () => false,
  } as unknown as AcceptedPrWorkspaceContext;
  return { store, task, attention, adapter, workspace: new AcceptedPrWorkspace(context) };
}

/** The parked accepted PR: a ready completion and no live run. */
function parked(f: Fixture, fields: Partial<Task> = {}, resolution: Partial<Task["resolution"]> = {}): Task {
  return f.store.update(f.task.id, {
    phase: "needs_attention", workspaceId: "ws", directory: "/worktree", agentId: "worker", runId: "run-1", profile,
    prHead: head, prUrl: "https://github.com/example/repo/pull/1",
    completion: { taskId: f.task.id, runId: "run-1", eventId: "result", status: "ready_for_review", summary: "Ready", prNumber: 1 },
    resolution: { ...f.store.task(f.task.id).resolution, attention: true, currentRunId: null, ...resolution },
    ...fields,
  });
}

test("a pass is advanced for exactly the two parked states, and neither restates the other", (t) => {
  const f = fixture(t);

  // Nothing parked yet: neither a run nor an attention episode.
  assert.equal(f.workspace.acceptedPrWorkspaceMayApply(f.store.task(f.task.id)), false, "the submitted task is not parked");

  // A coordinator's request needs only the workspace identity.
  const requested = parked(f, { reason: ACCEPTED_PR_RECONCILIATION_REASON, directory: null, agentId: null, runId: null, profile: null });
  assert.equal(f.workspace.acceptedPrWorkspaceMayApply(requested), true);

  // Any other parked ready PR needs the full retained identity to be recoverable.
  const retained = parked(f, { reason: "Stopped reviewer thread needs attention" });
  assert.equal(f.workspace.acceptedPrWorkspaceMayApply(retained), true);
  const partial = parked(f, { reason: "Stopped reviewer thread needs attention", profile: null });
  assert.equal(f.workspace.acceptedPrWorkspaceMayApply(partial), false, "a partial retained identity is not recoverable");

  // A host without the availability probe is never a pass.
  f.adapter.workspaceAvailable = undefined;
  assert.equal(f.workspace.acceptedPrWorkspaceMayApply(parked(f, { reason: ACCEPTED_PR_RECONCILIATION_REASON })), false);
});

test("an operator request confirms an available workspace and ends the recovery episode", async (t) => {
  const f = fixture(t);
  const task = parked(f, { reason: ACCEPTED_PR_RECONCILIATION_REASON });
  const confirmed = await f.workspace.reconcileAcceptedPrWorkspace(task);
  assert.equal(confirmed!.phase, "awaiting_review");
  assert.equal(confirmed!.reason, "Retained task workspace confirmed; awaiting independent review");
  assert.equal(confirmed!.resolution.attention, false, "the episode that parked it is over");
  assert.equal(confirmed!.resolution.recovery, null, "a reconciliation without a recovery record records none");
  assert.equal(confirmed!.resolution.integrationTurn, null);
  assert.deepEqual(f.attention, [], "a confirmed workspace raises nothing");
});

test("a retained delivery whose workspace is gone recovers a checkout and retires the old run", async (t) => {
  const f = fixture(t);
  f.adapter.workspaceAvailable = async () => false;
  const recovered: string[] = [];
  f.adapter.findWorkspaces = async () => { recovered.push("find"); return []; };
  f.adapter.recoverTaskWorkspace = async () => { recovered.push("recover"); return { id: "ws-recovered", directory: "/recovered" }; };
  const task = parked(f, { reason: "Stopped reviewer thread needs attention" });

  const after = await f.workspace.reconcileAcceptedPrWorkspace(task);
  assert.deepEqual(recovered, ["find", "recover"], "the lookup is asked before a replacement is created");
  assert.equal(after!.workspaceId, "ws-recovered");
  assert.equal(after!.directory, "/recovered");
  assert.equal(after!.runId, null);
  assert.equal(after!.retiredWorkers.length, 1, "the run that held the lost workspace is retained as history");
  assert.equal(after!.retiredWorkers[0]!.reason, "Accepted delivery preserved after the original task workspace was removed");
  assert.equal(after!.phase, "awaiting_review");
});

test("a host that cannot look a registration up is attention, never a fresh registration", async (t) => {
  const f = fixture(t);
  f.adapter.workspaceAvailable = async () => false;
  f.adapter.findWorkspaces = undefined;
  let recovered = 0;
  f.adapter.recoverTaskWorkspace = async () => { recovered++; return { id: "ws-new", directory: "/new" }; };
  const task = parked(f, { reason: "Stopped reviewer thread needs attention" });

  assert.equal(await f.workspace.reconcileAcceptedPrWorkspace(task), null, "the pass stops instead of guessing");
  assert.equal(recovered, 0, "no second registration is created for one folder");
  assert.deepEqual(f.attention, ["The task workspace is unavailable and this host cannot look up its registration; inspect the workspace before retrying"]);
  assert.equal(f.store.task(f.task.id).workspaceId, "ws", "the task keeps the workspace it recorded");
});

test("an ambiguous lookup and a missing recovery seam keep their refusals", async (t) => {
  const f = fixture(t);
  f.adapter.workspaceAvailable = async () => false;
  f.adapter.recoverTaskWorkspace = async () => ({ id: "ws-new", directory: "/new" });
  f.adapter.findWorkspaces = async () => [{ id: "one", directory: "/one" }, { id: "two", directory: "/two" }];
  assert.equal(await f.workspace.reconcileAcceptedPrWorkspace(parked(f, { reason: "Needs attention" })), null);
  assert.deepEqual(f.attention, ["Task workspace recovery is ambiguous; no resource was selected"]);

  f.attention.length = 0;
  f.adapter.findWorkspaces = async () => [];
  f.adapter.recoverTaskWorkspace = undefined;
  assert.equal(await f.workspace.reconcileAcceptedPrWorkspace(parked(f, { reason: "Needs attention" })), null);
  assert.deepEqual(f.attention, ["Accepted PR is preserved but the task workspace is unavailable; workspace recovery is unsupported"],
    "a host with no recovery seam is named, not left with a recovery that cannot happen");
});
