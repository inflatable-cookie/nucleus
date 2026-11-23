import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import {
  PARENT_MODEL,
  PARENT_PROVIDER,
  childThreadId,
} from "../hosts/t3code/nesting";
import type { AcpSessionSurface } from "../shared/acp/surface";
import { HostCreateInFlightError } from "../core/host";
import { LATE_REPLY_WAIT_MS } from "../hosts/t3code/intents";
import type { HostAgentSpec } from "../shared/host";
import type { Profile } from "../shared/contracts";
import { WIRE_LABEL_KEYS } from "../shared/wire-labels";
import { t3Fake } from "./support/t3code-fake";
import { storedT3Labels } from "./support/t3code-labels";

/**
 * Spec 068 §3 on the T3 wire: an uncertain create settles without a second
 * thread. A create whose reply comes late is never looked up as absent and never
 * resent while that reply can still land, and the late reply binds the one child
 * T3 made. A create T3 never received is resent under its own command id once
 * no reply can land and a complete read proves its child absent, so T3 creates
 * exactly one child: the child thread id derives from the command id.
 */

const profile: Profile = {
  id: "synthetic-profile",
  name: "Synthetic",
  provider: "synthetic-provider",
  model: "synthetic-model",
  available: true,
  problem: "",
  notes: "",
  supportedThinking: [],
};

function acpStub(server: Awaited<ReturnType<typeof t3Fake>>): AcpSessionSurface {
  return {
    bind: (input) => ({
      sessionId: `session:${input.taskId}`,
      taskId: input.taskId,
      bindingPath: `/synthetic/acp/sessions/${input.taskId}.json`,
    }),
    async turn() {
      throw new Error("the agent is not driven in this test");
    },
    async message() {
      throw new Error("the agent is not driven in this test");
    },
    release() {
      for (const thread of server.threads.values()) {
        if (thread.thread.providerInstanceId !== PARENT_PROVIDER) continue;
        for (const run of thread.runs)
          if (["preparing", "starting", "running", "waiting"].includes(run.status))
            run.status = "completed";
      }
    },
  };
}

async function fixture(t: TestContext) {
  const root = await realpath(
    mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "t3code-create-relaunch-")),
  );
  const server = await t3Fake(t, root);
  server.controls.providers = [
    {
      instanceId: PARENT_PROVIDER,
      displayName: "Nucleus",
      driver: "acpRegistry",
      enabled: true,
      status: "ready",
      models: [{ slug: PARENT_MODEL, name: "Nucleus" }],
    },
    {
      instanceId: "synthetic-provider",
      displayName: "Synthetic provider",
      driver: "codex",
      enabled: true,
      status: "ready",
      models: [{ slug: "synthetic-model", name: "Synthetic model" }],
    },
  ];
  server.controls.runOnLaunch = true;
  server.controls.parentHeldTurn = true;
  const acp = acpStub(server);
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => acp,
    reentryTimeoutMs: 300,
  });
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory: root,
    project: { projectId: "synthetic-project" },
  });
  const spec = (requestId: string, prompt = "Do the work"): HostAgentSpec => ({
    workspaceId: workspace.id,
    profile,
    title: "Synthetic task",
    taskNumber: 1305,
    mcpBindingPath: null,
    attempt: () => ({
      requestId,
      prompt,
      labels: storedT3Labels("worker", { runId: "worker-run" }),
      environment: {},
    }),
  });
  return { server, host, spec, workspace };
}

const COMMAND = "ns-agent-worker-run";
const labels = {
  [WIRE_LABEL_KEYS.task]: "synthetic-task",
  [WIRE_LABEL_KEYS.run]: "worker-run",
};
const requests = (server: Awaited<ReturnType<typeof t3Fake>>) =>
  server.commands.filter(
    (command) =>
      command.type === "delegated_task.request" && command.commandId === COMMAND,
  );

async function until(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A create T3 never received, then the connection that sent it ends. */
async function lostCreate(
  server: Awaited<ReturnType<typeof t3Fake>>,
  host: T3CodeHost,
  spec: (requestId: string, prompt?: string) => HostAgentSpec,
) {
  server.controls.timeoutDelegatedLaunch = true;
  await assert.rejects(host.createAgent(spec(COMMAND)));
  assert.equal(server.threads.has(childThreadId(COMMAND)), false, "T3 made no child");
  server.dropSockets();
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await host.connect();
  assert.deepEqual(await host.findRunAgents(labels), [], "a complete read finds nothing");
}

const oneChild = (server: Awaited<ReturnType<typeof t3Fake>>) =>
  [...server.threads.keys()].filter((id) => id === childThreadId(COMMAND)).length;

test("a create whose reply is late waits for it and yields exactly one thread", async (t) => {
  const { server, host, spec } = await fixture(t);
  // T3 holds the command unanswered until the test releases it: the caller's
  // deadline passes first, with no wall-clock race.
  server.controls.holdDelegatedLaunch = true;
  await assert.rejects(host.createAgent(spec(COMMAND)));
  assert.equal(host.state.read().intents[COMMAND]?.status, "unknown");

  // While the reply can still land the lookup refuses with its own cause: an
  // empty answer is not absence, and nothing replaces the create meanwhile.
  await assert.rejects(
    host.findRunAgents(labels),
    (error: unknown) => error instanceof HostCreateInFlightError,
  );
  await assert.rejects(host.createAgent(spec(COMMAND)));
  assert.equal(requests(server).length, 0, "nothing reached T3 yet");

  server.releaseHeldLaunches();
  await until(() => host.state.read().intents[COMMAND]?.status === "settled");
  const found = await host.findRunAgents(labels);
  assert.deepEqual(
    found.map((agent) => agent.id),
    [childThreadId(COMMAND)],
    "the late reply's child is the run's one thread",
  );
  assert.equal(requests(server).length, 1, "T3 received the create once");
  assert.equal(oneChild(server), 1);
});

test("a late reply's wait is bounded, after which the read decides", async (t) => {
  const { server, host, spec } = await fixture(t);
  server.controls.holdDelegatedLaunch = true;
  await assert.rejects(host.createAgent(spec(COMMAND)));
  assert.equal(host.intents.lateReplyPossible(COMMAND), true);
  assert.equal(
    host.intents.lateReplyPossible(COMMAND, Date.now() + LATE_REPLY_WAIT_MS + 1),
    false,
    "past its bound a late reply no longer holds the create back",
  );
  assert.deepEqual(await host.findRunAgents(labels), [], "the read decides");
});

test("a resend after the late-reply bound, then the held original answering, still yields one thread", async (t) => {
  const { server, host, spec } = await fixture(t);
  server.controls.holdDelegatedLaunch = true;
  await assert.rejects(host.createAgent(spec(COMMAND)));
  // Past the bound the read decides: the child is absent, so the create is resent
  // under its own command id while T3 still holds the original.
  const realNow = Date.now;
  Date.now = () => realNow() + LATE_REPLY_WAIT_MS + 1;
  try {
    assert.equal(host.intents.lateReplyPossible(COMMAND), false);
    assert.deepEqual(await host.findRunAgents(labels), []);
    const created = await host.createAgent(spec(COMMAND));
    assert.equal(created.id, childThreadId(COMMAND));
  } finally {
    Date.now = realNow;
  }
  // Now T3 processes the original: the same command id names the same child.
  server.releaseHeldLaunches();
  await until(() => requests(server).length === 2);
  assert.equal(oneChild(server), 1, "one thread, whichever create T3 applied last");
  assert.deepEqual(
    (await host.findRunAgents(labels)).map((agent) => agent.id),
    [childThreadId(COMMAND)],
  );
});

test("a create T3 never received is resent under its own command id once no reply can land", async (t) => {
  const { server, host, spec } = await fixture(t);
  await lostCreate(server, host, spec);
  const created = await host.createAgent(spec(COMMAND));
  assert.equal(created.id, childThreadId(COMMAND), "the same command id, so the same child id");
  assert.equal(requests(server).length, 2, "the lost command was sent again, under the same id");
  assert.equal(oneChild(server), 1);
});

test("a resend after the parent's turn ended anchors on the new turn and heals to one thread", async (t) => {
  const { server, host, spec } = await fixture(t);
  await lostCreate(server, host, spec);
  // The held parent turn is gone, as after a restart: the relaunch re-enters the
  // parent, so the resent create names a different parent run.
  const parent = Object.values(host.state.read().parents ?? {})[0]!;
  for (const run of server.threads.get(parent.threadId)!.runs)
    if (["preparing", "starting", "running", "waiting"].includes(run.status))
      run.status = "completed";
  const created = await host.createAgent(spec(COMMAND));
  const [first, second] = requests(server);
  assert.notEqual(second!.parentRunId, first!.parentRunId, "a new parent turn");
  assert.equal(created.id, childThreadId(COMMAND));
  assert.equal(oneChild(server), 1);
});

test("a resend with a different prompt render heals to one thread", async (t) => {
  const { server, host, spec } = await fixture(t);
  await lostCreate(server, host, spec);
  const created = await host.createAgent(spec(COMMAND, "Do the work, re-rendered"));
  const [first, second] = requests(server);
  assert.notEqual(second!.task, first!.task, "the resend carries the new render");
  assert.equal(created.id, childThreadId(COMMAND));
  assert.equal(oneChild(server), 1);
});

test("a removed child is never resent: the create landed", async (t) => {
  const { server, host, spec } = await fixture(t);
  await host.createAgent(spec(COMMAND));
  const child = childThreadId(COMMAND);
  // The ledger keeps the create unknown (its reply lost), and T3 later removed the child.
  host.state.update((state) => {
    state.intents[COMMAND] = { ...state.intents[COMMAND]!, status: "unknown" };
  });
  // A nightly that keeps the tombstone in its shell, so T3 itself answers "removed".
  server.controls.shellTombstones = true;
  server.threads.get(child)!.thread.deletedAt = "2026-11-23T00:00:00.000Z";
  host.reads.live.close();
  assert.deepEqual(
    (await host.findRunAgents(labels)).map((agent) => [agent.id, agent.hostConfirmed]),
    [[child, false]],
    "the lookup names the removed child rather than calling it absent",
  );
  const before = requests(server).length;
  await assert.rejects(host.createAgent(spec(COMMAND)));
  assert.equal(requests(server).length, before, "nothing is resent");
});
