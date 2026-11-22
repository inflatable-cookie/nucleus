import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import type { Adapter } from "../core/host";
import { formatAgentId } from "../shared/agent-identity";
import { submissionSchema, type Task } from "../shared/contracts";
import { explicitResolutionSchema } from "../shared/schema/task-control";
import { livePlannerMatches, resolveExplicitly } from "../core/verbs/explicit-resolution";
import { forceCallerRefusal } from "../core/verbs/verb-refusal-text";

// Planner authority comes from the registered thread and the caller's identity.
// Host observation only decides delivery, so an unverified registered planner
// keeps its authority and an unregistered caller is still refused.

const repo = "/synthetic/example";
const base = "b".repeat(40);
const host = "paseo-synthetic";
const planner = formatAgentId(host, "own");
const stranger = formatAgentId(host, "other");

function fixture() {
  const store = new Store(":memory:");
  const adapter = {
    hostId: host,
    listLiveAgents: async () => [
      { id: "own", title: "own", workspaceId: null, directory: repo, updatedAt: "2098-01-01T00:00:00Z" },
      { id: "other", title: "other", workspaceId: null, directory: repo, updatedAt: "2099-01-02T00:00:00Z" },
    ],
    originAgent: async (id: string) => ({ id, title: id, workspaceId: null, archived: false }),
    observe: async (id: string) => ({ id, workspaceId: null, status: "idle", active: false, permissions: false, error: "", archived: false }),
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.identifyOriginHost = async () => host;
  // The registered planner's host is not yet proven after a roll: unverified, never gone.
  engine.resolution.plannerPresence.threadRoute = async (id) =>
    id === planner
      ? { kind: "unverified", detail: "waiting for the planner's proven host to be available" }
      : { kind: "routable" };
  store.upsertProject({ key: "example", name: "Example", repositories: [{ origin: null, path: repo }] });
  store.setProjectPlanner({ key: "example", agentId: planner, setBy: "operator" });
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: "authority-fixture",
      title: "Authority",
      repoPath: repo,
      planningCommit: base,
      brief: { text: "Authority brief" },
      originAgentId: "own",
    }),
    host,
    "brief",
    base,
  );
  store.update(inserted.id, { phase: "awaiting_review" });
  const task = (): Task => store.task(inserted.id);
  const command = (fields: Record<string, unknown>) =>
    resolveExplicitly(
      engine,
      explicitResolutionSchema.parse({
        action: "phase.set",
        taskId: inserted.id,
        version: task().version,
        to: "reviewing",
        reason: "Authority check",
        ...fields,
      }),
      () => "next",
    );
  return { store, engine, task, command };
}

test("an authenticated registered planner keeps authority while its host observation is unverified", async () => {
  const f = fixture();
  try {
    const observed = await f.engine.resolution.responsibleThread(f.store.projectByKey("example")!);
    assert.equal(observed.thread?.agentId, planner);
    assert.equal(observed.shortlist[0]?.observation?.state, "unverified");

    assert.equal(await livePlannerMatches(f.engine, f.task(), planner), true);
    assert.equal(await f.engine.forceCallerAuthorized(f.task(), planner), true);

    const applied = await f.command({ caller: planner });
    assert.equal(applied.explicitResolution?.status, "applied");
    assert.equal(f.task().phase, "reviewing");
  } finally {
    f.store.close();
  }
});

test("an unregistered or unauthenticated caller is refused, and the refusal names why", async () => {
  const f = fixture();
  try {
    assert.equal(await livePlannerMatches(f.engine, f.task(), stranger), false);
    assert.equal(await f.engine.forceCallerAuthorized(f.task(), stranger), false);

    await assert.rejects(
      f.command({ caller: stranger }),
      /Explicit resolution requires this task's coordinator, its live responsible planner or the operator board; this caller is not one of them/,
    );
    await assert.rejects(
      f.command({}),
      /Explicit resolution requires this task's coordinator, its live responsible planner or the operator board; no authenticated caller was given/,
    );
    assert.equal(f.task().phase, "awaiting_review", "a refused command writes nothing");

    assert.match(forceCallerRefusal(stranger, false), /it is not the task's live project planner, the Nucleus planner, the operator/);
    assert.match(forceCallerRefusal(undefined, false), /Force requires an authenticated caller/);
  } finally {
    f.store.close();
  }
});

test("a critical task names its narrower authority when a non-planner caller is refused", async () => {
  const f = fixture();
  try {
    f.store.update(f.task().id, { critical: true });
    await assert.rejects(
      f.command({ caller: stranger }),
      /A critical task requires its live responsible planner or the operator board; this caller is not one of them/,
    );
    assert.match(forceCallerRefusal(stranger, true), /critical task allows only its live project planner/);
    const applied = await f.command({ caller: planner });
    assert.equal(applied.explicitResolution?.status, "applied");
  } finally {
    f.store.close();
  }
});
