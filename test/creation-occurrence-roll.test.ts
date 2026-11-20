import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { fakeAdapter } from "./support/fakes";
import { socketFixtureDirectory } from "./support/socket-fixture";
import { paseoCatalog } from "./support/pool-shapes";
import { submissionSchema, type Profile } from "../shared/contracts";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";
import { ABSENT_WORKER_REASON } from "../core/recovery/task-reasons";
import { creationProducerId } from "../core/store/store-task-funnel";
import { ownerTaskNext, collectOwnerVerbFacts } from "../core/verbs/owner-verbs";

// One worker creation occurrence, driven through a service roll. A roll is a new
// Engine over the same Store; the original producer is "still live" while its
// reservation names this process and "replaced" once it names another one.

const profile: Profile = {
  id: "worker",
  name: "Worker",
  provider: "codex",
  model: "gpt-6-luna",
  notes: "",
  available: true,
  problem: "",
  supportedThinking: ["low"],
};

type Fixture = ReturnType<typeof fixture>;

function fixture() {
  const dir = socketFixtureDirectory("callback.sock");
  const store = new Store(join(dir, "queue.sqlite"));
  store.setProfiles([{ id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, notes: profile.notes }]);
  const calls = { workspaces: 0, agents: [] as string[] };
  const tokens = new Map<string, string>();
  const adapter = fakeAdapter({
    catalog: async () => paseoCatalog(),
    validate: async (t) => t.planningCommit,
    createWorkspace: async (t) => {
      calls.workspaces++;
      return { id: `ws-${t.id}`, directory: "/fixture" };
    },
    verifyWorkspace: async (t) => t.branch,
    createAgent: async (t, token) => {
      calls.agents.push(t.runId ?? "");
      tokens.set(t.runId ?? "", token);
      return { id: `agent-${t.runId}`, workspaceId: t.workspaceId };
    },
    observe: async (id) => ({ id, workspaceId: "ws", status: "idle", active: false, permissions: false, error: "" }),
    archiveAgent: async () => {},
  }) as Adapter & Partial<ResolutionAdapter>;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [profile];
  store.setMeta("pool", [{ profileId: profile.id, enabled: true, group: "test", weight: 1, scopes: ["general"] }]);
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Creation occurrence",
      repoPath: "/project-a",
      dependsOn: [],
      planningCommit: "a".repeat(40),
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    "a".repeat(40),
  );
  return {
    dir,
    store,
    adapter,
    calls,
    tokens,
    engine,
    task,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Put the task into an uncertain initial-worker creation with run R, reserved by this process. */
function uncertainIntent(f: Fixture, runId: string) {
  return f.store.update(
    f.task.id,
    {
      phase: "needs_attention",
      reason: ABSENT_WORKER_REASON,
      workspaceIntent: true,
      workspaceId: `ws-${f.task.id}`,
      directory: "/fixture",
      profile,
      profileGroup: "test",
      planningBase: f.task.planningCommit,
      agentIntent: true,
      runId,
    },
    "agent_intent",
    runId,
  );
}

/** A service roll: a new Engine over the same store, with the profile catalog loaded as startup does. */
function roll(f: Fixture): Engine {
  const engine = new Engine(f.store, f.adapter, 0);
  engine.profiles = [profile];
  return engine;
}

/** Replace the reservation's producer, as a service roll does to a creation left by the old process. */
function rolledProducer(f: Fixture, runId: string) {
  const latest = f.store.db
    .prepare("SELECT detail FROM events WHERE taskId=? AND kind=? ORDER BY id DESC LIMIT 1")
    .get(f.task.id, "creation_attempt_reserved") as { detail: string } | undefined;
  const reservation = JSON.parse(latest?.detail ?? "{}") as Record<string, unknown>;
  assert.equal(reservation.id, runId, "the reservation under test is the latest one");
  f.store.event(f.task.id, "creation_attempt_reserved", JSON.stringify({ ...reservation, producerId: `${creationProducerId}-old`, attemptId: randomUUID() }));
}

test("a live producer with an empty lookup is a wait: the restart refuses, names the wait, and the run keeps its credential", async () => {
  const f = fixture();
  try {
    const runId = "creating-run";
    const intent = uncertainIntent(f, runId);
    f.store.setCredential(runId, "live-token");
    f.adapter.findRunAgents = async () => [];
    const waited = await f.engine.performTaskControl({ taskId: intent.id, version: intent.version, action: "restart", role: "worker", reason: "Resume", instruction: "Continue" });
    assert.equal(waited.phase, "needs_attention");
    assert.equal(waited.resolution.stop?.reason, "lifecycle");
    assert.match(waited.reason, /creation remains uncertain/i);
    const after = f.store.task(intent.id);
    assert.equal(after.runId, runId);
    assert.equal(after.agentIntent, true);
    assert.equal(after.agentId, null);
    assert.doesNotThrow(() => f.store.authenticate(runId, "live-token"));
    assert.equal(f.calls.agents.length, 0);
  } finally {
    f.close();
  }
});

test("a service roll keeps an incomplete lookup owned, then one exact identity binds the original run once", async () => {
  const f = fixture();
  try {
    const runId = "rolled-run";
    const intent = uncertainIntent(f, runId);
    f.store.setCredential(runId, "rolled-token");
    rolledProducer(f, runId);
    // Incomplete: a match outside the retained workspace is unknown placement, never absence.
    f.adapter.findRunAgents = async () => [{ id: "elsewhere", workspaceId: "ws-other" }];
    await roll(f).recover(f.store.task(intent.id));
    let current = f.store.task(intent.id);
    assert.equal(current.runId, runId);
    assert.equal(current.agentIntent, true);
    assert.equal(current.agentId, null);
    assert.doesNotThrow(() => f.store.authenticate(runId, "rolled-token"));

    // A later positive identity after another roll binds the existing occurrence; no second creation.
    f.adapter.findRunAgents = async () => [{ id: "agent-original", workspaceId: current.workspaceId }];
    await roll(f).recover(current);
    current = f.store.task(intent.id);
    assert.equal(current.agentId, "agent-original");
    assert.equal(current.runId, runId);
    assert.doesNotThrow(() => f.store.authenticate(runId, "rolled-token"));
    assert.equal(f.calls.agents.length, 0);
  } finally {
    f.close();
  }
});

test("proved absence after a roll releases the occurrence once: a fresh run launches and the old credential stays revoked", async () => {
  const f = fixture();
  try {
    const runId = "absent-run";
    const intent = uncertainIntent(f, runId);
    f.store.setCredential(runId, "absent-token");
    rolledProducer(f, runId);
    f.adapter.findRunAgents = async () => [];
    const ready = await roll(f).performTaskControl({
      taskId: intent.id,
      version: intent.version,
      action: "restart",
      role: "worker",
      reason: "Resume the retained worker",
      instruction: "Continue the original handoff",
    });
    assert.equal(ready.agentIntent, false);
    assert.equal(ready.runId, null);
    assert.equal(ready.restartRunId, null);
    assert.throws(() => f.store.authenticate(runId, "absent-token"), /Unauthorized/);

    f.store.setMeta("paused", false);
    await new Engine(f.store, f.adapter, 0).wake();
    const running = f.store.task(intent.id);
    assert.equal(running.phase, "working");
    assert.ok(running.runId && running.runId !== runId, "the fresh launch takes its own run identity");
    assert.deepEqual(f.calls.agents, [running.runId]);
    assert.throws(() => f.store.authenticate(runId, "absent-token"), /Unauthorized/);
  } finally {
    f.close();
  }
});

test("the circular refusal is gone: move to=work names the same owed observation restart does, and neither verb points at the other while both are refused", async () => {
  const f = fixture();
  try {
    const runId = "circular-run";
    const intent = uncertainIntent(f, runId);
    f.store.setCredential(runId, "circular-token");
    f.adapter.findRunAgents = async () => [];
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(intent.id)));
    const restart = next.verbs.find((verb) => verb.action === "restart");
    const move = next.verbs.find((verb) => verb.action === "move" && (verb.args?.to === "work" || verb.forceArgs?.to === "work"));
    assert.equal(restart?.available, false);
    assert.equal(move?.available, false);
    assert.equal(move?.refusal?.replace(/^move work: /, ""), restart?.refusal, "both refusals name the same owed observation");
    assert.doesNotMatch(move?.refusal ?? "", /restart/i, "a refused restart is never the cure for a refused move");
    assert.match(move?.refusal ?? "", /waiting for its recorded producer/);
  } finally {
    f.close();
  }
});

test("an un-restorable parent refuses the restart before any release: the uncertain occurrence keeps its run and credential", async () => {
  const f = fixture();
  try {
    const runId = "parent-run";
    const intent = uncertainIntent(f, runId);
    f.store.setCredential(runId, "parent-token");
    rolledProducer(f, runId);
    f.adapter.findRunAgents = async () => [];
    f.adapter.restoreTaskParent = async () => {
      throw new Error("The archived T3 parent cannot be restored");
    };
    await assert.rejects(
      roll(f).performTaskControl({ taskId: intent.id, version: intent.version, action: "restart", role: "worker", reason: "Resume", instruction: "Continue" }),
      /cannot be restored/,
    );
    const after = f.store.task(intent.id);
    assert.equal(after.runId, runId);
    assert.equal(after.agentIntent, true);
    assert.equal(after.phase, "needs_attention");
    assert.doesNotThrow(() => f.store.authenticate(runId, "parent-token"));
    assert.equal(f.calls.agents.length, 0);
  } finally {
    f.close();
  }
});
