import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
import { createAdapter } from "../hosts/t3code";
import { HostPolicies } from "../core/host/host-policies";
import type { HostPolicyConstructor } from "../core/host";
import {
  WorkerFailover,
  type WorkerFailoverContext,
} from "../core/dispatch/worker-failover";
import { Engine } from "../core/engine";
import { readCreationAttempt } from "../core/store/store-task-funnel";
import { T3RpcError } from "../hosts/t3code/rpc";
import {
  ProvenPreSendRefusalError,
  HostUnknownDeliveryError,
  hostFailureRefusalDetail,
} from "../core/host";
import { T3CompatibilityError, shellThread } from "../hosts/t3code/contracts";
import {
  activeStatuses,
  shellThreadStatus,
  T3InventoryChurnError,
} from "../hosts/t3code/reads";
import {
  workspaceThreadFacts,
  type WorkspaceThreadInventoryHost,
} from "../core/workspaces/owned-workspace-threads";
import { isTransportFailure } from "../shared/transport";
import type { HostAgentSpec } from "../shared/host";
import {
  submissionSchema,
  runSchema,
  type Profile,
  type Run,
  type Task,
} from "../shared/contracts";
import { Store, qualifiedThreadArchiveEffectKey } from "../core/store/store";
import { archiveFinishedThreads } from "../core/workspaces/thread-archive";
import { runThreadRetentionPass } from "../core/workspaces/thread-retention";
import type { Adapter } from "../core/host";
import { taskWorkspaceTitle } from "../core/workspaces/workspace-title";
import {
  liveToolIssueFact,
  observedTurnState,
  readToolTimeline,
} from "../core/recovery/stall";
import { capT3Title } from "../hosts/t3code/titles";
import { WIRE_LABEL_KEYS, WIRE_PLUGIN_LABEL_KEY } from "../shared/wire-labels";
import {
  t3Fake,
  STAMP,
  threadProjection,
  syntheticProviderThread,
  syntheticRun,
  syntheticRuntimeRequest,
  syntheticTurnItem,
} from "./support/t3code-fake";
import { storedT3Labels } from "./support/t3code-labels";
import { fakeAdapter, submission } from "./support/fakes";

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
/**
 * A long thread's turn items: newest last, strictly increasing item time and the
 * newest five items in a second run, so a bounded window reaches back into an
 * earlier turn and can prove what it covers.
 */
function longThreadItems(
  threadId: string,
  count: number,
  overrides: (index: number) => Record<string, unknown>,
) {
  const base = Date.parse(STAMP);
  return Array.from({ length: count }, (_, index) =>
    syntheticTurnItem(threadId, index + 1, {
      runId: index < count - 5 ? "synthetic-run-1" : "synthetic-run-2",
      updatedAt: new Date(base + (index + 1) * 1_000).toISOString(),
      ...overrides(index),
    }),
  );
}
/** The Nucleus ACP provider instance `nucleus t3 install` registers. */
const nucleusProvider = {
  instanceId: PARENT_PROVIDER,
  displayName: "Nucleus",
  driver: "acpRegistry",
  enabled: true,
  status: "ready",
  models: [{ slug: PARENT_MODEL, name: "Nucleus" }],
};

/** The ACP surface: a release ends the parent's held turn, as the agent does. */
function acpStub(server: Awaited<ReturnType<typeof t3Fake>>) {
  const released: string[] = [];
  const surface: AcpSessionSurface = {
    bind: (input) => ({
      sessionId: `session:${input.taskId}`,
      taskId: input.taskId,
      bindingPath: `/synthetic/acp/${input.taskId}.json`,
    }),
    async turn() {
      throw new Error("the agent is not driven in this test");
    },
    async message() {
      throw new Error("the agent is not driven in this test");
    },
    release(sessionId) {
      released.push(sessionId);
      for (const thread of server.threads.values()) {
        if (thread.thread.providerInstanceId !== PARENT_PROVIDER) continue;
        for (const run of thread.runs)
          if (
            ["preparing", "starting", "running", "waiting"].includes(run.status)
          )
            run.status = "completed";
      }
    },
  };
  return { surface, released };
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "t3code-adapter-"));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  // Every role thread is its task parent thread's native child (nucleus#1366), so
  // the fixture serves the Nucleus ACP provider and the ACP session surface the
  // parent's held turn runs on.
  const acp = acpStub(server);
  const options = {
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => acp.surface,
    reentryTimeoutMs: 300,
  };
  const host = new T3CodeHost(options);
  t.after(() => host.close());
  await host.connect();
  const served = (await host.rpc.call("server.getConfig", {})) as {
    providers: Array<Record<string, unknown>>;
  };
  server.controls.providers = [...served.providers, nucleusProvider];
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory,
    project: { projectId: "synthetic-project" },
  });
  const spec = (
    requestId = "launch-intent",
    prompt = "Synthetic prompt",
    role = "worker",
  ): HostAgentSpec => ({
    workspaceId: workspace.id,
    profile,
    title: role === "worker" ? "Synthetic role" : `${role}: Synthetic role`,
    taskNumber: 225,
    mcpBindingPath: null,
    attempt: () => ({
      requestId,
      prompt,
      labels: storedT3Labels(role, {
        runId: role === "worker" ? "worker-run" : `${role}-run`,
      }),
      environment: {},
    }),
  });
  return { root, directory, server, options, host, workspace, spec, acp };
}

async function reviewerCreationFixture(t: TestContext) {
  const { server, host, workspace, directory, spec } = await fixture(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const prUrl = "https://github.com/example/repo/pull/7";
  const submitted = store.insert(submission(), host.hostId, "handoff", base);
  const run = runSchema.parse({
    id: "review-creation",
    taskId: submitted.id,
    role: "reviewer",
    generation: 1,
    head,
    base,
    hostId: host.hostId,
    agentId: null,
    workspaceId: workspace.id,
    profile,
    status: "intent",
    createdAt: STAMP,
    lastObservedAt: null,
    idleSince: null,
    active: false,
    completion: null,
    released: false,
  });
  store.putRun(run);
  const attempt = readCreationAttempt(store, run);
  assert.ok(attempt);
  const rollProducer = () => {
    // Model the producer from before the service roll and age its reservation.
    store.db
      .prepare(
        `UPDATE events SET at=?, detail=json_set(detail,'$.producerId',?)
         WHERE taskId=? AND kind='creation_attempt_reserved'
         AND json_extract(detail,'$.attemptId')=?`,
      )
      .run(STAMP, "previous-service-process", run.taskId, attempt.attemptId);
    store.putRun({ ...run, status: "uncertain" });
  };
  store.setCredential(run.id, "synthetic-token");
  store.setMeta("paused", false);
  store.setMeta("pool", [
    {
      profileId: profile.id,
      enabled: true,
      group: "review",
      roles: ["reviewer"],
      weight: "default",
      scopes: ["general"],
    },
  ]);
  store.update(submitted.id, {
    phase: "reviewing",
    workspaceId: workspace.id,
    directory,
    prUrl,
    prHead: head,
    resumePrNumber: 7,
    resolution: { ...submitted.resolution, currentRunId: run.id },
  });
  const t3 = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
  );
  const engine = new Engine(
    store,
    fakeAdapter({
      hostId: host.hostId,
      workspaceAvailable: (id: string) => host.workspaceAvailable(id),
      findRunAgents: (run: Run) => t3.findRunAgents(run),
      verifyPr: async () => ({ head, url: prUrl }),
      createRun: async () =>
        assert.fail("the control only releases the creation"),
    }),
  );
  engine.profiles = [profile];
  const requestId = "review-launch";
  const threadId = childThreadId(requestId);
  const labels = storedT3Labels("reviewer", {
    taskId: submitted.id,
    runId: run.id,
  });
  const launchSpec = spec(requestId, "Review", "reviewer");
  const launch = () =>
    host.createAgent({
      ...launchSpec,
      attempt: () => ({ ...launchSpec.attempt(false, false), labels }),
    });
  const restart = () =>
    engine.performTaskControl({
      taskId: submitted.id,
      version: store.task(submitted.id).version,
      action: "restart",
      role: "reviewer",
      reason: "Resume review",
      instruction: "Review the retained head",
    });
  return {
    server,
    host,
    directory,
    store,
    engine,
    run,
    requestId,
    threadId,
    launch,
    restart,
    rollProducer,
  };
}


test("connect accepts an unseen nightly on structural probes, records its version and preserves capabilities", async (t) => {
  const { host, server } = await fixture(t);
  assert.equal(host.hostId, "t3code:synthetic-environment");
  assert.equal(host.version, server.controls.version);
  assert.equal(host.state.read().lastPassedVersion, server.controls.version);
  assert.equal(host.connected, true);
  assert.deepEqual(host.capabilities(), {
    reportingViaMcp: false,
    supportsCoordinatorRecovery: false,
    nativeDecisions: false,
    uiContributions: false,
    lifecycleDispatch: false,
    perThreadEnvironment: false,
  });
  assert.equal(server.commands.length, 0, "compatibility probe is read-only");
  const providers = (await host.catalog()).providers;
  assert.equal(providers[0]?.key, "synthetic-provider");
});

test("create launches the task parent on the task checkout and runs the role as its native child", async (t) => {
  const { host, server, workspace, directory, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const parent = server.commands[0]!;
  // The parent: the Nucleus ACP provider, the task's own checkout, and the hold-marker
  // prompt the agent never forwards (nucleus#1305).
  assert.equal(parent.method, "orchestration.launchThread");
  assert.deepEqual(parent.modelSelection, {
    instanceId: PARENT_PROVIDER,
    model: PARENT_MODEL,
  });
  assert.deepEqual(parent.workspaceStrategy, {
    type: "existing_worktree",
    worktreePath: directory,
  });
  // The opening prompt is a plain sentence: no internal marker and no task id on screen.
  assert.equal(
    parent.initialMessage.text,
    "Nucleus keeps this task thread open for its next role.",
  );
  assert.doesNotMatch(
    parent.initialMessage.text,
    /nucleus-hold|task-[0-9a-f-]{8}/,
  );
  assert.equal(parent.runtimeMode, "full-access");
  // The role: a native child of that parent, on the launch's own provider and model,
  // carrying the prompt and the numbered role title.
  const child = server.commands.find(
    (command) => command.type === "delegated_task.request",
  )!;
  assert.equal(child.parentThreadId, parent.threadId);
  assert.deepEqual(child.modelSelection, {
    instanceId: "synthetic-provider",
    model: "synthetic-model",
  });
  assert.equal(child.task, "Synthetic prompt");
  assert.equal(child.title, "225: Synthetic role");
  assert.equal(created.id, childThreadId(child.commandId as string));
  assert.equal(created.workspaceId, workspace.id);
  for (const field of ["environment", "mcpServers", "workspaceStrategy"])
    assert.equal(Object.hasOwn(child, field), false, field);
  assert.equal((await host.observe(created.id)).workspaceId, workspace.id);
  assert.deepEqual(
    await host.findAgents({ [WIRE_LABEL_KEYS.task]: "synthetic-task" }),
    [{ ...created, hostConfirmed: true }],
  );
});

test("new T3 worker, reviewer and recovery threads use task number and role titles", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-title", "Worker", "worker"));
  await host.createAgent(spec("review-title", "Review", "reviewer"));
  await host.createAgent(spec("recovery-title", "Recovery", "recovery"));
  assert.deepEqual(
    server.commands
      .filter((command) => command.type === "delegated_task.request")
      .map((command) => command.title),
    [
      "225: Synthetic role",
      "225 review: Synthetic role",
      "225 recovery: Synthetic role",
    ],
  );
});

test("worker thread titles use the shared task state title once per change", async (t) => {
  const { host, server, options, spec } = await fixture(t);
  const created = await host.createAgent(spec("rename-title"));
  const task = {
    id: "synthetic-task",
    number: 225,
    title: "Synthetic role",
    held: false,
    hostId: host.hostId,
    workspaceId: created.workspaceId,
    agentId: created.id,
    phase: "working",
  } as Task;
  const states = [
    "working",
    "awaiting_review",
    "merging",
    "working",
    "awaiting_review",
    "working",
  ] as const;
  const titles = states.map((phase) => taskWorkspaceTitle({ ...task, phase }));
  for (const [index, phase] of states.entries())
    await host.setTaskWorkspaceTitle(
      { ...task, phase },
      titles[index]!,
      `request-${index + 1}`,
      false,
    );
  await host.setTaskWorkspaceTitle(
    task,
    titles.at(-1)!,
    `request-${states.length}`,
    false,
  );
  assert.deepEqual(
    server.commands
      .filter((command) => command.type === "thread.metadata.update")
      .map((command) => command.title),
    titles,
  );
  const longTitle = taskWorkspaceTitle({
    ...task,
    title: "Long task ".repeat(100),
  });
  await host.setTaskWorkspaceTitle(task, longTitle, "long-title", false);
  assert.equal(
    server.commands
      .filter((command) => command.type === "thread.metadata.update")
      .at(-1)?.title,
    capT3Title(longTitle),
  );
});

test("an uncertain worker title write is read before retry and is not resent when already applied", async (t) => {
  const { host, server, options, spec } = await fixture(t);
  const created = await host.createAgent(spec("rename-title"));
  const task = {
    id: "synthetic-task",
    number: 225,
    title: "Synthetic role",
    held: false,
    hostId: host.hostId,
    workspaceId: created.workspaceId,
    agentId: created.id,
    phase: "working",
  } as Task;
  const title = taskWorkspaceTitle(task);
  const row = Object.values(host.state.read().parents ?? {})[0]!;
  server.controls.disconnectAfterEffect = true;
  await assert.rejects(
    host.setTaskWorkspaceTitle(task, title, "title-request", false),
  );
  assert.equal(
    server.threads.get(row.threadId)!.thread.title,
    title,
    "the server applied the title to the task row before the reply was lost",
  );
  host.close();
  server.controls.disconnectAfterEffect = false;
  const reloaded = new T3CodeHost(options);
  t.after(() => reloaded.close());
  await reloaded.connect();
  await reloaded.setTaskWorkspaceTitle(task, title, "title-request", true);
  assert.equal(
    server.commands.filter(
      (command) => command.type === "thread.metadata.update",
    ).length,
    1,
    "a read confirming the current title settles the unknown write without resending",
  );
});

test("connect refuses incompatible protocol and missing probe coverage without a canary mutation", async (t) => {
  const { host, server, options } = await fixture(t);
  host.close();
  server.controls.protocol = 3;
  const incompatible = new T3CodeHost(options);
  t.after(() => incompatible.close());
  await assert.rejects(incompatible.connect(), /orchestrationProtocolVersion/);
  assert.equal(incompatible.connected, false);
  server.controls.protocol = 2;
  server.controls.shellMissingField = "activeRunId";
  const missingField = new T3CodeHost(options);
  t.after(() => missingField.close());
  await assert.rejects(missingField.connect(), /activeRunId/);
  server.controls.shellMissingField = "";
  server.controls.threadCoverage = { hasMoreHistory: "true" };
  const incompleteProbe = new T3CodeHost(options);
  t.after(() => incompleteProbe.close());
  await assert.rejects(incompleteProbe.connect(), /hasMoreHistory/);
  assert.equal(incompleteProbe.connected, false);
  server.controls.threadCoverage = {};
  server.threads.clear();
  const empty = new T3CodeHost({ ...options, probeThreadId: undefined });
  t.after(() => empty.close());
  await empty.connect();
  assert.equal(empty.connected, true);
  assert.equal(empty.threadShapePending, true);
  assert.equal(server.commands.length, 0);
});

test("the first created thread is decoded and a mismatch refuses it and takes T3 offline", async (t) => {
  const { host, server, options, spec } = await fixture(t);
  host.close();
  server.threads.clear();
  const empty = new T3CodeHost({ ...options, probeThreadId: undefined });
  t.after(() => empty.close());
  await empty.connect();
  assert.equal(empty.threadShapePending, true);
  server.controls.threadCoverage = { hasMoreHistory: "true" };
  await assert.rejects(
    empty.createAgent(spec()),
    /subscribeThread\.hasMoreHistory/,
  );
  assert.equal(empty.connected, false);
  assert.match(empty.compatibilityFailure, /subscribeThread\.hasMoreHistory/);
});

test("the first created thread clears pending verification after a strict decode", async (t) => {
  const { host, server, options, spec } = await fixture(t);
  host.close();
  server.threads.clear();
  const empty = new T3CodeHost({ ...options, probeThreadId: undefined });
  t.after(() => empty.close());
  await empty.connect();
  assert.equal(empty.threadShapePending, true);
  await empty.createAgent(spec());
  assert.equal(empty.connected, true);
  assert.equal(empty.threadShapePending, false);
});

test("the first thread found in inventory is decoded before it is returned", async (t) => {
  const { host, server, options, directory } = await fixture(t);
  host.close();
  server.threads.clear();
  const empty = new T3CodeHost({ ...options, probeThreadId: undefined });
  t.after(() => empty.close());
  await empty.connect();
  server.threads.set(
    "synthetic-observed",
    threadProjection("synthetic-observed", directory),
  );
  server.controls.threadCoverage = { hasMoreHistory: "true" };
  await assert.rejects(
    empty.listLiveAgents(),
    /subscribeThread\.hasMoreHistory/,
  );
  assert.equal(empty.connected, false);
  assert.match(empty.compatibilityFailure, /subscribeThread\.hasMoreHistory/);
});

test("durable create replay survives reload and refuses changed payload or labels under the same intent", async (t) => {
  const { host, server, options, spec } = await fixture(t);
  const childCreates = () =>
    server.commands.filter(
      (command) => command.type === "delegated_task.request",
    ).length;
  const first = await host.createAgent(spec());
  assert.deepEqual(await host.createAgent(spec()), first);
  assert.equal(childCreates(), 1, "a replayed create sends one child command");
  const commands = server.commands.length;
  host.close();
  const reloaded = new T3CodeHost(options);
  t.after(() => reloaded.close());
  await reloaded.connect();
  assert.deepEqual(await reloaded.createAgent(spec()), first);
  assert.equal(
    server.commands.length,
    commands,
    "a reloaded replay sends nothing",
  );
  // A changed payload under the spent child identity is never sent again: the child
  // the first create made is found by its deterministic id and adopted.
  assert.deepEqual(
    await reloaded.createAgent(spec("launch-intent", "Changed prompt")),
    first,
  );
  assert.equal(childCreates(), 1, "the changed payload is not sent");
  const changed = spec();
  changed.attempt = () => ({
    requestId: "launch-intent",
    prompt: "Synthetic prompt",
    labels: storedT3Labels("worker", {
      taskId: "other-task",
      runId: "worker-run",
    }),
    environment: {},
  });
  await assert.rejects(
    reloaded.createAgent(changed),
    /retained identity changed/,
  );
  assert.equal(childCreates(), 1, "no second child is created");
});

test("follow-ups keep exact text and native target, with no resend after interrupted delivery", async (t) => {
  const { host, server, options, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  await host.sendMessage(created.id, {
    messageId: "follow-up",
    text: "Exact follow-up\nsecond line",
  });
  await host.sendMessage(created.id, {
    messageId: "follow-up",
    text: "Exact follow-up\nsecond line",
  });
  const messages = () =>
    server.commands.filter((command) => command.type === "message.dispatch");
  assert.equal(messages().length, 1);
  assert.equal(messages()[0]!.threadId, created.id);
  assert.equal(messages()[0]!.text, "Exact follow-up\nsecond line");
  await assert.rejects(
    host.sendMessage(created.id, { messageId: "follow-up", text: "Changed" }),
    /payload changed/,
  );
  server.controls.disconnectMutation = true;
  await assert.rejects(
    host.sendMessage(created.id, {
      messageId: "lost-follow-up",
      text: "Uncertain",
    }),
  );
  assert.equal(messages().length, 2);
  const reloaded = new T3CodeHost(options);
  t.after(() => reloaded.close());
  server.controls.disconnectMutation = false;
  await reloaded.connect();
  await assert.rejects(
    reloaded.sendMessage(created.id, {
      messageId: "lost-follow-up",
      text: "Uncertain",
    }),
    /unknown.*not resent/,
  );
  assert.equal(messages().length, 2, "the uncertain follow-up is never resent");
});

test("decoder-formatted defects keep durable diagnostics while remaining unknown after reload", async (t) => {
  const { host, server, spec, options } = await fixture(t);
  const created = await host.createAgent(spec());
  server.controls.postEffectDefect = true;
  await assert.rejects(
    host.sendMessage(created.id, {
      messageId: "schema-refusal",
      text: "Synthetic",
    }),
    (error) => {
      assert.ok(error instanceof HostUnknownDeliveryError);
      assert.deepEqual(error.diagnostic, {
        command: "message.dispatch",
        reason: "schema_missing_key",
      });
      return true;
    },
  );
  assert.equal(host.state.read().intents["schema-refusal"]?.status, "unknown");
  assert.deepEqual(host.state.read().intents["schema-refusal"]?.diagnostic, {
    command: "message.dispatch",
    reason: "schema_missing_key",
  });
  assert.ok(
    server.threads
      .get(created.id)!
      .messages.some(
        (message: { text: string }) => message.text === "Synthetic",
      ),
    "handler performed the effect before the identical defect",
  );
  const sent = server.commands.length;
  server.controls.postEffectDefect = false;
  host.close();
  const reloaded = new T3CodeHost(options);
  t.after(() => reloaded.close());
  await reloaded.connect();
  await assert.rejects(
    reloaded.sendMessage(created.id, {
      messageId: "schema-refusal",
      text: "Synthetic",
    }),
    (error) => {
      assert.ok(error instanceof HostUnknownDeliveryError);
      assert.deepEqual(error.diagnostic, {
        command: "message.dispatch",
        reason: "schema_missing_key",
      });
      assert.match(error.message, /unknown.*not resent.*message.dispatch/);
      return true;
    },
  );
  assert.equal(server.commands.length, sent);
});

test("decoder defects carrying secrets keep neither the value nor the bearer in durable diagnostics", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  server.controls.secretDefect = true;
  // A secret in the decoder's expected-shape position canonicalizes to fixed
  // wording; no location text survives beside it.
  await assert.rejects(
    host.sendMessage(created.id, {
      messageId: "secret-defect",
      text: "Synthetic",
    }),
    (error) => {
      assert.ok(error instanceof HostUnknownDeliveryError);
      assert.deepEqual(error.diagnostic, {
        command: "message.dispatch",
        reason: "schema_expected",
      });
      assert.doesNotMatch(
        `${String(error)} ${JSON.stringify(error)}`,
        /synthetic-secret/,
      );
      return true;
    },
  );
  assert.equal(host.state.read().intents["secret-defect"]?.status, "unknown");
  const durable = JSON.stringify(host.state.read().intents["secret-defect"]);
  assert.doesNotMatch(durable, /synthetic-secret/);
  // A location that names one of our own payload fields is still remote-chosen
  // text: nothing is retained, through the durable intent and the attention.
  server.controls.secretDefect = false;
  server.controls.secretLocationDefect = true;
  await assert.rejects(
    host.sendMessage(created.id, {
      messageId: "secret-location",
      text: "Synthetic",
    }),
    (error) => {
      assert.ok(error instanceof HostUnknownDeliveryError);
      const diagnostic = (error as HostUnknownDeliveryError).diagnostic;
      assert.deepEqual(diagnostic, {
        command: "message.dispatch",
        reason: "schema_missing_key",
      });
      assert.equal(
        "field" in diagnostic,
        false,
        "no location is named, even a known field name",
      );
      assert.doesNotMatch(
        `${String(error)} ${JSON.stringify(error)}`,
        /synthetic_secret/,
      );
      return true;
    },
  );
  const durableLocation = JSON.stringify(
    host.state.read().intents["secret-location"],
  );
  assert.equal(host.state.read().intents["secret-location"]?.status, "unknown");
  assert.doesNotMatch(durableLocation, /synthetic_secret/);
  assert.equal(
    durableLocation.includes('"field"'),
    false,
    "the durable intent carries no location",
  );
});

test("observations distinguish idle, active run, permissions, archived and explicit deletion", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  // The role's own turn ended, as it has when the task moves on.
  p.runs = [];
  assert.equal((await host.observe(created.id)).active, false);
  p.runs = [{ id: "synthetic-run", status: "running", startedAt: STAMP }];
  assert.equal((await host.observe(created.id)).activeTurnId, "synthetic-run");
  assert.equal((await host.observe(created.id)).active, true);
  p.runtimeRequests = [
    {
      id: "approval",
      kind: "command",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: "session" },
    },
  ];
  const pending = await host.observe(created.id);
  assert.equal(pending.permissions, true);
  assert.equal(pending.pendingRequest?.id, "approval");
  await assert.rejects(
    host.stopAgentTurn(created.id, "stale-run-id"),
    (error: unknown) => error instanceof ProvenPreSendRefusalError,
  );
  await host.stopAgentTurn(created.id, "synthetic-run");
  assert.equal((await host.observe(created.id)).active, false);
  await host.archiveAgent(created.id);
  const archivedCommands = server.commands.length;
  await host.archiveAgent(created.id);
  assert.equal(server.commands.length, archivedCommands);
  // An archived thread is retired: terminal closed status, with the archived
  // fact on its own field.
  const retired = await host.observe(created.id);
  assert.equal(retired.status, "closed");
  assert.equal(retired.archived, true);
  assert.ok(
    (await host.archivedThreads()).some((row) => row.id === created.id),
  );
  assert.ok(
    server.requests.some(
      (r) => r.tag === "orchestration.getArchivedShellSnapshot",
    ),
  );
  assert.equal(
    (await host.listLiveAgents()).some((r) => r.id === created.id),
    false,
  );
  // A removed thread has no projection at all: the nightly refuses the read, so
  // observation fails rather than inventing a status (brief v3).
  p.thread.deletedAt = STAMP;
  await assert.rejects(host.observe(created.id), /ThreadNotFound|T3Code/);
  await assert.rejects(host.observe("absent-thread"));
  assert.equal(await host.observationInventory(["absent-thread"]), null);
});

test("empty enrichment snapshots preserve inventory while missing fields and incomplete reads stay unknown", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  server.controls.enrichment = true;
  assert.ok((await host.listLiveAgents()).some((r) => r.id === created.id));
  server.controls.shellMissingField = "activeRunId";
  await assert.rejects(host.observe(created.id), /activeRunId/);
  assert.equal(await host.observationInventory([created.id]), null);
  server.controls.shellMissingField = "";
  // A coverage claim that names more history without saying where it went cannot
  // be used by either read: nothing in it bounds or locates the rest.
  server.controls.incompleteThread = true;
  await assert.rejects(
    host.observe(created.id),
    /hasMoreHistory true with no cursor/,
  );
  // A shape problem names its field through the timeline read too, so the
  // owned-tool reader reports the exact cause instead of `unavailable`.
  await assert.rejects(
    host.agentTimelinePage(created.id),
    /hasMoreHistory true with no cursor/,
  );
  const answers = await host.answeredQuestions(created.id);
  assert.equal(
    answers.ok,
    false,
    "an unreadable bounded snapshot is unknown, never an empty answer list",
  );
  if (!answers.ok)
    assert.match(answers.reason, /hasMoreHistory true with no cursor/);
  server.controls.incompleteThread = false;
  server.controls.synchronized = false;
  await assert.rejects(
    host.observe(created.id),
    (error: T3RpcError) =>
      error instanceof T3RpcError &&
      error.code === "timeout" &&
      /T3Code timeout: orchestration\.subscribeThread/.test(error.message),
  );
  assert.equal(host.connected, true);
  server.controls.synchronized = true;
  assert.ok(
    await host.observe(created.id),
    "a later snapshot uses the same live connection",
  );
});

test("coverage fields are strictly decoded before observation or timeline completeness is claimed", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  server.threads.get(created.id)!.runs = [];
  for (const [field, value] of [
    ["hasMoreHistory", "true"],
    ["hasMoreHistory", 0],
    ["hasMoreHistory", null],
    ["turnItemsOmitLocalVisible", "false"],
    ["historyCursor", 7],
    ["latestLocalTurnOrdinal", "1"],
    ["idTable", false],
  ] as const) {
    server.controls.threadCoverage = { [field]: value };
    await assert.rejects(host.observe(created.id), new RegExp(field));
    await assert.rejects(host.agentTimelinePage(created.id), new RegExp(field));
    assert.equal(await host.observationInventory([created.id]), null);
  }
  server.controls.threadCoverage = {
    hasMoreHistory: false,
    historyCursor: "opaque-history-cursor",
  };
  await assert.rejects(
    host.observe(created.id),
    /hasMoreHistory false with a cursor/,
  );
  server.controls.threadCoverage = {
    hasMoreHistory: false,
    historyCursor: null,
    turnItemsOmitLocalVisible: false,
  };
  assert.equal((await host.observe(created.id)).active, false);
});

test("a host failure refusal names the kind, the code or method, and the message line", () => {
  // The same rule for every host (planner ruling, brief v2): the refusal goes to
  // the task owner about their own local host, so the host's own words are kept.
  assert.equal(
    hostFailureRefusalDetail(
      new T3RpcError("timeout", "orchestration.subscribeThread"),
    ),
    "T3RpcError timeout orchestration.subscribeThread: T3Code timeout: orchestration.subscribeThread",
  );
  assert.equal(
    hostFailureRefusalDetail(
      new T3RpcError(
        "remote",
        "orchestration.subscribeThread",
        "OrchestrationV2GetThreadProjectionError",
      ),
    ),
    "T3RpcError remote orchestration.subscribeThread: T3Code remote: orchestration.subscribeThread (OrchestrationV2GetThreadProjectionError)",
  );
  // A Paseo adapter's own messages appear as they are.
  assert.equal(
    hostFailureRefusalDetail(new Error("Agent was not found")),
    "Error: Agent was not found",
  );
  assert.equal(
    hostFailureRefusalDetail(new Error("Transport timeout")),
    "Error: Transport timeout",
  );
  // A present code or method is kept, whatever its shape: system codes, numeric
  // codes, library codes and non-dotted method names all appear as the host
  // wrote them (no character class decides presence).
  for (const code of [
    "ECONNREFUSED",
    "ENOENT",
    "ETIMEDOUT",
    "ERR_SOCKET_CLOSED",
    "0x80004005",
    "not-found: 42",
    "connect failed badly",
  ])
    assert.equal(
      hostFailureRefusalDetail(
        Object.assign(new Error("connect failed"), { code }),
      ),
      `Error ${code.split("\n")[0]!.trim().slice(0, 80)}: connect failed`,
    );
  for (const code of [404, 500])
    assert.equal(
      hostFailureRefusalDetail(
        Object.assign(new Error("request failed"), { code }),
      ),
      `Error ${code}: request failed`,
    );
  for (const method of [
    "paseo:agent.observe",
    "paseo/observe",
    "Agent.Observe",
  ])
    assert.equal(
      hostFailureRefusalDetail(
        Object.assign(new Error("not sent"), { method }),
      ),
      `Error ${method}: not sent`,
    );
  // Only the first line is kept, and the field is clipped; an absent or empty
  // field contributes nothing.
  assert.equal(
    hostFailureRefusalDetail(
      Object.assign(new Error("not sent"), { code: "E_BIG\ntrace line" }),
    ),
    "Error E_BIG: not sent",
  );
  assert.equal(
    hostFailureRefusalDetail(
      Object.assign(new Error("not sent"), { code: "E".repeat(120) }),
    ),
    `Error ${"E".repeat(80)}: not sent`,
  );
  assert.equal(
    hostFailureRefusalDetail(
      Object.assign(new Error("not sent"), { code: "", method: "   " }),
    ),
    "Error: not sent",
  );
  // One line, clipped to 200 characters.
  assert.equal(
    hostFailureRefusalDetail(new Error('first line\n  at [\"text\"]')),
    "Error: first line",
  );
  assert.equal(
    hostFailureRefusalDetail(new Error("x".repeat(300))),
    `Error: ${"x".repeat(200)}`,
  );
  // A compatibility failure names its adapter-authored field through its message.
  assert.equal(
    hostFailureRefusalDetail(
      new T3CompatibilityError("subscribeThread: incomplete projection"),
    ),
    "T3CompatibilityError: T3Code compatibility check failed: subscribeThread: incomplete projection",
  );
});

test("a thread long enough to page stays observable from the nightly bounded snapshot", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  // A long worker run leaves far more turn items than one snapshot window holds.
  // Every record is the Nightly's own wire shape (contract `wireShapes`): the
  // transport completes and checks them, so no invented partial record is served.
  p.turnItems = Array.from(
    { length: server.controls.boundedRowLimit + 40 },
    (_, index) =>
      syntheticTurnItem(created.id, index + 1, {
        type: "assistant_message",
        text: `Synthetic reply ${index}`,
        ...(index === server.controls.boundedRowLimit + 39
          ? { runId: "synthetic-old-run" }
          : {}),
      }),
  );
  p.runs = [
    syntheticRun(created.id, 1, { id: "synthetic-unreferenced-run" }),
    syntheticRun(created.id, 2, { id: "synthetic-old-run" }),
    syntheticRun(created.id, 3, {
      id: "synthetic-run",
      status: "running",
      completedAt: null,
    }),
  ];
  p.runtimeRequests = [
    syntheticRuntimeRequest({
      id: "synthetic-question",
      kind: "user_input",
      status: "pending",
    }),
  ];
  // The nightly answers a whole projection only to a read that does not opt in,
  // and that read of a thread this long is the slow one: the full snapshot of the
  // reported thread measured 8.1 MiB, and outlived the bound on a busy service.
  server.controls.slowFullSnapshotMs = 1_500;
  const observed = await host.observe(created.id);
  assert.equal(observed.status, "running");
  assert.equal(observed.active, true);
  assert.equal(observed.activeTurnId, "synthetic-run");
  assert.equal(observed.permissions, true);
  assert.equal(observed.pendingRequest?.id, "synthetic-question");
  assert.deepEqual(observed.pendingPermissionKinds, ["question"]);
  const served = server.snapshots
    .filter((snapshot) => snapshot.threadId === created.id)
    .at(-1)!;
  assert.equal(
    served.acceptBoundedSnapshot,
    true,
    "observation asks for the bounded snapshot",
  );
  assert.equal(served.bounded, true);
  assert.equal(
    served.hasMoreHistory,
    true,
    "the answer is the paged window, not the whole transcript",
  );
  assert.equal(typeof served.historyCursor, "string");
  assert.ok(
    served.turnItems < p.turnItems.length,
    "the window drops older turn items",
  );
  // The bounded projection keeps the active run and the run its window
  // references, and drops a settled run the window no longer shows
  // (contract `subscribeThread.projectionRetained.runs`).
  assert.equal(served.runs, 2);
  // The question read comes from the same bounded window: the pending request is
  // carried, so the refusal names the absent item rather than the whole
  // projection (nucleus#1217).
  await assert.rejects(
    host.pendingQuestions(created.id),
    /user_input_request is outside the bounded timeline window/,
  );
});

test("a nightly that ignores the bounded opt-in still observes from its whole projection", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  server.threads.get(created.id)!.runs = [
    syntheticRun(created.id, 1, {
      id: "synthetic-run",
      status: "running",
      completedAt: null,
    }),
  ];
  // An older server drops the unknown field and answers the complete detail
  // projection, so observation degrades to today's read instead of refusing.
  server.controls.ignoreBoundedSnapshot = true;
  const observed = await host.observe(created.id);
  assert.equal(observed.active, true);
  assert.equal(observed.activeTurnId, "synthetic-run");
  const served = server.snapshots
    .filter((snapshot) => snapshot.threadId === created.id)
    .at(-1)!;
  assert.equal(served.acceptBoundedSnapshot, true);
  assert.equal(served.bounded, false);
  assert.equal(served.hasMoreHistory, false);
});

test("a paged window reads tools and questions, and a complete-transcript read still refuses it", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  const at = (offset: number) =>
    new Date(Date.parse(STAMP) + offset * 1_000).toISOString();
  p.turnItems = [
    syntheticTurnItem(created.id, 1, {
      type: "assistant_message",
      runId: "synthetic-run-1",
      updatedAt: at(1),
    }),
    syntheticTurnItem(created.id, 2, {
      type: "assistant_message",
      runId: "synthetic-run-1",
      updatedAt: at(2),
    }),
    syntheticTurnItem(created.id, 3, {
      type: "user_input_request",
      id: "synthetic-question-item",
      requestId: "synthetic-question",
      runId: "synthetic-run-2",
      nodeId: "synthetic-node-synthetic-question",
      updatedAt: at(3),
    }),
  ];
  p.runtimeRequests = [
    syntheticRuntimeRequest({
      id: "synthetic-question",
      kind: "user_input",
      status: "pending",
    }),
  ];
  // A genuine bounded snapshot with older history; tools never reconstruct it.
  server.controls.boundedRowLimit = 2;
  assert.equal(
    (await host.observe(created.id)).pendingRequest?.id,
    "synthetic-question",
  );
  // The bounded window is the read for tools and questions, so a paged answer is
  // no longer unobservable (nucleus#1217).
  assert.deepEqual(await host.pendingQuestions(created.id), [
    {
      requestId: "synthetic-question",
      questions: [
        {
          header: "Synthetic",
          question: "Synthetic question?",
          options: ["Yes", "No"],
        },
      ],
    },
  ]);
  const page = await host.agentTimelinePage(created.id, 2);
  assert.equal(page?.hasOlder, true);
  assert.deepEqual(
    page?.entries.map((entry) => entry.turnId),
    ["synthetic-run-1", "synthetic-run-2"],
  );
  p.runtimeRequests[0].status = "resolved";
  p.runtimeRequests[0].answers = { choice: "Yes" };
  assert.deepEqual(await host.answeredQuestions(created.id), {
    ok: true,
    answered: [
      {
        requestId: "synthetic-question",
        question: "Synthetic question?",
        answers: { choice: "Yes" },
      },
    ],
  });
  // A read that needs the complete transcript still refuses the same projection.
  await assert.rejects(
    host.readProjection(created.id, "transcript"),
    /subscribeThread: incomplete projection/,
  );
  const read = server.requests
    .filter((request) => request.tag === "orchestration.subscribeThread")
    .at(-1)!.payload as Record<string, unknown>;
  assert.equal(
    read.acceptBoundedSnapshot,
    true,
    "no read asks for the unbounded snapshot",
  );
});

test("history exceeding the frame limit is observed, listed and titled without any full snapshot read", async (t) => {
  const { host, server, spec, workspace } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  // Nightly wire records duplicate item bodies in visibleTurnItems. The full
  // reply exceeds 16 MiB; a 20-row window stays well below it.
  p.turnItems = Array.from({ length: 200 }, (_, index) =>
    syntheticTurnItem(created.id, index + 1, {
      text: "Synthetic history ".repeat(3_000),
    }),
  );
  p.runs = [syntheticRun(created.id, 1)];
  const frameLimit = 16 * 1024 * 1024;
  assert.ok(server.fullSnapshotBytes(created.id) > frameLimit);
  const start = server.requests.length;
  assert.equal((await host.observe(created.id)).active, false);
  assert.ok(
    (await host.listLiveAgents()).some((agent) => agent.id === created.id),
  );
  const wt = await host.workspaceThreads([workspace.id]);
  assert.equal(wt.ok, true);
  assert.ok(wt.ok && wt.threads.some((thread) => thread.id === created.id));
  assert.ok(await host.originAgent(created.id));
  const task = {
    id: "synthetic-task",
    number: 225,
    title: "Synthetic role",
    held: false,
    hostId: host.hostId,
    workspaceId: created.workspaceId,
    runId: "worker-run",
    phase: "working",
  } as Task;
  await host.setTaskWorkspaceTitle(
    task,
    "225: Bounded title",
    "bounded-title",
    false,
  );
  const row = Object.values(host.state.read().parents ?? {})[0]!;
  assert.equal(
    server.threads.get(row.threadId)!.thread.title,
    "225: Bounded title",
    "the task row carries the bounded title, not the role child",
  );
  // The question and timeline reads come from the bounded window too: no pending
  // request is carried here, and the window is a page rather than null.
  assert.deepEqual(await host.pendingQuestions(created.id), []);
  assert.deepEqual(await host.answeredQuestions(created.id), {
    ok: true,
    answered: [],
  });
  const page = await host.agentTimelinePage(created.id);
  assert.ok(
    page && page.entries.length > 0,
    "the newest window is readable on a thread over the frame limit",
  );
  assert.equal(page.hasOlder, true);
  assert.equal(page.hasNewer, false);
  assert.equal(page.projection, "bounded");
  const reads = server.requests
    .slice(start)
    .filter((request) => request.tag === "orchestration.subscribeThread");
  assert.ok(
    reads.length >= 1,
    "the row and the readers share the bounded read",
  );
  assert.ok(
    reads.every((request) => request.payload.acceptBoundedSnapshot === true),
  );
  assert.ok(
    server.frameBytes.every((bytes) => bytes < frameLimit),
    "no actual reply crosses the frame limit",
  );
  assert.equal(host.connected, true);
});

test("a long thread reads its newest native tool calls from the bounded timeline window", async (t) => {
  // nucleus#1217 item 1: the owned-tool read must work on a thread whose full
  // snapshot exceeds the frame limit, and a native tool record in the window must
  // be judged rather than passed through and ignored. The full projection of this
  // thread is over 16 MiB; the nightly's newest window stays inside its row
  // budget. `command_execution` is the nightly's own recorded execution record.
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  const count = 400;
  p.turnItems = longThreadItems(created.id, count, (index) =>
    index === count - 2
      ? {
          type: "command_execution",
          status: "completed",
          input: "synthetic settled command",
          exitCode: 0,
        }
      : index === count - 1
        ? {
            type: "command_execution",
            status: "running",
            input: "synthetic long command",
          }
        : {
            type: "assistant_message",
            text: "Synthetic history ".repeat(1_200),
          },
  );
  // The newest window reaches back into an earlier run, so a partial page proves
  // which turn it starts in (one T3 run is one provider turn).
  p.runs = [
    syntheticRun(created.id, 1, { id: "synthetic-run-1" }),
    syntheticRun(created.id, 2, {
      id: "synthetic-run-2",
      status: "running",
      completedAt: null,
    }),
  ];
  const frameLimit = 16 * 1024 * 1024;
  assert.ok(
    server.fullSnapshotBytes(created.id) > frameLimit,
    "the full snapshot exceeds the frame limit",
  );
  const start = server.requests.length;
  const read = await readToolTimeline(host, created.id);
  assert.ok(
    "entries" in read,
    `the bounded window supplies tool evidence: ${JSON.stringify(read)}`,
  );
  assert.ok(read.entries.length > 0);
  const newest = read.entries.at(-1)!.item;
  assert.equal(
    newest.type,
    "tool_call",
    "the newest native execution is tool evidence",
  );
  assert.equal(newest.name, "command_execution");
  assert.equal(newest.status, "running");
  assert.deepEqual(newest.detail, {
    type: "shell",
    command: "synthetic long command",
    nativeType: "command_execution",
  });
  // A live tool in the window is still detected.
  const live = liveToolIssueFact(read.entries);
  assert.equal(live?.kind, "live");
  assert.equal(
    live && "callId" in live ? live.callId : null,
    p.turnItems.at(-1)!.id,
  );
  // The settled native command in the same window is not live evidence.
  assert.equal(
    liveToolIssueFact(
      read.entries.filter(
        (entry) => entry.item.callId !== p.turnItems.at(-1)!.id,
      ),
    ),
    null,
  );
  const reads = server.requests
    .slice(start)
    .filter((request) => request.tag === "orchestration.subscribeThread");
  assert.ok(reads.length >= 1);
  assert.ok(
    reads.every((request) => request.payload.acceptBoundedSnapshot === true),
    "every read asks for the bounded snapshot",
  );
  assert.ok(
    server.frameBytes.every((bytes) => bytes < frameLimit),
    "no actual reply crosses the frame limit",
  );
  // The page describes the window it read, not a full history.
  const page = (await host.agentTimelinePage(created.id))!;
  assert.equal(page.hasOlder, true);
  assert.equal(page.hasNewer, false);
  assert.equal(page.gap, false);
  assert.equal(page.reset, false);
  assert.equal(page.staleCursor, false);
  assert.equal(page.projection, "bounded");
  assert.equal(page.epoch, created.id);
  assert.equal(page.startCursor?.seq, count - page.entries.length + 1);
  assert.equal(page.endCursor?.seq, count);
  assert.equal(host.connected, true);
});

test("native tool evidence is judged by its own kind and state, never ignored", async (t) => {
  // nucleus#1217 finding 1: a real running command must read as live evidence. A
  // native state the reader does not know is never settled, and only a kind that
  // cannot outlive its turn may be settled by a finished turn.
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.runs = [syntheticRun(created.id, 1, { id: "synthetic-run-1" })];
  const message = syntheticTurnItem(created.id, 1, {
    type: "user_message",
    runId: "synthetic-run-1",
    messageId: "synthetic-message",
    text: "go",
  });
  const native = (overrides: Record<string, unknown>) =>
    syntheticTurnItem(created.id, 2, {
      runId: "synthetic-run-1",
      ...overrides,
    });
  p.turnItems = [
    message,
    native({
      type: "command_execution",
      status: "waiting",
      input: "synthetic waiting command",
    }),
  ];
  const owner = await observedTurnState(host, created.id);
  assert.equal(owner?.active, false, "the run has finished");
  const page = (await host.agentTimelinePage(created.id))!;
  assert.deepEqual(
    page.entries.map((entry) => entry.item.type),
    ["user_message", "tool_call"],
  );
  // An unrecognised native state is not terminal: the hold stays.
  const waiting = liveToolIssueFact(page.entries, owner);
  assert.equal(waiting?.kind, "live");
  assert.equal(
    waiting && "status" in waiting ? waiting.status : null,
    "waiting",
  );
  // A finished turn settles a turn-bound native edit, but never a detached command.
  p.turnItems = [
    message,
    native({
      type: "file_change",
      status: "running",
      fileName: "synthetic.ts",
    }),
  ];
  const edit = (await host.agentTimelinePage(created.id))!;
  assert.equal(edit.entries[1]!.item.detail?.type, "edit");
  assert.equal(
    liveToolIssueFact(edit.entries, owner),
    null,
    "a turn-bound edit ends with its turn",
  );
  assert.equal(
    liveToolIssueFact(edit.entries)?.kind,
    "live",
    "without the turn proof it is still live",
  );
  p.turnItems = [
    message,
    native({
      type: "command_execution",
      status: "running",
      input: "synthetic waiting command",
    }),
  ];
  const command = (await host.agentTimelinePage(created.id))!;
  assert.equal(
    liveToolIssueFact(command.entries, owner)?.kind,
    "live",
    "a detached command is not settled by a finished turn",
  );
  p.turnItems = [
    message,
    native({
      type: "dynamic_tool",
      status: "running",
      title: "nucleus_report",
      toolName: "synthetic-tool",
      input: {},
    }),
  ];
  const dynamic = (await host.agentTimelinePage(created.id))!;
  assert.equal(
    liveToolIssueFact(dynamic.entries, owner)?.kind,
    "live",
    "a native background tool title never implies it is turn-bound",
  );
});

test("a retained request outside the window never manufactures a turn boundary", async (t) => {
  // nucleus#1217 finding: a bounded projection also carries the request item it
  // retained from outside the window. Reading `turnItems` would put that old row
  // beside a partial newest run, hand the shared reader a false turn boundary, and
  // accept the page while a live tool sits in the missing part of the live turn.
  // The older live command is outside the first requested page and must refuse.
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  const rows = 400;
  p.turnItems = longThreadItems(created.id, rows, () => ({
    type: "assistant_message",
    runId: "synthetic-run-2",
  }));
  // Run one's pending question is retained; run two's live command is older than
  // the window. The process signal, not reconstructed history, covers it.
  p.turnItems[0] = syntheticTurnItem(created.id, 1, {
    type: "user_input_request",
    id: "synthetic-question-item",
    nodeId: "synthetic-question-node",
    requestId: "synthetic-question",
    runId: "synthetic-run-1",
    updatedAt: p.turnItems[0]!.updatedAt,
    questions: [
      {
        id: "synthetic-choice",
        header: "Choice",
        question: "Pick one",
        options: [{ label: "A" }],
      },
    ],
  });
  p.turnItems[2] = syntheticTurnItem(created.id, 3, {
    type: "command_execution",
    id: "synthetic-live-command",
    runId: "synthetic-run-2",
    updatedAt: p.turnItems[2]!.updatedAt,
    status: "running",
    input: "synthetic live command",
  });
  p.runtimeRequests = [
    syntheticRuntimeRequest({
      id: "synthetic-question",
      kind: "user_input",
      status: "pending",
      nodeId: "synthetic-question-node",
    }),
  ];
  p.runs = [
    syntheticRun(created.id, 1, { id: "synthetic-run-1" }),
    syntheticRun(created.id, 2, {
      id: "synthetic-run-2",
      status: "running",
      completedAt: null,
    }),
  ];
  // The question read still sees the item the nightly retained for it.
  assert.deepEqual(await host.pendingQuestions(created.id), [
    {
      requestId: "synthetic-question",
      questions: [{ header: "Choice", question: "Pick one", options: ["A"] }],
    },
  ]);
  // The page is the nightly's own visible window (and the bounded history pages it
  // widens through), never the retained row: no earlier-run boundary is claimed
  // while the live turn is only partly covered.
  const page = (await host.agentTimelinePage(
    created.id,
    server.controls.boundedRowLimit,
  ))!;
  assert.equal(
    page.entries.some(
      (entry) => entry.item.callId === "synthetic-live-command",
    ),
    false,
  );
  assert.equal(
    page.entries.some((entry) => entry.item.id === "synthetic-question-item"),
    false,
  );
  assert.ok(page.entries.every((entry) => entry.turnId === "synthetic-run-2"));
  const read = await readToolTimeline(host, created.id);
  assert.ok("entries" in read);
  assert.equal(
    read.coverage,
    "bounded",
    "this is a window, never claimed turn coverage",
  );
});

test("a native background subagent is never settled by its finished parent turn", async (t) => {
  // nucleus#1217 finding 1: the nightly's own BACKGROUND_TURN_ITEM_TYPES keeps
  // subagents as background work that may stay pending after a settled run, so a
  // finished parent observation never clears a running child.
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.runs = [syntheticRun(created.id, 1, { id: "synthetic-run-1" })];
  p.turnItems = [
    syntheticTurnItem(created.id, 1, {
      type: "user_message",
      runId: "synthetic-run-1",
      messageId: "synthetic-message",
      text: "go",
    }),
    syntheticTurnItem(created.id, 2, {
      type: "subagent",
      runId: "synthetic-run-1",
      status: "running",
      subagentId: "synthetic-subagent",
      origin: "provider_native",
      driver: "codex",
      providerInstanceId: "synthetic-provider",
      childThreadId: null,
      prompt: "Synthetic child task",
      result: null,
    }),
  ];
  const owner = await observedTurnState(host, created.id);
  assert.equal(owner?.active, false, "the parent run has finished");
  const page = (await host.agentTimelinePage(created.id))!;
  const child = page.entries[1]!.item;
  assert.equal(child.type, "tool_call");
  assert.equal(child.detail?.type, "subagent");
  // A finished turn never settles the running child.
  const issue = liveToolIssueFact(page.entries, owner);
  assert.equal(issue?.kind, "live");
  assert.equal(
    issue && "callId" in issue ? issue.callId : null,
    p.turnItems[1]!.id,
  );
  assert.equal(issue && "turnBound" in issue ? issue.turnBound : null, false);
  // A completed child is terminal evidence and settles.
  p.turnItems[1] = syntheticTurnItem(created.id, 2, {
    type: "subagent",
    runId: "synthetic-run-1",
    status: "completed",
    subagentId: "synthetic-subagent",
    origin: "provider_native",
    driver: "codex",
    providerInstanceId: "synthetic-provider",
    childThreadId: null,
    prompt: "Synthetic child task",
    result: "done",
  });
  assert.equal(
    liveToolIssueFact(
      (await host.agentTimelinePage(created.id))!.entries,
      owner,
    ),
    null,
  );
});

test("bounded provider threads retain active work and omit older idle owners honestly", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.turnItems = longThreadItems(created.id, 60, () => ({}));
  p.providerThreads = [
    syntheticProviderThread({
      id: "synthetic-idle-owner",
      pendingBackgroundTasks: [
        { kind: "subagent", taskId: "synthetic-hidden-child" },
      ],
    }),
    syntheticProviderThread({
      id: "synthetic-active-owner",
      status: "active",
      pendingBackgroundTasks: [
        { kind: "subagent", taskId: "synthetic-active-child" },
      ],
    }),
  ];
  const projection = await host.readProjection(created.id, "window");
  assert.deepEqual(
    projection.providerThreads?.map((thread) => thread.id),
    ["synthetic-active-owner"],
  );
  const read = await readToolTimeline(host, created.id);
  assert.ok("entries" in read && read.coverage === "bounded");
  assert.deepEqual(read.pendingBackgroundTasks, [
    "subagent synthetic-active-child",
  ]);
  p.providerThreads = [p.providerThreads[0]];
  const omitted = await readToolTimeline(host, created.id);
  assert.ok("entries" in omitted && omitted.coverage === "bounded");
  assert.deepEqual(
    omitted.pendingBackgroundTasks,
    [],
    "idle internal work outside the window is the documented T3 limitation",
  );
});

test("a pending question on a long thread reads from the bounded timeline window", async (t) => {
  // nucleus#1217 item 2: the nightly keeps every pending runtime request and the
  // `user_input_request` item that carries its questions outside the window, so a
  // long thread's pending question is readable without the full transcript.
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  const count = server.controls.boundedRowLimit + 40;
  p.turnItems = longThreadItems(created.id, count, (index) =>
    index === 0
      ? {
          type: "user_input_request",
          id: "synthetic-question-item",
          nodeId: "synthetic-question-node",
          requestId: "synthetic-question",
          questions: [
            {
              id: "synthetic-choice",
              header: "Choice",
              question: "Pick one",
              options: [{ label: "A" }, { label: "B" }],
            },
          ],
        }
      : {},
  );
  p.runtimeRequests = [
    syntheticRuntimeRequest({
      id: "synthetic-question",
      kind: "user_input",
      status: "pending",
      nodeId: "synthetic-question-node",
    }),
  ];
  const start = server.requests.length;
  assert.deepEqual(await host.pendingQuestions(created.id), [
    {
      requestId: "synthetic-question",
      questions: [
        { header: "Choice", question: "Pick one", options: ["A", "B"] },
      ],
    },
  ]);
  const reads = server.requests
    .slice(start)
    .filter((request) => request.tag === "orchestration.subscribeThread");
  assert.equal(reads.length, 1, "one bounded read answers the question");
  assert.equal(reads[0]!.payload.acceptBoundedSnapshot, true);
  const served = server.snapshots.at(-1)!;
  assert.equal(served.bounded, true);
  assert.equal(
    served.hasMoreHistory,
    true,
    "the question came from a paged window, not the whole transcript",
  );
});

test("inventory repeats moving live/archive snapshot pairs and succeeds when the sequence settles", async (t) => {
  const { host, server, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  let movingReads = 0;
  server.controls.beforeArchiveRead = () => {
    if (movingReads++ < 2) server.controls.snapshotSequence++;
  };
  assert.ok(
    (await host.listLiveAgents()).some((agent) => agent.id === created.id),
  );
  assert.ok(
    (await host.activeThreads()).some((agent) => agent.id === created.id),
  );
  assert.equal(
    movingReads,
    0,
    "live-only reads use the atomic shell without touching archived snapshots",
  );
  const archiveInventory = await host.workspaceThreads([workspace.id]);
  assert.equal(archiveInventory.ok, true);
  assert.ok(
    archiveInventory.ok &&
      archiveInventory.threads.some((agent) => agent.id === created.id),
  );
  assert.equal(
    movingReads,
    3,
    "two mismatched pairs are followed by the consistent third pair",
  );
});

test("inventory refuses an unstable snapshot after the bounded number of read pairs", async (t) => {
  const { host, server, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  server.controls.beforeArchiveRead = () => {
    server.controls.snapshotSequence++;
  };
  // Live observation and catalog/workspace project reads succeed with 0 archive reads.
  assert.ok(
    (await host.listLiveAgents()).some((agent) => agent.id === created.id),
  );
  assert.ok((await host.observe(created.id)).id === created.id);
  assert.equal(await host.workspaceAvailable(workspace.id), true);

  const shellReads = server.requests.filter(
    (request) => request.tag === "orchestration.subscribeShell",
  ).length;
  const archiveReads = server.requests.filter(
    (request) => request.tag === "orchestration.getArchivedShellSnapshot",
  ).length;
  await assert.rejects(
    host.reads.threadArchiveState(created.id),
    (error: unknown) =>
      error instanceof T3InventoryChurnError &&
      !(error instanceof T3CompatibilityError) &&
      /inventory kept moving.*5 attempts/.test(error.message),
  );
  assert.equal(
    server.requests.filter(
      (request) => request.tag === "orchestration.subscribeShell",
    ).length - shellReads,
    5,
  );
  assert.equal(
    server.requests.filter(
      (request) => request.tag === "orchestration.getArchivedShellSnapshot",
    ).length - archiveReads,
    5,
  );
});

test("questions and approvals answer exact runtime requests and refuse wrong kinds or workspaces", async (t) => {
  const { host, server, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.runtimeRequests = [
    {
      id: "question-request",
      nodeId: "synthetic-question-node",
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: "session" },
    },
    {
      id: "approval-request",
      kind: "command",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: "session" },
    },
  ];
  // Nightly retains resolved requests through the window's node/provider-turn
  // links. A question item and its request must describe the same node.
  p.turnItems = [
    {
      id: "question-item",
      nodeId: "synthetic-question-node",
      type: "user_input_request",
      requestId: "question-request",
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Pick one",
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    },
  ];
  assert.deepEqual(await host.pendingQuestions(created.id), [
    {
      requestId: "question-request",
      questions: [
        { header: "Choice", question: "Pick one", options: ["A", "B"] },
      ],
    },
  ]);
  await assert.rejects(
    host.respondRuntimeRequest(
      created.id,
      workspace.id,
      "question-request",
      { decision: "accept" },
      "invalid-question-kind",
    ),
    /kind/,
  );
  await assert.rejects(
    host.respondRuntimeRequest(
      created.id,
      "other-workspace",
      "question-request",
      { answers: { choice: "A" } },
      "invalid-question-workspace",
    ),
    /workspace/,
  );
  await host.answerNativeQuestion(
    created.id,
    workspace.id,
    "question-request",
    { choice: "A" },
  );
  p.runtimeRequests.push({
    id: "cancel-request",
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "session" },
  });
  await host.respondRuntimeRequest(created.id, workspace.id, "cancel-request", {
    decision: "cancel",
  });
  await host.respondRuntimeRequest(
    created.id,
    workspace.id,
    "approval-request",
    { decision: "accept" },
  );
  const responses = server.commands.filter(
    (command) => command.type === "runtime-request.respond",
  );
  assert.equal(responses.length, 3);
  assert.equal(responses[0]!.requestId, "question-request");
  assert.deepEqual(responses[0]!.answers, { choice: ["A"] });
  assert.equal(responses[1]!.requestId, "cancel-request");
  assert.equal(responses[1]!.decision, "cancel");
  assert.equal(
    p.runtimeRequests.find(
      (request: { id: string }) => request.id === "cancel-request",
    )!.status,
    "resolved",
  );
  assert.equal(responses[2]!.requestId, "approval-request");
  assert.equal(responses[2]!.decision, "accept");
  const answeredRead = await host.answeredQuestions(created.id);
  assert.ok(answeredRead.ok);
  assert.equal(answeredRead.answered[0]?.requestId, "question-request");
  p.runtimeRequests.push({
    id: "unknown-request",
    kind: "future-request-kind",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "session" },
  });
  await assert.rejects(
    host.respondRuntimeRequest(created.id, workspace.id, "unknown-request", {
      decision: "accept",
    }),
    /unsupported/,
  );
});

test("question answer and dismissal inspect an uncertain original response before native status or a new intent", async (t) => {
  const { host, server, options, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.runtimeRequests = [
    {
      id: "lost-question",
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: "session" },
    },
  ];
  p.turnItems = [
    {
      id: "question-item",
      type: "user_input_request",
      requestId: "lost-question",
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Pick one",
          options: [{ label: "A" }],
        },
      ],
    },
  ];
  server.controls.disconnectAfterEffect = true;
  await assert.rejects(
    host.answerNativeQuestion(created.id, workspace.id, "lost-question", {
      Choice: "A",
    }),
  );
  assert.equal(p.runtimeRequests[0].status, "resolved");
  server.controls.disconnectAfterEffect = false;
  host.close();
  const reloaded = new T3CodeHost(options);
  t.after(() => reloaded.close());
  await reloaded.connect();
  const reads = server.requests.length,
    writes = server.commands.length;
  const unknown = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof ProvenPreSendRefusalError, false);
    assert.match(error.message, /unknown.*not resent/);
    return true;
  };
  await assert.rejects(
    reloaded.answerNativeQuestion(created.id, workspace.id, "lost-question", {
      Choice: "A",
    }),
    unknown,
  );
  await assert.rejects(
    reloaded.dismissNativeQuestion(created.id, workspace.id, "lost-question"),
    unknown,
  );
  await assert.rejects(
    reloaded.respondRuntimeRequest(
      created.id,
      workspace.id,
      "lost-question",
      { answers: { choice: ["B"] } },
      "replacement-question-intent",
    ),
    unknown,
  );
  assert.equal(server.requests.length, reads);
  assert.equal(server.commands.length, writes);
});

test("restart preserves message-answerable questions and refuses expired approvals without an extra message", async (t) => {
  const { host, server, options, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.runtimeRequests = [
    {
      id: "restart-question",
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
    },
    {
      id: "expired-approval",
      kind: "command",
      status: "expired",
      responseCapability: { type: "not_resumable", reason: "Server restarted" },
    },
  ];
  p.turnItems = [
    {
      id: "question-item",
      type: "user_input_request",
      requestId: "restart-question",
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Pick one",
          options: [{ label: "A" }],
        },
      ],
    },
  ];
  host.close();
  const reloaded = new T3CodeHost(options);
  t.after(() => reloaded.close());
  await reloaded.connect();
  await reloaded.answerNativeQuestion(
    created.id,
    workspace.id,
    "restart-question",
    { choice: "A" },
  );
  await assert.rejects(
    reloaded.respondRuntimeRequest(
      created.id,
      workspace.id,
      "expired-approval",
      { decision: "accept" },
    ),
    /no longer answerable/,
  );
  assert.equal(
    server.commands.filter(
      (command) => command.type === "runtime-request.respond",
    ).length,
    1,
  );
  assert.equal(
    server.commands.filter((command) => command.type === "message.dispatch")
      .length,
    0,
  );
});

test("creation evaluates its launch guard before building the attempt", async (t) => {
  const { host, server, spec } = await fixture(t);
  const guarded = spec();
  guarded.guard = {
    async allowed() {
      return false;
    },
    stillAllowed() {
      assert.fail("guard already refused");
    },
  };
  guarded.attempt = () =>
    assert.fail("a refused guard must not build an attempt");
  await assert.rejects(host.createAgent(guarded), /launch guard refused/);
  assert.equal(server.commands.length, 0);
});

test("guarded sends preserve final synchronous fences and block changed guards before any write", async (t) => {
  const { host, server, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  server.threads.get(created.id)!.runs = [];
  const order: string[] = [];
  server.controls.mutationObserver = () => {
    order.push("native");
  };
  const input = {
    messageId: "guarded",
    text: "Guarded message",
    expectedWorkspaceId: workspace.id,
  };
  assert.deepEqual(
    await host.sendGuarded(created.id, input, {
      async allowed() {
        await Promise.resolve();
        order.push("allowed");
        return true;
      },
      stillAllowed() {
        order.push("stillAllowed");
        return true;
      },
      beforeSend() {
        order.push("beforeSend");
      },
    }),
    { sent: true },
  );
  assert.deepEqual(order.slice(0, 4), [
    "allowed",
    "stillAllowed",
    "beforeSend",
    "native",
  ]);
  const count = server.commands.length;
  await assert.rejects(
    host.sendGuarded(
      created.id,
      { ...input, messageId: "changed-guard" },
      {
        async allowed() {
          return true;
        },
        stillAllowed() {
          return false;
        },
      },
    ),
    ProvenPreSendRefusalError,
  );
  assert.equal(server.commands.length, count);
  assert.equal(
    (
      await host.sendGuarded(
        created.id,
        {
          ...input,
          messageId: "wrong-workspace",
          expectedWorkspaceId: "foreign",
        },
        {
          async allowed() {
            assert.fail("wrong workspace must refuse before allowed");
          },
          stillAllowed() {
            return true;
          },
        },
      )
    ).sent,
    false,
  );
});

test("host identity conflicts and unsupported per-thread bindings refuse before mutation", async (t) => {
  const { host, server, options, workspace, spec, root } = await fixture(t);
  const mcp = spec();
  mcp.mcpBindingPath = "synthetic-binding";
  await assert.rejects(host.createAgent(mcp), /MCP reporting/);
  const environment = spec();
  environment.attempt = () => ({
    requestId: "environment",
    prompt: "Synthetic",
    labels: storedT3Labels("worker", { runId: "worker-run" }),
    environment: { SYNTHETIC: "value" },
  });
  await assert.rejects(host.createAgent(environment), /launch environment/);
  const guarded = spec();
  guarded.guard = {
    async allowed() {
      return true;
    },
    stillAllowed() {
      return false;
    },
  };
  await assert.rejects(host.createAgent(guarded), /guard changed/);
  await assert.rejects(
    host.raiseDecision("synthetic-probe", workspace.id, {
      id: "decision",
      question: "Synthetic",
      options: [],
      signal: new AbortController().signal,
    }),
    /decisions/,
  );
  assert.equal(server.commands.length, 0);
  const absent = join(root, "missing");
  mkdirSync(absent);
  await assert.rejects(
    host.createWorkspace({
      title: "Unknown project",
      requestId: "unknown",
      directory: absent,
      project: { projectId: "absent-project" },
    }),
    (error) => {
      assert.match(String(error), /T3Code cannot create a project for/);
      assert.ok(
        String(error).includes(absent),
        "the refusal names the repository path",
      );
      assert.match(
        String(error),
        /add that folder as a project in T3Code, then restart the task/,
      );
      return true;
    },
  );
  host.close();
  server.controls.environmentId = "different-environment";
  const changed = new T3CodeHost(options);
  t.after(() => changed.close());
  await assert.rejects(changed.connect(), /environmentId changed/);
  assert.equal(changed.connected, false);
  assert.equal(server.commands.length, 0);
});

test("the origin read answers authoritative absence, and only an unread inventory is unknown", async (t) => {
  const { host, server, workspace, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  assert.deepEqual(await host.originAgent(created.id), {
    id: created.id,
    workspaceId: workspace.id,
    title: "225: Synthetic role",
    archived: false,
    deleted: false,
  });
  // T3 has no such thread: a complete shell plus archive read proves absence, so
  // the lookup answers not-mine instead of throwing.
  assert.equal(await host.originAgent("native-id-t3-does-not-have"), null);
  // A projection whose coverage claim is unusable proves nothing about the thread.
  server.controls.incompleteThread = true;
  await assert.rejects(
    host.originAgent(created.id),
    /hasMoreHistory true with no cursor/,
  );
  server.controls.incompleteThread = false;
  // A read that cannot run at all is a failed read, never authoritatively absent.
  host.close();
  await assert.rejects(
    host.originAgent(created.id),
    /authenticated host connection/,
  );
});

test("an external T3 project thread has a project-scoped origin location without a Nucleus workspace", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const native = server.threads.get(created.id)!;
  native.thread.worktreePath = "/synthetic/external-project-path";
  const origin = await host.originAgent(created.id);
  assert.equal(origin?.workspaceId, `t3-project:${native.thread.projectId}`);
});

test("workspace creation registers a missing repository project once through the nightly projects.mutate route", async (t) => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  mkdirSync(repository);
  mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  assert.equal(project.workspaceRoot, await realpath(repository));
  const workspace = await host.createWorkspace({
    title: "Synthetic task",
    requestId: "workspace-create",
    directory: worktree,
    project,
  });
  const creation = server.commands.find(
    (command) => command.method === "projects.mutate",
  );
  assert.ok(creation, "projects.mutate carried the project.create mutation");
  assert.equal(creation!.type, "project.create");
  for (const field of [
    "type",
    "commandId",
    "projectId",
    "title",
    "workspaceRoot",
  ])
    assert.ok(Object.hasOwn(creation!, field), field);
  assert.equal(
    server.commands.filter(
      (command) =>
        command.method === "orchestration.dispatchCommand" &&
        command.type === "project.create",
    ).length,
    0,
    "the nightly dispatch union has no project.create; registration never rides it",
  );
  assert.equal(creation!.workspaceRoot, await realpath(repository));
  assert.equal(creation!.title, "repository");
  assert.equal(server.projects.length, 1);
  assert.equal(server.projects[0]!.id, creation!.projectId);
  const workspaceRef = host.workspaceRef(workspace.id);
  assert.equal(await workspaceRef.refresh(), true);
  assert.equal(workspaceRef.current()?.projectId, creation!.projectId);
  await host.createWorkspace({
    title: "Retry",
    requestId: "workspace-create-again",
    directory: worktree,
    project,
  });
  assert.equal(
    server.commands.filter((command) => command.method === "projects.mutate")
      .length,
    1,
    "the same root is not duplicated",
  );
});

test("unknown project creation delivery is reconciled from inventory before retry", async (t) => {
  const { host, server, options, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  mkdirSync(repository);
  mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.disconnectAfterEffect = true;
  await assert.rejects(
    host.createWorkspace({
      title: "Synthetic task",
      requestId: "workspace-lost",
      directory: worktree,
      project,
    }),
    /unknown/i,
  );
  assert.equal(
    server.commands.filter((command) => command.method === "projects.mutate")
      .length,
    1,
  );
  host.close();
  server.controls.disconnectAfterEffect = false;
  const reloaded = new T3CodeHost(options);
  t.after(() => reloaded.close());
  await reloaded.connect();
  const workspace = await reloaded.createWorkspace({
    title: "Synthetic task",
    requestId: "workspace-lost",
    directory: worktree,
    project,
  });
  const workspaceRef = reloaded.workspaceRef(workspace.id);
  await workspaceRef.refresh();
  assert.equal(workspaceRef.current()?.projectId, server.projects[0]!.id);
  assert.equal(
    server.commands.filter((command) => command.method === "projects.mutate")
      .length,
    1,
    "inventory adoption avoids a second create",
  );
});

test("a lost registration resends once with its recorded command id after the inventory re-read", async (t) => {
  const { host, server, options, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  mkdirSync(repository);
  mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.disconnectMutation = true;
  await assert.rejects(
    host.createWorkspace({
      title: "Synthetic task",
      requestId: "workspace-lost",
      directory: worktree,
      project,
    }),
  );
  const lost = server.commands.filter(
    (command) => command.method === "projects.mutate",
  );
  assert.equal(lost.length, 1);
  assert.equal(server.projects.length, 0, "the lost request created nothing");
  host.close();
  server.controls.disconnectMutation = false;
  const reloaded = new T3CodeHost(options);
  t.after(() => reloaded.close());
  await reloaded.connect();
  const workspace = await reloaded.createWorkspace({
    title: "Synthetic task",
    requestId: "workspace-lost",
    directory: worktree,
    project,
  });
  assert.equal(workspace.directory, await realpath(worktree));
  const sent = server.commands.filter(
    (command) => command.method === "projects.mutate",
  );
  assert.equal(
    sent.length,
    2,
    "the re-read found no project, so the recorded create resent exactly once",
  );
  assert.equal(
    sent[0]!.commandId,
    sent[1]!.commandId,
    "the resend uses the recorded command id, so the receipt keeps it idempotent",
  );
  assert.equal(sent[0]!.projectId, sent[1]!.projectId);
  assert.equal(server.projects.length, 1);
  assert.equal(await reloaded.workspaceRef(workspace.id).refresh(), true);
});

test("an unsupported registration method stays unknown delivery while naming the manual project setup", async (t) => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  mkdirSync(repository);
  mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.unsupportedProjectCreate = true;
  await assert.rejects(
    host.createWorkspace({
      title: "Synthetic task",
      requestId: "workspace-unsupported",
      directory: worktree,
      project,
    }),
    (error) => {
      assert.ok(
        error instanceof HostUnknownDeliveryError,
        "remote unknown-method text is not a proven pre-send refusal",
      );
      assert.ok(String(error).includes(project.workspaceRoot!));
      assert.match(
        String(error),
        /guidance T3Code cannot create a project for/,
      );
      assert.match(
        String(error),
        /add that folder as a project in T3Code, then restart the task/,
      );
      assert.match(String(error), /unknown.*not resent/);
      return true;
    },
  );
  const key = Object.keys(host.state.read().intents).find((candidate) =>
    candidate.startsWith("nucleus-project-create-"),
  )!;
  const intent = host.state.read().intents[key];
  assert.equal(
    intent?.status,
    "unknown",
    "the create is never marked refused on remote text",
  );
  assert.equal(intent?.diagnostic?.reason, "unknown_request_tag");
  assert.equal(
    intent?.diagnostic?.guidance,
    `T3Code cannot create a project for ${project.workspaceRoot}; add that folder as a project in T3Code, then restart the task`,
  );
  // The unknown delivery still permits the owner path: the re-read finds
  // nothing, so the recorded create resends exactly once.
  await assert.rejects(
    host.createWorkspace({
      title: "Synthetic task",
      requestId: "workspace-unsupported",
      directory: worktree,
      project,
    }),
    /unknown/i,
  );
  assert.equal(
    server.commands.filter((command) => command.method === "projects.mutate")
      .length,
    2,
  );
  assert.equal(server.projects.length, 0);
});

test("a long repository path keeps its complete identity while the reason and fix stay bounded", async (t) => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  // Two near-maximum path components put the repository root far past every
  // bounded budget.
  const deep = join(root, "long".repeat(50), "path".repeat(50), "repository");
  mkdirSync(deep, { recursive: true });
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  const project = await host.repositoryProject(deep);
  assert.ok(
    project.workspaceRoot && project.workspaceRoot.length > 420,
    "the fixture path is longer than the reason cap",
  );
  server.controls.unsupportedProjectCreate = true;
  await assert.rejects(
    host.createWorkspace({
      title: "Synthetic task",
      requestId: "workspace-long-path",
      directory: worktree,
      project,
    }),
    (error) => {
      assert.ok(error instanceof HostUnknownDeliveryError);
      const diagnostic = (error as HostUnknownDeliveryError).diagnostic;
      assert.equal(
        diagnostic.reason,
        "unknown_request_tag",
        "the canonical remote reason is intact",
      );
      assert.equal(
        diagnostic.guidance,
        `T3Code cannot create a project for ${project.workspaceRoot}; add that folder as a project in T3Code, then restart the task`,
        "the manual fix carries the complete untruncated path",
      );
      assert.match(
        String(error),
        /add that folder as a project in T3Code, then restart the task/,
      );
      assert.ok(
        String(error).includes(project.workspaceRoot!),
        "the attention text carries the full path",
      );
      return true;
    },
  );
});

test("a typed failure keeps its fixed wire message as the reason in the durable intent and attention detail", async (t) => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  mkdirSync(repository);
  mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.projectMutationFailure = true;
  await assert.rejects(
    host.createWorkspace({
      title: "Synthetic task",
      requestId: "workspace-reason",
      directory: worktree,
      project,
    }),
    (error) => {
      assert.ok(error instanceof HostUnknownDeliveryError);
      assert.deepEqual(error.diagnostic, {
        command: "project.create",
        reason: "ProjectMutationError:project_mutation_failed",
      });
      assert.match(
        error.message,
        /unknown.*not resent.*command project\.create.*reason ProjectMutationError:project_mutation_failed/,
      );
      return true;
    },
  );
  const key = Object.keys(host.state.read().intents).find((candidate) =>
    candidate.startsWith("nucleus-project-create-"),
  )!;
  assert.equal(host.state.read().intents[key]?.status, "unknown");
  assert.deepEqual(host.state.read().intents[key]?.diagnostic, {
    command: "project.create",
    reason: "ProjectMutationError:project_mutation_failed",
  });
  // The reason is diagnostic evidence only: the delivery stays unknown and is never resent.
  server.controls.projectMutationFailure = false;
  const sent = server.commands.filter(
    (command) => command.method === "projects.mutate",
  );
  assert.equal(sent.length, 1);
});

test("arbitrary typed-failure text retains only the tag, never its unquoted secrets", async (t) => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  mkdirSync(repository);
  mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  server.controls.projectMutationSecretFailure = true;
  await assert.rejects(
    host.createWorkspace({
      title: "Synthetic task",
      requestId: "workspace-secret",
      directory: worktree,
      project,
    }),
    (error) => {
      assert.ok(error instanceof HostUnknownDeliveryError);
      assert.deepEqual(error.diagnostic, {
        command: "project.create",
        reason: "ProjectMutationError",
      });
      assert.doesNotMatch(
        `${String(error)} ${JSON.stringify(error)}`,
        /api_key|synthetic-secret/,
      );
      return true;
    },
  );
  const key = Object.keys(host.state.read().intents).find((candidate) =>
    candidate.startsWith("nucleus-project-create-"),
  )!;
  const durable = JSON.stringify(host.state.read().intents[key]);
  assert.equal(host.state.read().intents[key]?.status, "unknown");
  assert.doesNotMatch(durable, /api_key|synthetic-secret/);
});

test("guidance preserves a repository path with repeated whitespace exactly", async (t) => {
  const { host, server, root } = await fixture(t);
  server.projects.splice(0);
  const repository = join(root, "my  repository");
  const worktree = join(root, "worktree");
  mkdirSync(repository);
  mkdirSync(worktree);
  const project = await host.repositoryProject(repository);
  assert.ok(
    project.workspaceRoot && project.workspaceRoot.includes("  "),
    "the fixture path carries repeated whitespace",
  );
  server.controls.unsupportedProjectCreate = true;
  await assert.rejects(
    host.createWorkspace({
      title: "Synthetic task",
      requestId: "workspace-whitespace",
      directory: worktree,
      project,
    }),
    (error) => {
      assert.ok(error instanceof HostUnknownDeliveryError);
      const guidance =
        (error as HostUnknownDeliveryError).diagnostic.guidance ?? "";
      assert.equal(
        guidance,
        `T3Code cannot create a project for ${project.workspaceRoot}; add that folder as a project in T3Code, then restart the task`,
        "the guidance preserves the local path exactly, whitespace included",
      );
      assert.ok(
        String(error).includes(project.workspaceRoot!),
        "the attention text carries the path byte-exactly",
      );
      return true;
    },
  );
});

test("the catalog reports each model's real option choices from server.getConfig", async (t) => {
  const { host } = await fixture(t);
  const [provider] = (await host.catalog()).providers;
  const model = provider!.models[0]!;
  // The nightly's reasoning select: every choice, the default from isDefault.
  assert.deepEqual(model.thinkingOptions, [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
  ]);
  assert.equal(model.defaultThinkingOptionId, "high");
  assert.deepEqual(model.aliases, ["synthetic-alias"]);
  const tier = model.features.find((f) => f.id === "serviceTier");
  assert.equal(tier?.type, "select");
  assert.equal(tier?.type === "select" && tier.value, "standard");
  assert.ok(
    tier?.type === "select" &&
      tier.options.some((option) => option.id === "priority"),
  );
  const verbose = model.features.find((f) => f.id === "verbose");
  assert.deepEqual(verbose, {
    type: "toggle",
    id: "verbose",
    label: "Verbose",
    value: true,
  });
});

test("a profile with a supported thinking level launches with the mapped modelSelection options", async (t) => {
  const { host, server, spec } = await fixture(t);
  const thinking: Profile = {
    ...profile,
    thinkingOptionId: "high",
    supportedThinking: ["high"],
    featureValues: { serviceTier: "priority", verbose: false },
  };
  await host.createAgent({ ...spec(), profile: thinking });
  const command = server.commands.find(
    (entry) => entry.type === "delegated_task.request",
  )!;
  assert.deepEqual(command.modelSelection, {
    instanceId: "synthetic-provider",
    model: "synthetic-model",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
      { id: "verbose", value: false },
    ],
  });
});

test("a thinking level the model does not report settles to the nearest one it does", async (t) => {
  const { host, server, spec } = await fixture(t);
  // The synthetic model offers low, medium and high: a canonical xhigh is the
  // nearest of those, so the launch carries high instead of refusing
  // (nucleus#1364; `test/t3code-thinking-levels.test.ts` holds the real shapes).
  const xhigh: Profile = {
    ...profile,
    thinkingOptionId: "xhigh",
    supportedThinking: ["xhigh"],
  };
  await host.createAgent({ ...spec("launch-xhigh"), profile: xhigh });
  const child = server.commands.find(
    (entry) => entry.type === "delegated_task.request",
  )!;
  assert.deepEqual((child.modelSelection as { options: unknown[] }).options, [
    { id: "reasoningEffort", value: "high" },
  ]);
});

test("an unreported feature value is refused before send with the option and value named", async (t) => {
  const { host, server, spec } = await fixture(t);
  const unknownChoice: Profile = {
    ...profile,
    featureValues: { serviceTier: "ultra" },
  };
  await assert.rejects(
    host.createAgent({ ...spec("launch-tier"), profile: unknownChoice }),
    /T3Code model synthetic-model has no serviceTier "ultra"/,
  );
  const unknownOption: Profile = {
    ...profile,
    featureValues: { contextWindow: 200000 },
  };
  await assert.rejects(
    host.createAgent({ ...spec("launch-window"), profile: unknownOption }),
    /T3Code model synthetic-model has no "contextWindow" option/,
  );
  assert.equal(server.commands.length, 0, "nothing was sent");
  assert.equal(
    Object.keys(host.state.read().intents).length,
    0,
    "no durable launch intent was recorded for a refusal",
  );
});

test("workspace archive retires its local handle without archiving the shared T3 project", async (t) => {
  const { host, server, workspace } = await fixture(t);
  assert.equal(await host.workspaceArchived(workspace.id), false);
  const ref = host.workspaceRef(workspace.id);
  await ref.refresh();
  assert.ok(ref.current());
  const result = await ref.archive("ns-archive-check");
  assert.equal(result.error, null);
  assert.ok(result.archivedAt);
  assert.equal(
    server.commands.some((c) => c.method === "projects.mutate"),
    false,
  );
  assert.equal(await host.workspaceArchived(workspace.id), true);
  assert.equal(await host.workspaceAvailable(workspace.id), false);
  await ref.refresh();
  assert.equal(
    ref.current(),
    null,
    "the retired task handle is no longer current",
  );
  const again = await ref.archive("ns-archive-check");
  assert.equal(again.error, null);
  assert.equal(
    server.commands.filter((c) => c.method === "projects.mutate").length,
    0,
  );
});

test("one task worktree archives while another T3 task keeps the repository project registered", async (t) => {
  const { host, server, workspace, directory, root } = await fixture(t);
  const secondDirectory = join(root, "second-worktree");
  mkdirSync(secondDirectory);
  const second = await host.createWorkspace({
    title: "Other task worktree",
    requestId: "workspace-second-task",
    directory: secondDirectory,
    project: { projectId: "synthetic-project" },
  });
  const records = Object.values(host.state.read().workspaces);
  assert.equal(records.length, 2);
  assert.ok(
    records.every((record) => record.projectId === "synthetic-project"),
    "stored adapter records bind both worktrees to the shared project",
  );

  const archived = await host
    .workspaceRef(workspace.id)
    .archive("ns-archive-first-task");
  assert.ok(archived.archivedAt);
  assert.equal(await host.workspaceArchived(workspace.id), true);
  assert.equal(await host.workspaceAvailable(second.id), true);
  assert.equal(
    host.state.read().workspaces[workspace.id]?.archivedAt !== undefined,
    true,
    "the archived record retains thread-to-worktree ownership",
  );
  assert.equal(
    host.state.read().workspaces[second.id]?.archivedAt,
    undefined,
    "the other task handle stays active",
  );
  assert.equal(
    server.commands.some((c) => c.method === "projects.mutate"),
    false,
    "individual worktree archive never mutates the shared registration",
  );
});

test("the workspace inventory reads T3's finished, archived and removed threads as terminal and holds a live or unrelated one (nucleus#1381)", async (t) => {
  const { host, server, spec } = await fixture(t);
  const pilotTask = "task-1381-pilot";
  const launch = (requestId: string, taskId: string, runId: string) => ({
    ...spec(),
    attempt: () => ({
      requestId,
      prompt: "Synthetic prompt",
      labels: storedT3Labels("worker", { taskId, runId }),
      environment: {},
    }),
  });
  // The pilot's shape: a finished worker, its follow-up child, an archived thread
  // and a removed one, plus a live run and an unrelated task's thread.
  const worker = await host.createAgent(
    launch("pilot-worker", pilotTask, "pilot-run"),
  );
  const followUp = await host.createAgent(
    launch("pilot-follow-up", pilotTask, "follow-up-run"),
  );
  const archived = await host.createAgent(
    launch("pilot-archived", pilotTask, "archived-run"),
  );
  const removed = await host.createAgent(
    launch("pilot-removed", pilotTask, "removed-run"),
  );
  const live = await host.createAgent(
    launch("pilot-live", pilotTask, "live-run"),
  );
  const foreign = await host.createAgent(
    launch("foreign", "other-task", "foreign-run"),
  );
  server.controls.shellStatuses = {
    [worker.id]: "completed",
    [followUp.id]: "interrupted",
    [archived.id]: "failed",
    [removed.id]: "cancelled",
    [live.id]: "running",
    [foreign.id]: "completed",
  };
  await host.archiveAgent(archived.id);
  server.controls.shellTombstones = true;
  server.threads.get(removed.id)!.thread.deletedAt = "2026-11-19T00:00:00.000Z";

  // The workspace inventory the archive proof reads, through the adapter's own mapping.
  const adapter = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
  ) as unknown as WorkspaceThreadInventoryHost;
  const page = await adapter.workspaceHost.archiveThreadPage({
    filter: { includeArchived: true },
    page: { limit: 200 },
  });
  const rows = new Map(
    page.entries.map((entry) => [entry.agent.id, entry.agent]),
  );
  assert.equal(rows.get(worker.id)?.status, "idle", "a completed run is idle");
  assert.equal(
    rows.get(followUp.id)?.status,
    "idle",
    "an interrupted run is idle",
  );
  assert.equal(
    rows.get(archived.id)?.status,
    "closed",
    "an archived thread is closed",
  );
  assert.equal(
    rows.get(removed.id)?.status,
    "gone",
    "a removed thread is gone",
  );
  assert.equal(rows.get(live.id)?.activeTurn, true, "a live run still holds");
  const entriesOf = (ids: string[]) =>
    ids.map((id) => ({ agent: rows.get(id)! }));
  const finished = [worker.id, followUp.id, archived.id, removed.id];
  assert.deepEqual(
    workspaceThreadFacts(entriesOf(finished), pilotTask, new Set(), false),
    { foreignAgentIds: [] },
    "the pilot's finished, archived and removed threads archive",
  );
  assert.throws(
    () =>
      workspaceThreadFacts(
        entriesOf([...finished, live.id]),
        pilotTask,
        new Set(),
        false,
      ),
    /become idle/,
    "a live run holds the archive",
  );
  assert.throws(
    () =>
      workspaceThreadFacts(
        entriesOf([...finished, foreign.id]),
        pilotTask,
        new Set(),
        false,
      ),
    /unrelated thread/,
    "an unrelated thread in the workspace is preserved",
  );
  assert.deepEqual(
    workspaceThreadFacts(
      entriesOf([...finished, foreign.id]),
      pilotTask,
      new Set(),
      true,
    ),
    { foreignAgentIds: [foreign.id] },
    "an allowed idle foreign thread is named, not treated as the task's",
  );
});

test("every raw status the shell decoder admits reaches the archive proof as its own answer (nucleus#1381)", () => {
  // The shell decoder accepts only this closed enum, so no row the service reads can
  // carry any other raw status. Each value is walked through the same mapping the
  // inventory uses and the archive facts that decide the workspace.
  const finishedRun = [
    "idle",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
    "rolled_back",
  ];
  const liveRun = ["preparing", "queued", "starting", "running", "waiting"];
  assert.deepEqual(
    [...shellThread.shape.status.options].sort(),
    [...finishedRun, ...liveRun].sort(),
    "the mapping covers the whole shell enum; a new T3 status must be classified here",
  );
  for (const status of shellThread.shape.status.options) {
    const row = {
      id: "pilot-row",
      status,
      activeRunId: null,
      archivedAt: null,
      deletedAt: null,
    } as unknown as Parameters<typeof shellThreadStatus>[0];
    const mapped = shellThreadStatus(row);
    const entries = [
      {
        agent: {
          id: "pilot-row",
          workspaceId: "ws",
          labels: { "nucleus.task": "task-1381-pilot" },
          status: mapped,
          activeTurn: !!row.activeRunId || activeStatuses.has(status),
          pendingPermissions: [],
        },
      },
    ];
    if (finishedRun.includes(status))
      assert.deepEqual(
        workspaceThreadFacts(entries, "task-1381-pilot", new Set(), false),
        { foreignAgentIds: [] },
        `${status} is terminal`,
      );
    else
      assert.throws(
        () =>
          workspaceThreadFacts(entries, "task-1381-pilot", new Set(), false),
        /become idle/,
        `${status} holds the archive`,
      );
  }
});

test("a finished task's follow-up child leaves observation with its task, and a live task's keeps its row (nucleus#1381)", async (t) => {
  const { host, workspace, spec } = await fixture(t);
  const finishedTask = "task-1381-finished";
  const liveTask = "task-1381-live";
  const launch = (requestId: string, taskId: string, runId: string) => ({
    ...spec(),
    attempt: () => ({
      requestId,
      prompt: "Synthetic prompt",
      labels: storedT3Labels("worker", { taskId, runId }),
      environment: {},
    }),
  });
  await host.createAgent(
    launch("finished-worker", finishedTask, "finished-run"),
  );
  await host.createAgent(launch("live-worker", liveTask, "live-run"));
  const parentOf = (taskId: string) =>
    host.state.read().parents?.[taskId]?.threadId;
  const finishedParent = parentOf(finishedTask);
  assert.ok(finishedParent, "the finished task has a parent thread");
  const reminder = "thread:delegated-task:ns-reminder-1381";
  const liveFollowUp = "thread:delegated-task:ns-run-1381";
  host.state.update((state) => {
    state.followUps = {
      [reminder]: {
        workspaceId: workspace.id,
        labels: storedT3Labels("worker", {
          taskId: finishedTask,
          runId: "reminder-run",
        }),
        parentThreadId: finishedParent!,
      },
      [liveFollowUp]: {
        workspaceId: workspace.id,
        labels: storedT3Labels("worker", {
          taskId: liveTask,
          runId: "live-follow-up-run",
        }),
        parentThreadId: parentOf(liveTask)!,
      },
    };
  });

  await host.beginHostPass([
    { id: finishedTask, phase: "done", removedAt: null } as never,
    { id: liveTask, phase: "implementing", removedAt: null } as never,
  ]);
  host.endHostPass();

  const state = host.state.read();
  assert.equal(
    state.followUps?.[reminder],
    undefined,
    "the finished task's reminder is no longer a live-looking row",
  );
  assert.equal(
    state.retiredAgents?.[reminder]?.workspaceId,
    workspace.id,
    "its launch identity is kept for the workspace inventory",
  );
  assert.ok(
    state.followUps?.[liveFollowUp],
    "a live task's follow-up stays observed",
  );
});

test("createWorkspace reuses the preserved project registration after a task workspace archive", async (t) => {
  const { host, server, workspace, directory } = await fixture(t);
  await host.workspaceRef(workspace.id).archive("ns-archive-recreate");
  const reopened = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-archived-root",
    directory,
    project: { projectId: "synthetic-project", workspaceRoot: directory },
  });
  assert.equal(
    await host.workspaceAvailable(reopened.id),
    true,
    "the archived registration was reopened, not replaced",
  );
  assert.equal(
    server.commands.filter((c) => c.method === "projects.mutate").length,
    0,
    "the project stayed registered throughout",
  );
});

test("atomic interrupt and continue steers the live run through steer_active", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.runs = [{ id: "run-1", status: "running", startedAt: STAMP }];
  await host.interruptAndContinue(
    created.id,
    "ns-steer-live",
    "Change course: X",
  );
  const command = server.commands.at(-1)!;
  assert.equal(command.type, "message.dispatch");
  assert.deepEqual(command.dispatchMode, {
    type: "steer_active",
    targetRunId: "run-1",
  });
  // With no active run there is nothing to steer: proven refusal before send.
  p.runs = [];
  await assert.rejects(
    host.interruptAndContinue(created.id, "ns-steer-idle", "Change course: Y"),
    /no active run to steer/,
  );
  assert.equal(
    server.commands.filter((c) => c.type === "message.dispatch").length,
    1,
  );
});

// The recorded projection is what the adapter's own read path returns for a thread with a live run
// (synthetic IDs, recorded by running readProjection against the fake transport). Feeding it back
// through the same read path must return it unchanged, so a decode drift fails here.
test("the recorded projection passes through the adapter read path unchanged, with its live run", async (t) => {
  const { host, server } = await fixture(t);
  const recorded = JSON.parse(
    readFileSync(
      new URL("./fixtures/t3code-projection.json", import.meta.url),
      "utf8",
    ),
  );
  server.threads.set("synthetic-probe", recorded);
  const read = await (
    host as unknown as { readProjection(id: string): Promise<unknown> }
  ).readProjection("synthetic-probe");
  assert.deepEqual(read, recorded);
});

// Tom, 2026-11-13: a tell to a working thread steers into its live run; an idle
// thread takes the ordinary queued send, as it always did.
test("a tell to a thread with a live run steers into that run, and an idle thread queues", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  server.threads.get(created.id)!.runs = [];
  const p = server.threads.get(created.id)!;
  p.runs = [{ id: "run-1", status: "running", startedAt: STAMP }];
  // The run the steer targets must be the one the adapter's own read path decodes from the thread projection.
  const read = await (
    host as unknown as {
      readProjection(
        id: string,
      ): Promise<{ runs: { id: string; status: string }[] }>;
    }
  ).readProjection(created.id);
  assert.deepEqual(
    read.runs.map((run) => [run.id, run.status]),
    [["run-1", "running"]],
    "the adapter reads the live run from the projection",
  );
  await host.steerOrNotify(created.id, {
    messageId: "ns-tell-live",
    text: "Planner: keep the change set narrow.",
  });
  const steer = server.commands.findLast(
    (command) => command.type === "message.dispatch",
  )!;
  assert.equal(steer.type, "message.dispatch");
  assert.deepEqual(steer.dispatchMode, {
    type: "steer_active",
    targetRunId: "run-1",
  });
  assert.equal(steer.text, "Planner: keep the change set narrow.");
  p.runs = [];
  await host.steerOrNotify(created.id, {
    messageId: "ns-tell-idle",
    text: "Planner: next step.",
  });
  const queued = server.commands.findLast(
    (command) => command.type === "message.dispatch",
  )!;
  assert.deepEqual(queued.dispatchMode, { type: "queue_after_active" });
  assert.equal(queued.text, "Planner: next step.");
});

// The run ends between the read and the steer. A proven not-sent steer falls back
// to one queued send; a remote refusal is unknown delivery and is never resent.
test("a steer the adapter proves unsent falls back to one queued send, and an unknown steer is never resent", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  p.runs = [{ id: "run-1", status: "running", startedAt: STAMP }];
  const sent = host.rpc.call.bind(host.rpc);
  host.rpc.call = (method: string, payload: unknown) => {
    const wire = payload as { type?: string; dispatchMode?: { type?: string } };
    if (
      wire.type === "message.dispatch" &&
      wire.dispatchMode?.type === "steer_active"
    )
      return Promise.reject(
        new T3RpcError("transport", method, undefined, "not_sent"),
      );
    return sent(method, payload);
  };
  await host.steerOrNotify(created.id, {
    messageId: "ns-tell-race",
    text: "Planner: one more check.",
  });
  host.rpc.call = sent;
  const dispatches = server.commands.filter(
    (c) =>
      c.type === "message.dispatch" && c.text === "Planner: one more check.",
  );
  assert.equal(
    dispatches.length,
    1,
    "the proven-unsent steer left no command, and the queued send delivered once",
  );
  assert.deepEqual(dispatches[0]!.dispatchMode, { type: "queue_after_active" });

  p.runs = [{ id: "run-2", status: "running", startedAt: STAMP }];
  server.controls.refuseMutation = true;
  await assert.rejects(
    host.steerOrNotify(created.id, {
      messageId: "ns-tell-unknown",
      text: "Planner: stop.",
    }),
    HostUnknownDeliveryError,
  );
  server.controls.refuseMutation = false;
  const attempts = server.commands.filter((c) => c.text === "Planner: stop.");
  assert.equal(
    attempts.length,
    1,
    "an unknown steer is never resent as a queued send",
  );
  assert.deepEqual(attempts[0]!.dispatchMode, {
    type: "steer_active",
    targetRunId: "run-2",
  });
});

// #1148: a thread read cut mid-turn is an observation outage, not a verdict on the
// worker. The next observation is a fresh read, and it reports the live activity.
test("an interrupted thread read is a transport outage, and the next read reports the live run", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  const LATER = "2026-01-01T00:05:00.000Z";
  server.controls.interruptThreadReads = 1;
  await assert.rejects(host.observe(created.id), (error) =>
    isTransportFailure(error),
  );
  p.runs = [{ id: "live-run", status: "running", startedAt: LATER }];
  p.thread.updatedAt = LATER;
  p.updatedAt = LATER;
  const live = await host.observe(created.id);
  assert.equal(live.active, true);
  assert.equal(live.activeTurnId, "live-run");
  assert.equal(
    live.updatedAt,
    LATER,
    "the observed activity stamp advances with the thread",
  );
});

// #1148: after the T3 socket drops, observation is an outage until the host
// reconnects; then every live thread's observation resumes from a fresh read.
test("after a socket drop, observation is an outage until reconnect, then resumes for the live thread", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  server.dropSockets();
  for (let i = 0; i < 100 && host.connected; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host.connected, false);
  await assert.rejects(host.observe(created.id), (error) =>
    isTransportFailure(error),
  );
  await host.connect();
  assert.equal(host.connected, true);
  p.runs = [{ id: "resumed-run", status: "running", startedAt: STAMP }];
  const resumed = await host.observe(created.id);
  assert.equal(resumed.active, true);
  assert.equal(resumed.activeTurnId, "resumed-run");
});

test("a support thread is removed once through the nightly thread.delete command and then reads as absent", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  const before = server.commands.length;

  await host.deleteAgent(created.id);
  const removals = server.commands.filter(
    (command) => command.type === "thread.delete",
  );
  assert.equal(removals.length, 1);
  assert.equal(removals[0]!.method, "orchestration.dispatchCommand");
  assert.equal(removals[0]!.threadId, created.id);
  assert.equal(typeof removals[0]!.commandId, "string");
  // `onlyIfUnused` would make the nightly answer success without changing a
  // thread that has runs or messages, reporting a removal that never happened.
  assert.equal(removals[0]!.onlyIfUnused, undefined);
  assert.equal(
    await host.originAgent(created.id),
    null,
    "a removed thread is absent from a complete inventory",
  );

  // The durable receipt replays the recorded answer: one command, never two.
  await host.deleteAgent(created.id);
  assert.equal(
    server.commands.filter((command) => command.type === "thread.delete")
      .length,
    1,
  );
  assert.ok(server.commands.length > before);
  host.state.update((state) => {
    state.hostId = "t3code:other-environment";
  });
  await assert.rejects(
    host.deleteAgent(created.id),
    /durable host identity changed/,
  );
  assert.equal(
    server.commands.filter((command) => command.type === "thread.delete")
      .length,
    1,
    "receipt replay still proves its host identity",
  );
});

test("a native not_sent delete stays ready in the terminal lane and succeeds on the next attempt", async (t) => {
  const { host, server, spec, root, workspace } = await fixture(t);
  const store = new Store(join(root, "delete-retry.sqlite"));
  t.after(() => store.close());
  store.setMeta("paused", false);
  const task = store.insert(
    submissionSchema.parse({
      submissionId: "delete-retry",
      title: "Synthetic cleanup",
      repoPath: "/synthetic/repository",
      planningCommit: "a".repeat(40),
      handoffPath: "synthetic.md",
      originAgentId: "synthetic-origin",
    }),
    host.hostId,
    "Synthetic handoff",
    "a".repeat(40),
  );
  const launch = spec();
  const attempt = launch.attempt;
  launch.attempt = (mcp, retry) => ({
    ...attempt(mcp, retry),
    labels: storedT3Labels("recovery", {
      taskId: task.id,
      runId: "recovery-run",
    }),
  });
  const created = await host.createAgent(launch);
  server.threads.get(created.id)!.runs = [];
  store.update(task.id, {
    phase: "done",
    workspaceId: workspace.id,
    resolution: {
      ...store.task(task.id).resolution,
      mergedCommit: "b".repeat(40),
    },
  });
  store.putRun({
    id: "recovery-run",
    taskId: task.id,
    hostId: host.hostId,
    role: "recovery",
    generation: 1,
    head: "b".repeat(40),
    base: "a".repeat(40),
    agentId: created.id,
    workspaceId: workspace.id,
    profile: null,
    status: "finished",
    createdAt: STAMP,
    lastObservedAt: STAMP,
    active: false,
    idleSince: STAMP,
    completion: null,
    released: true,
  });
  const adapter = {
    hostId: host.hostId,
    observe: host.observe.bind(host),
    originAgent: (id: string) => host.originAgent(id),
    archiveAgent: host.archiveAgent.bind(host),
    deleteAgent: host.deleteAgent.bind(host),
  } as unknown as Adapter;
  const nativeCall = host.rpc.call.bind(host.rpc);
  host.rpc.call = (method, payload) => {
    if (
      method === "orchestration.dispatchCommand" &&
      (payload as { type?: string }).type === "thread.delete"
    )
      host.rpc.close();
    // The real RPC client, now disconnected, returns delivery:not_sent before
    // serializing or writing any command to the fake Nightly server.
    return nativeCall(method, payload);
  };

  await archiveFinishedThreads(store, adapter, task.id);
  const key = qualifiedThreadArchiveEffectKey(host.hostId, created.id);
  assert.equal(
    store.getMeta<{ status: string }>(key)?.status,
    "ready",
    "proven non-delivery remains safely retryable",
  );
  assert.equal(
    server.commands.filter((command) => command.type === "thread.delete")
      .length,
    0,
  );
  assert.equal(
    Object.values(host.state.read().intents).find(
      (intent) => JSON.parse(intent.payload).payload.type === "thread.delete",
    )?.status,
    "refused",
    "the native delivery ledger records its own not-sent result",
  );

  host.rpc.call = nativeCall;
  await host.connect();
  const nativeOrigin = host.originAgent.bind(host);
  host.originAgent = async (id) => {
    const origin = await nativeOrigin(id);
    host.close(); // A known-refused attempt now loses its connection before reservation.
    return origin;
  };
  await archiveFinishedThreads(store, adapter, task.id);
  assert.equal(store.getMeta<{ status: string }>(key)?.status, "ready");
  assert.equal(
    server.commands.filter((command) => command.type === "thread.delete")
      .length,
    0,
  );
  assert.equal(
    Object.values(host.state.read().intents).find(
      (intent) => JSON.parse(intent.payload).payload.type === "thread.delete",
    )?.status,
    "refused",
    "a refused intent remains known-unsent across connection preflight failure",
  );
  host.originAgent = nativeOrigin;
  await host.connect();
  await archiveFinishedThreads(store, adapter, task.id);
  assert.equal(store.getMeta<{ status: string }>(key)?.status, "archived");
  assert.equal(
    server.commands.filter((command) => command.type === "thread.delete")
      .length,
    1,
    "the same deletion is delivered once",
  );
  await archiveFinishedThreads(store, adapter, task.id);
  assert.equal(
    server.commands.filter((command) => command.type === "thread.delete")
      .length,
    1,
  );
});

test("an unknown thread.delete outcome is never resent; the thread is read back instead", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  // The nightly applied the removal and the reply was lost with the socket.
  server.controls.disconnectAfterEffect = true;
  await assert.rejects(host.deleteAgent(created.id), /unknown/i);
  server.controls.disconnectAfterEffect = false;
  assert.equal(
    server.threads.get(created.id)!.thread.deletedAt,
    STAMP,
    "the removal landed",
  );
  const sent = server.commands.filter(
    (command) => command.type === "thread.delete",
  );
  assert.equal(sent.length, 1);
  host.close();
  await assert.rejects(
    host.deleteAgent(created.id),
    HostUnknownDeliveryError,
    "an offline connection cannot turn an earlier unknown delivery into a pre-send refusal",
  );
  assert.equal(
    Object.values(host.state.read().intents).find(
      (intent) => JSON.parse(intent.payload).payload.type === "thread.delete",
    )?.status,
    "unknown",
  );

  // The outcome stays unknown: nothing re-sends it, with or without a fresh read,
  // and the host's own inventory is the proof the caller reads instead.
  await host.connect();
  await assert.rejects(host.deleteAgent(created.id), /unknown/i);
  assert.equal(
    server.commands.filter((command) => command.type === "thread.delete")
      .length,
    1,
  );
  assert.equal(
    await host.originAgent(created.id),
    null,
    "the removal is read back as authoritative absence",
  );
});

for (const lostDeleteReply of [false, true])
  test(`confirmed own deletion retires unknown presentation intents without replay (lost delete reply: ${lostDeleteReply})`, async (t) => {
    const { host, server, options, spec } = await fixture(t);
    const created = await host.createAgent(spec("deleted-presentations"));
    // The task's one row is the parent thread, so its presentation intents address it.
    const row = Object.values(host.state.read().parents ?? {})[0]!;
    const task = {
      id: "synthetic-task",
      agentId: created.id,
      runId: "worker-run",
      number: 225,
      title: "Updated title",
      phase: "working",
      held: false,
      hostId: host.hostId,
    } as Task;
    for (const operation of [
      () =>
        host.setTaskWorkspaceTitle(task, "Updated title", "lost-title", false),
      // A second title is its own command identity: titles legitimately change, so
      // each one is a presentation intent of its own (nucleus#1366).
      () =>
        host.setTaskWorkspaceTitle(
          task,
          "Another title",
          "lost-title-2",
          false,
        ),
    ]) {
      server.controls.disconnectAfterEffect = true;
      await assert.rejects(operation(), HostUnknownDeliveryError);
      server.controls.disconnectAfterEffect = false;
      await host.connect();
    }
    const presentationKeys = Object.entries(host.state.read().intents)
      .filter(([, entry]) => entry.status === "unknown")
      .map(([key]) => key);
    assert.equal(
      presentationKeys.length,
      2,
      "both title deliveries are unknown",
    );
    host.state.update((state) => {
      state.intents["unrelated-message"] = {
        status: "unknown",
        payload: JSON.stringify({
          method: "orchestration.dispatchCommand",
          payload: {
            type: "message.dispatch",
            threadId: row.threadId,
            commandId: "unrelated-message",
          },
        }),
      };
    });
    server.controls.disconnectAfterEffect = lostDeleteReply;
    if (lostDeleteReply) {
      await assert.rejects(
        host.deleteAgent(row.threadId),
        HostUnknownDeliveryError,
      );
      assert.ok(
        presentationKeys.every(
          (key) => host.state.read().intents[key].status === "unknown",
        ),
        "unknown delete delivery alone retires nothing",
      );
      server.controls.disconnectAfterEffect = false;
      await host.connect();
      assert.equal(
        await host.originAgent(row.threadId),
        null,
        "complete inventory confirms our delete postcondition",
      );
    } else await host.deleteAgent(row.threadId);
    const deleted = host.state.read();
    const deleteKey = Object.keys(deleted.intents).find(
      (key) =>
        JSON.parse(deleted.intents[key].payload).payload.type ===
        "thread.delete",
    )!;
    assert.equal(
      deleted.intents[deleteKey].status,
      lostDeleteReply ? "unknown" : "settled",
      "observing deletion does not invent a reply",
    );
    assert.equal(
      Boolean(deleted.intents[deleteKey].deletionObservedAt),
      lostDeleteReply,
    );
    for (const key of presentationKeys) {
      assert.equal(deleted.intents[key].status, "moot");
      assert.equal(deleted.intents[key].retiredByDeletion, deleteKey);
      assert.equal(deleted.intents[key].result, undefined);
    }
    assert.equal(
      deleted.intents["unrelated-message"].status,
      "unknown",
      "non-presentation effects retain unknown delivery",
    );
    // Simulate interruption after recording the delete but before presentation
    // retirement. A reload must reconstruct retirement from that durable proof.
    host.state.update((state) => {
      for (const key of presentationKeys) {
        state.intents[key] = {
          ...state.intents[key],
          status: "unknown",
        };
        delete state.intents[key].retiredByDeletion;
      }
    });
    host.close();
    const reloaded = new T3CodeHost(options);
    t.after(() => reloaded.close());
    const nativeRead = reloaded.rpc.readStream.bind(reloaded.rpc),
      reads: string[] = [];
    reloaded.rpc.readStream = (method, payload, accept) => {
      if (method === "orchestration.subscribeThread")
        reads.push((payload as { threadId: string }).threadId);
      return nativeRead(method, payload, accept);
    };
    await reloaded.connect();
    const commands = server.commands.length;
    for (let pass = 0; pass < 3; pass++) {
      await reloaded.reconcileTaskRow("synthetic-task", {
        state: "waiting",
        cause: "Waiting",
      });
      await reloaded.setTaskWorkspaceTitle(
        task,
        "Updated title",
        "lost-title",
        true,
      );
    }
    assert.equal(
      reads.filter((id) => id === row.threadId).length,
      0,
      "the real stream boundary never reads the deleted projection",
    );
    assert.equal(server.commands.length, commands, "no effect is replayed");
    assert.ok(
      presentationKeys.every(
        (key) => reloaded.state.read().intents[key].status === "moot",
      ),
    );
  });

test("external deletion without our recorded delete leaves unknown presentation delivery untouched", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec("external-deletion"));
  const row = Object.values(host.state.read().parents ?? {})[0]!;
  const p = server.threads.get(row.threadId)!;
  const task = {
    id: "synthetic-task",
    agentId: created.id,
    runId: "worker-run",
    number: 225,
    title: "Unknown delivery title",
    phase: "working",
    held: false,
    hostId: host.hostId,
  } as Task;
  server.controls.disconnectAfterEffect = true;
  await assert.rejects(
    host.setTaskWorkspaceTitle(
      task,
      "Unknown delivery title",
      "unknown-title",
      false,
    ),
    HostUnknownDeliveryError,
  );
  server.controls.disconnectAfterEffect = false;
  await host.connect();
  const key = Object.keys(host.state.read().intents).find(
    (key) => host.state.read().intents[key].status === "unknown",
  )!;
  p.thread.deletedAt = STAMP;
  assert.equal(await host.originAgent(row.threadId), null);
  await host.setTaskWorkspaceTitle(
    task,
    "Unknown delivery title",
    "unknown-title",
    true,
  );
  assert.equal(host.state.read().intents[key].status, "unknown");
  assert.equal(host.state.read().intents[key].retiredByDeletion, undefined);
  assert.ok(created.id);
});

// Orchestration contract, "Archived thread retention" (nucleus#1369): the retention pass
// reads a T3 host's archived Nucleus threads from T3's own inventory, and reads one
// thread's fresh archive stamp before it removes it.
test("the retention pass lists a T3 host's archived Nucleus threads and reads each one's fresh archive stamp", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec());
  assert.deepEqual(
    await host.archivedThreads(),
    [],
    "a live thread is not in the archived set",
  );
  assert.equal((await host.threadArchiveState(created.id))?.archivedAt, null);

  await host.archiveAgent(created.id);
  const listed = await host.archivedThreads();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, created.id);
  assert.equal(listed[0]!.archivedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(
    listed[0]!.labels,
    host.state.read().agents[created.id]!.labels,
  );
  assert.deepEqual(await host.threadArchiveState(created.id), {
    archivedAt: "2026-01-01T00:00:00.000Z",
    deleted: false,
  });

  await host.deleteAgent(created.id);
  assert.equal(
    await host.threadArchiveState(created.id),
    null,
    "a removed thread is absent from T3's complete inventory, so it reads as gone",
  );
  assert.deepEqual(await host.archivedThreads(), []);
  assert.equal(
    server.commands.filter((command) => command.type === "thread.delete")
      .length,
    1,
  );
});

// nucleus#1369: one whole retention pass over the T3 adapter (the real adapter over
// the T3 fake, not the surface alone): the archived worker of a finished task is
// removed, the live thread of the same task is never scanned, and the row carries
// `at`, `checkedAt` and counts.
test("one retention pass over a T3 host removes a finished task's archived worker and records its row (#1369)", async (t) => {
  const { host, server, spec } = await fixture(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Finished task",
      repoPath: "/repo",
      planningCommit: "a".repeat(40),
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    host.hostId,
    "handoff",
    "a".repeat(40),
  );
  const task = store.update(submitted.id, { phase: "done" });
  const launch = (requestId: string, runId: string) => ({
    ...spec(),
    attempt: () => ({
      requestId,
      prompt: "Synthetic prompt",
      labels: storedT3Labels("worker", { taskId: task.id, runId }),
      environment: {},
    }),
  });
  const finished = await host.createAgent(
    launch("retention-finished", "finished-run"),
  );
  await host.archiveAgent(finished.id);
  const live = await host.createAgent(launch("retention-live", "live-run"));

  const at = Date.parse(STAMP) + 9 * 86_400_000;
  const fact = await runThreadRetentionPass({
    store,
    adapter: host as unknown as Adapter,
    hostId: host.hostId,
    at,
    days: 3,
  });

  assert.equal(fact.supported, true, fact.error);
  assert.equal(fact.error, "");
  assert.equal(fact.at, new Date(at).toISOString());
  assert.equal(fact.checkedAt, fact.at);
  assert.equal(
    fact.scanned,
    1,
    "only the archived thread is in the archived set",
  );
  assert.equal(fact.eligible, 1);
  assert.equal(fact.deleted, 1);
  assert.equal(await host.threadArchiveState(finished.id), null);
  assert.deepEqual(
    (await host.threadArchiveState(live.id))?.archivedAt,
    null,
    "the live thread is untouched",
  );
  assert.equal(
    server.commands.filter((command) => command.type === "thread.delete")
      .length,
    1,
  );
});

test("a native answer on a paged thread reads the retained question item, and a refusal names its pre-send step", async (t) => {
  const { host, server, spec, workspace } = await fixture(t);
  const created = await host.createAgent(spec());
  const p = server.threads.get(created.id)!;
  const at = (offset: number) =>
    new Date(Date.parse(STAMP) + offset * 1_000).toISOString();
  const questionItem = (requestId: string) =>
    syntheticTurnItem(created.id, 1, {
      type: "user_input_request",
      id: `${requestId}-item`,
      requestId,
      runId: "synthetic-run-2",
      nodeId: `synthetic-node-${requestId}`,
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Pick one?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
      updatedAt: at(0),
    });
  // The question is the oldest row: the newest window drops it, but the pending request keeps it.
  p.turnItems = [
    questionItem("synthetic-question"),
    ...Array.from({ length: 30 }, (_, index) =>
      syntheticTurnItem(created.id, index + 2, {
        type: "assistant_message",
        runId: "synthetic-run-1",
        updatedAt: at(index + 1),
      }),
    ),
  ];
  p.runtimeRequests = [
    syntheticRuntimeRequest({
      id: "synthetic-question",
      kind: "user_input",
      status: "pending",
    }),
  ];
  server.controls.boundedRowLimit = 2;
  await host.answerNativeQuestion(
    created.id,
    workspace.id,
    "synthetic-question",
    { Choice: "Yes" },
  );
  const answered = server.commands
    .filter((command) => command.type === "runtime-request.respond")
    .at(-1)!;
  assert.equal(answered.requestId, "synthetic-question");
  assert.deepEqual(answered.answers, { choice: ["Yes"] });
  assert.equal(p.runtimeRequests[0].status, "resolved");

  // A pending request whose question item the window does not carry is refused before
  // any write, and the refusal names that step rather than a generic fence.
  p.runtimeRequests.push(
    syntheticRuntimeRequest({
      id: "late-question",
      kind: "user_input",
      status: "pending",
    }),
  );
  const sends = () =>
    server.commands.filter(
      (command) =>
        command.type === "runtime-request.respond" &&
        command.requestId === "late-question",
    ).length;
  await assert.rejects(
    host.answerNativeQuestion(created.id, workspace.id, "late-question", {
      Choice: "Yes",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProvenPreSendRefusalError);
      assert.match(
        error.message,
        /pending question item is outside the bounded timeline window; no answer was sent/,
      );
      return true;
    },
  );
  assert.equal(sends(), 0);

  // Once the item is retained, the same refused answer is delivered again, exactly once.
  p.turnItems.push(questionItem("late-question"));
  await host.answerNativeQuestion(created.id, workspace.id, "late-question", {
    Choice: "Yes",
  });
  assert.equal(sends(), 1);
  assert.deepEqual(
    server.commands
      .filter((command) => command.requestId === "late-question")
      .at(-1)!.answers,
    { choice: ["Yes"] },
  );
});
