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
import { HostReadRefusalError } from "../core/host";
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
  const spec = (requestId: string): HostAgentSpec => ({
    workspaceId: workspace.id,
    profile,
    title: "Synthetic task",
    taskNumber: 1305,
    mcpBindingPath: null,
    attempt: () => ({
      requestId,
      prompt: "Do the work",
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

async function until(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a create whose reply is late waits for it and yields exactly one thread", async (t) => {
  const { server, host, spec } = await fixture(t);
  server.controls.lateDelegatedLaunchMs = 1_600;
  await assert.rejects(host.createAgent(spec(COMMAND)));
  assert.equal(host.state.read().intents[COMMAND]?.status, "unknown");

  // While the reply can still land the lookup refuses: an empty answer is not absence.
  await assert.rejects(
    host.findRunAgents(labels),
    (error: unknown) => error instanceof HostReadRefusalError,
  );
  // And a relaunch under the same command id sends nothing.
  await assert.rejects(host.createAgent(spec(COMMAND)));
  assert.equal(requests(server).length, 0, "nothing reached T3 yet");

  await until(() => host.state.read().intents[COMMAND]?.status === "settled");
  const child = childThreadId(COMMAND);
  const found = await host.findRunAgents(labels);
  assert.deepEqual(
    found.map((agent) => agent.id),
    [child],
    "the late reply's child is the run's one thread",
  );
  assert.equal(requests(server).length, 1, "T3 received the create once");
  assert.equal(
    [...server.threads.keys()].filter((id) => id === child).length,
    1,
  );
});

test("a create T3 never received is resent under its own command id once no reply can land", async (t) => {
  const { server, host, spec } = await fixture(t);
  server.controls.timeoutDelegatedLaunch = true;
  await assert.rejects(host.createAgent(spec(COMMAND)));
  const child = childThreadId(COMMAND);
  assert.equal(server.threads.has(child), false, "T3 made no child");
  // The connection that sent it ends, so no reply can land on it any more.
  server.dropSockets();
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await host.connect();

  assert.deepEqual(await host.findRunAgents(labels), [], "a complete read finds nothing");
  const created = await host.createAgent(spec(COMMAND));
  assert.equal(created.id, child, "the same command id, so the same child id");
  assert.equal(server.threads.has(child), true);
  assert.equal(
    server.commands.filter(
      (command) =>
        command.type === "delegated_task.request" && command.commandId === COMMAND,
    ).length,
    2,
    "the lost command was sent again, under the same id",
  );
});
