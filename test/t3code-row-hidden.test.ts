import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { T3RpcError } from "../hosts/t3code/rpc";
import {
  SNOOZE_HORIZON_MS,
  SNOOZE_RENEW_BEFORE_MS,
  snoozeEpisodeStart,
} from "../hosts/t3code/presentation";
import { PARENT_MODEL, PARENT_PROVIDER } from "../hosts/t3code/nesting";
import type { AcpSessionSurface } from "../shared/acp/surface";
import type { HostAgentSpec } from "../shared/host";
import type { Profile } from "../shared/contracts";
import type { TaskAttention } from "../shared/task-attention";
import { t3Fake, STAMP } from "./support/t3code-fake";
import { storedT3Labels } from "./support/t3code-labels";

/**
 * A task row's visibility evidence on T3 (nucleus#1417): the host's durable snooze
 * ownership proves how long one continuous episode has hidden the row, keeps it
 * across a horizon renewal, and reports an unreadable row as unknown rather than
 * clear. Every record here is a synthetic Nightly shape served by the fake
 * transport; no live T3 is touched.
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
const taskId = "synthetic-task";

const nucleusProvider = {
  instanceId: PARENT_PROVIDER,
  displayName: "Nucleus",
  driver: "acpRegistry",
  enabled: true,
  status: "ready",
  models: [{ slug: PARENT_MODEL, name: "Nucleus" }],
};

function acpStub(server: Awaited<ReturnType<typeof t3Fake>>) {
  const surface: AcpSessionSurface = {
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
    release(sessionId) {
      for (const thread of server.threads.values()) {
        if (thread.thread.providerInstanceId !== PARENT_PROVIDER) continue;
        for (const run of thread.runs)
          if (
            ["preparing", "starting", "running", "waiting"].includes(run.status)
          )
            run.status = "completed";
      }
      void sessionId;
    },
  };
  return { surface };
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "t3code-row-hidden-"));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  server.controls.providers = [
    nucleusProvider,
    {
      instanceId: "synthetic-provider",
      displayName: "Synthetic provider",
      driver: "codex",
      enabled: true,
      status: "ready",
      models: [{ slug: "synthetic-model", name: "Synthetic model" }],
    },
  ];
  const acp = acpStub(server);
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 2_000,
    probeThreadId: "synthetic-probe",
    acp: () => acp.surface,
    reentryTimeoutMs: 300,
  });
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory,
    project: { projectId: "synthetic-project" },
  });
  const spec = (requestId: string): HostAgentSpec => ({
    workspaceId: workspace.id,
    profile,
    title: "Synthetic role",
    taskNumber: 225,
    mcpBindingPath: null,
    attempt: () => ({
      requestId,
      prompt: "Worker prompt",
      labels: storedT3Labels("worker", { taskId, runId: `${requestId}-run` }),
      environment: {},
    }),
  });
  await host.createAgent(spec("worker-launch"));
  const parent = Object.values(host.state.read().parents ?? {})[0]!;
  const projection = server.threads.get(parent.threadId)!;
  const snoozeRecord = () => host.state.read().snoozes?.[parent.threadId];
  return { host, server, parent, projection, snoozeRecord };
}

const waiting = (cause = "Waiting on nucleus#1364"): TaskAttention => ({
  state: "waiting",
  cause,
});

test("a waiting row records one episode start that a horizon renewal keeps (nucleus#1417)", async (t) => {
  const { host, projection, snoozeRecord } = await fixture(t);

  assert.deepEqual(
    await host.rowSnoozeVisibility(taskId),
    { kind: "clear" },
    "nothing snoozed yet",
  );
  await host.reconcileTaskRow(taskId, waiting());
  const first = snoozeRecord()!;
  assert.ok(first);
  assert.equal(first.state, "snoozed");
  assert.ok(
    first.episodeStartedAt,
    "the episode start is recorded, not derived",
  );
  const visibility = await host.rowSnoozeVisibility(taskId);
  assert.equal(visibility.kind, "snoozed");
  assert.equal(
    visibility.kind === "snoozed" && visibility.episodeStartedAt,
    first.episodeStartedAt,
  );
  assert.equal(
    visibility.kind === "snoozed" && visibility.cause,
    "Waiting on nucleus#1364",
  );

  // A renewal before the horizon is the same episode: the age does not restart.
  projection.thread.snoozedUntil = new Date(
    Date.now() + SNOOZE_RENEW_BEFORE_MS / 2,
  ).toISOString();
  await host.reconcileTaskRow(taskId, waiting());
  const renewed = snoozeRecord()!;
  assert.notEqual(renewed.until, first.until, "the horizon was renewed");
  assert.equal(
    renewed.episodeStartedAt,
    first.episodeStartedAt,
    "a renewal is not a new episode",
  );
});

test("a record written before the episode field proves its start from its own horizon (nucleus#1417)", async (t) => {
  const { host, parent, projection, snoozeRecord } = await fixture(t);
  const until = new Date(Date.now() + SNOOZE_HORIZON_MS).toISOString();
  projection.thread.snoozedUntil = until;
  host.state.update((state) => {
    state.snoozes = {
      ...state.snoozes,
      [parent.threadId]: {
        episode: 0,
        commandId: "legacy-snooze",
        until,
        state: "snoozed",
        cause: "Legacy wait",
        recordedAt: STAMP,
      },
    };
  });

  assert.equal(
    snoozeEpisodeStart(snoozeRecord()!),
    new Date(Date.parse(until) - SNOOZE_HORIZON_MS).toISOString(),
  );
  const visibility = await host.rowSnoozeVisibility(taskId);
  assert.equal(visibility.kind, "snoozed");
  assert.equal(
    visibility.kind === "snoozed" && visibility.episodeStartedAt,
    new Date(Date.parse(until) - SNOOZE_HORIZON_MS).toISOString(),
  );

  // A pass that needs no write leaves the proven start as it is.
  await host.reconcileTaskRow(taskId, waiting("Legacy wait"));
  assert.equal(
    snoozeRecord()!.episodeStartedAt,
    new Date(Date.parse(until) - SNOOZE_HORIZON_MS).toISOString(),
  );
});

test("an operator snooze, a manual settle and a lapsed horizon are never Nucleus-owned (nucleus#1417)", async (t) => {
  const { host, parent, projection } = await fixture(t);

  // A row T3 shows snoozed that this host never recorded is the operator's.
  projection.thread.snoozedUntil = new Date(
    Date.now() + SNOOZE_HORIZON_MS,
  ).toISOString();
  assert.deepEqual(await host.rowSnoozeVisibility(taskId), { kind: "clear" });

  // The operator settles the row: the recorded snooze is retired and the row is clear.
  projection.thread.snoozedUntil = null;
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal((await host.rowSnoozeVisibility(taskId)).kind, "snoozed");
  projection.thread.settledOverride = "settled";
  projection.thread.settledAt = STAMP;
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(
    host.state.read().snoozes?.[parent.threadId],
    undefined,
    "a manual settle retires the record",
  );
  assert.deepEqual(await host.rowSnoozeVisibility(taskId), { kind: "clear" });

  // A recorded snooze whose horizon lapsed woke itself: the row is visible again.
  projection.thread.settledOverride = null;
  await host.reconcileTaskRow(taskId, waiting());
  projection.thread.snoozedUntil = new Date(Date.now() - 60_000).toISOString();
  assert.deepEqual(await host.rowSnoozeVisibility(taskId), { kind: "clear" });
});

test("a refused snooze never hides the row, so it is clear (nucleus#1417)", async (t) => {
  const { host, projection, snoozeRecord } = await fixture(t);
  projection.runtimeRequests = [
    {
      id: "synthetic-approval",
      kind: "permission",
      status: "pending",
    } as never,
  ];

  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(
    snoozeRecord()?.state,
    "unknown",
    "the send is unknown until the read-back answers",
  );
  assert.equal(
    projection.thread.snoozedUntil ?? null,
    null,
    "T3 did not accept the snooze",
  );
  assert.deepEqual(await host.rowSnoozeVisibility(taskId), { kind: "clear" });
});

test("an unreadable row is unknown with its evidence kept, never clear (nucleus#1417)", async (t) => {
  const { host, parent, snoozeRecord } = await fixture(t);
  await host.reconcileTaskRow(taskId, waiting());
  const recorded = snoozeRecord()!;

  const nativeStream = host.rpc.readStream.bind(host.rpc);
  host.rpc.readStream = async (method, payload, onItem) => {
    if (method === "orchestration.subscribeThread")
      throw new T3RpcError("protocol", method);
    return nativeStream(method, payload, onItem);
  };
  try {
    host.reads.forget(parent.threadId);
    const visibility = await host.rowSnoozeVisibility(taskId);
    assert.equal(visibility.kind, "unknown");
    assert.equal(
      visibility.kind === "unknown" && visibility.episodeStartedAt,
      recorded.episodeStartedAt,
    );
    assert.equal(
      visibility.kind === "unknown" && visibility.cause,
      "Waiting on nucleus#1364",
    );
    assert.match(
      visibility.kind === "unknown" ? visibility.reason : "",
      /T3Code|T3/,
    );
  } finally {
    host.rpc.readStream = nativeStream;
  }
  assert.equal(
    host.state.read().snoozes?.[parent.threadId]?.episodeStartedAt,
    recorded.episodeStartedAt,
    "the record is untouched",
  );
});

test("a disconnected host preserves a recorded snooze as unknown rather than clear (nucleus#1417)", async (t) => {
  const { host, parent, snoozeRecord } = await fixture(t);
  await host.reconcileTaskRow(taskId, waiting());
  const recorded = snoozeRecord()!;

  host.close();
  const visibility = await host.rowSnoozeVisibility(taskId);
  assert.equal(visibility.kind, "unknown");
  assert.equal(
    visibility.kind === "unknown" && visibility.episodeStartedAt,
    recorded.episodeStartedAt,
  );
  assert.equal(
    visibility.kind === "unknown" && visibility.cause,
    "Waiting on nucleus#1364",
  );
  assert.match(
    visibility.kind === "unknown" ? visibility.reason : "",
    /connection is unavailable/,
  );
  assert.equal(
    host.state.read().snoozes?.[parent.threadId]?.episodeStartedAt,
    recorded.episodeStartedAt,
    "the record is untouched while disconnected",
  );

  // A task with no recorded snooze still reads clear while disconnected.
  assert.deepEqual(await host.rowSnoozeVisibility("unrecorded-task"), {
    kind: "clear",
  });
});
