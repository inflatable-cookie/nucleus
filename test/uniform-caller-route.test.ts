/**
 * nucleus#1317: one caller-resolution order and one tell route for every host
 * and thread kind. Each papercut is a real shape, not a mock of the symptom.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostCallerIdentity } from "../bin/queue-client.mjs";
import {
  HOST_CALLER_OBSERVE_MS,
  HOST_CALLER_RESOLVE_TIMEOUT_MS,
  HOST_SLOW_RETRY,
  resolveHostCallerIdentity,
} from "../core/dispatch/caller-resolution";
import { runTicketPath } from "../core/dispatch/agent-creation";
import {
  plannerTicketKey,
  resolveTicketCaller,
  taskPlannerTicketKey,
} from "../core/dispatch/participant-tickets";
import { Engine } from "../core/engine";
import { Decisions } from "../core/planning/decisions";
import { HostUnknownDeliveryError } from "../core/host/errors";
import { Store } from "../core/store/store";
import { projectEndpointId } from "../core/questions/agent-messages";
import { wireEngineHosts } from "../service/host-connections";
import { formatAgentId, parseAgentId } from "../shared/agent-identity";
import { callerSource } from "../shared/caller.mjs";
import {
  projectQaRunSchema,
  runSchema,
  submissionSchema,
} from "../shared/contracts";
import type { Adapter } from "../core/host";
import { callerCliFixture } from "./support/caller-cli-fixture";
import { projectAgentsFixture } from "./support/project-agents-fixture";

const ticketOf = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as {
    participantId: string;
    token: string;
  };

test("a retained thread with a stale environment resolves its current run (d8158bc3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retained-stale-env-"));
  const store = new Store(":memory:");
  const helperPath = join(dir, "helper.mjs");
  const runId = "run-retained";
  const hostId = "paseo-primary";
  const caller = formatAgentId(hostId, "retained-thread");
  const gone = join(dir, "gone.json");
  mkdirSync(join(dir, "tickets"), { recursive: true });
  try {
    const task = store.insert(
      submissionSchema.parse({
        submissionId: "retained-stale",
        title: "Retained",
        repoPath: dir,
        planningCommit: "a".repeat(40),
        handoffPath: "handoff.md",
        originAgentId: caller,
      }),
      hostId,
      "handoff",
      "a".repeat(40),
    );
    store.putRun(
      runSchema.parse({
        id: runId,
        taskId: task.id,
        role: "revision",
        status: "running",
        generation: 1,
        head: "a".repeat(40),
        base: "a".repeat(40),
        agentId: caller,
        workspaceId: "workspace",
        profile: null,
        lastObservedAt: null,
        active: true,
        idleSince: null,
        completion: null,
        released: false,
        createdAt: new Date().toISOString(),
      }),
    );
    const ticketPath = runTicketPath({ helperPath }, runId);
    writeFileSync(
      ticketPath,
      JSON.stringify({
        socketPath: join(dir, "c"),
        taskId: task.id,
        runId,
        token: "t",
      }),
    );

    assert.deepEqual(
      callerSource({ PASEO_AGENT_ID: "retained-thread" }, hostCallerIdentity),
      { source: "host", hostKind: "paseo", nativeAgentId: "retained-thread" },
    );
    assert.deepEqual(
      callerSource(
        { NUCLEUS_TICKET: gone, PASEO_AGENT_ID: "retained-thread" },
        hostCallerIdentity,
      ),
      { source: "host", hostKind: "paseo", nativeAgentId: "retained-thread" },
    );

    const identity = await resolveHostCallerIdentity(
      {
        onlineIds: () => [hostId],
        observe: async () => ({ id: "retained-thread", status: "idle" }),
        unreleasedRuns: (agent, host) =>
          store.unreleasedRunsForAgent(agent, host),
        helperPath,
      },
      { hostKind: "paseo", nativeAgentId: "retained-thread" },
    );
    assert.equal(identity.caller, caller);
    assert.equal(identity.runTicket, ticketPath);
    assert.equal(identity.source, "host");

    const f = await callerCliFixture();
    try {
      f.setHostRunTicket();
      const unset = await f.invoke("host", "agent-verbs.mjs", ["tell", "-"], {
        to: { project: "Swallowtail" },
        text: "Stale unset ticket.",
      });
      assert.equal(unset.code, 0, unset.stderr);
      const missing = await f.invoke(
        "host",
        "agent-verbs.mjs",
        ["tell", "-"],
        { to: { project: "Swallowtail" }, text: "Stale missing-path ticket." },
        { NUCLEUS_TICKET: join(f.dir, "gone.json") },
      );
      assert.equal(missing.code, 0, missing.stderr);
      assert.deepEqual(
        f.callbacks.map((call) => call.path),
        ["/message", "/message"],
      );
      assert.equal(
        f.calls.some((call) => call.method === "agent.tell"),
        false,
      );
      for (const callback of f.callbacks) {
        assert.equal(callback.input.taskId, "task");
        assert.equal(callback.input.runId, "run");
      }
    } finally {
      await f.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "a slow host observe answers The host is slow; retry instead of hanging (d38b1d28)",
  { timeout: 20_000 },
  async () => {
    const started = Date.now();
    await assert.rejects(
      () =>
        resolveHostCallerIdentity(
          {
            onlineIds: () => ["paseo-primary"],
            observe: () => new Promise(() => {}),
          },
          { hostKind: "paseo", nativeAgentId: "plain-thread" },
        ),
      (error) => error instanceof Error && error.message === HOST_SLOW_RETRY,
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed >= HOST_CALLER_OBSERVE_MS * 0.9,
      `observe bound not exercised: ${elapsed}ms`,
    );
    assert.ok(
      elapsed < HOST_CALLER_RESOLVE_TIMEOUT_MS,
      `hung past resolve bound: ${elapsed}ms`,
    );
  },
);

test("a task-planner ticket tells another project's planner (6109e3d3)", async () => {
  const host = "t3code:synthetic";
  const f = projectAgentsFixture({ hostId: host });
  f.live("task-planner");
  f.live("other-planner");
  try {
    f.store.setMeta("hostId", host);
    f.store.upsertProject({
      key: "other",
      name: "Other",
      repositories: [{ origin: "synthetic/other", path: "/synthetic/other" }],
    });
    f.store.setProjectPlanner({
      key: "other",
      agentId: formatAgentId(host, "other-planner"),
      setBy: "operator",
    });
    f.store.insert(
      submissionSchema.parse({
        submissionId: "cross-project-tell",
        title: "Scoped task",
        repoPath: "/synthetic/example",
        planningCommit: "a".repeat(40),
        handoffPath: "handoff.md",
        originAgentId: formatAgentId(host, "task-planner"),
      }),
      host,
      "handoff",
      "a".repeat(40),
    );
    await f.tickets.ensureFor(formatAgentId(host, "task-planner"), host);
    const record = f.store.getMeta<{ path: string }>(
      taskPlannerTicketKey(host, "task-planner"),
    );
    assert.ok(record, "the thread that plans a live task holds its ticket");
    const planner = ticketOf(record.path);
    const receipt = await f.engine.resolution.agentMessage(
      {
        eventId: "a".repeat(64),
        participantId: planner.participantId,
        to: { project: "other" },
        text: "Cross-project note from the task planner.",
      },
      planner.token,
    );
    assert.ok(
      receipt.status === "delivered" || receipt.status === "queued",
      receipt.status,
    );
    const message = f.store.messages(projectEndpointId("other"))[0]!;
    assert.equal(message.fromRole, "planner");
    assert.equal(message.fromReference, "the task planner");
    assert.equal(message.toProjectKey, "other");
    assert.match(message.fromTaskId, /^task-planner:/);
  } finally {
    f.store.close();
  }
});

test("a plain Paseo thread tells a project planner without a ticket (d38b1d28)", async () => {
  const host = "paseo-synthetic";
  const f = projectAgentsFixture({ hostId: host });
  f.live("plain-thread");
  f.live("planner");
  try {
    f.store.setMeta("hostId", host);
    f.store.setProjectPlanner({
      key: "example",
      agentId: formatAgentId(host, "planner"),
      setBy: "operator",
    });
    const caller = formatAgentId(host, "plain-thread");
    const receipt = await f.engine.resolution.hostAgentMessage(
      { caller, hostId: host },
      {
        eventId: "c".repeat(64),
        to: { project: "example" },
        text: "From a host thread.",
      },
    );
    assert.ok(
      receipt.status === "delivered" || receipt.status === "queued",
      receipt.status,
    );
    const message = f.store.messages(projectEndpointId("example"))[0]!;
    assert.equal(message.fromAgentId, caller);
    assert.equal(message.fromReference, caller);
    assert.equal(message.fromRole, "agent");
    assert.equal(message.toProjectKey, "example");
  } finally {
    f.store.close();
  }
});

test("an omitted host defaults to the sole online host of the kind (78c18e51)", () => {
  const store = new Store(":memory:");
  try {
    const engine = {} as Engine;
    wireEngineHosts(engine, {
      adapter: {} as Adapter,
      hostRegistry: {
        known: () => [{ id: "t3code:env" }],
        onlineIds: () => ["t3code:env"],
      } as never,
      hostSession: null,
      connected: () => true,
      store,
    });
    // No repository and no operator default: the sole online host is chosen.
    assert.deepEqual(engine.selectIngressSelection(undefined, undefined), {
      hostId: "t3code:env",
      basis: "sole_online_host",
    });
    // With a repository but the operator default (paseo) offline, the first
    // online host takes ingress and says why (commit 7c813048, 1390).
    assert.deepEqual(
      engine.selectIngressSelection(undefined, "/unconfigured"),
      {
        hostId: "t3code:env",
        basis: "available_host",
        reason: "Operator default host paseo is offline",
      },
    );
    assert.equal(
      engine.selectIngressHost(undefined, "/unconfigured"),
      "t3code:env",
    );
  } finally {
    store.close();
  }
});

test("a T3 planner ticket records the ticket thread as asker and an answer delivers there", async () => {
  const mcpSession = "mcp:b619ccc9-a078-49f6-b80f-6bececcfa6ca";
  const desktopScope = "e3587e2bcde8d42fdde2f3615032716c";
  const ticketThread = formatAgentId("t3code:fixture", "thread");
  const mcpCaller = formatAgentId(
    "t3code:32be2844-7204-4edc-a95a-35b05e42ded4",
    mcpSession,
  );

  const cli = await callerCliFixture();
  try {
    const result = await cli.invoke(
      "participant",
      "queue-cli.mjs",
      ["decision.add", "-"],
      {
        question: "Which planning lane?",
        options: ["A", "B"],
        recommendation: "A",
      },
      { T3CODE_THREAD_ID: mcpSession, T3CODE_DESKTOP_HOST_SCOPE: desktopScope },
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(
      cli.hostResolutions.length,
      0,
      "an explicit ticket never consults the T3 host identity",
    );
    assert.equal(cli.calls.at(-1)?.input.askedBy, ticketThread);
    assert.notEqual(cli.calls.at(-1)?.input.askedBy, mcpCaller);
  } finally {
    await cli.close();
  }

  const host = "t3code:synthetic";
  const plannerNative = "planner-thread";
  const planner = formatAgentId(host, plannerNative);
  const f = projectAgentsFixture({ hostId: host });
  f.live(plannerNative);
  try {
    f.store.setMeta("paused", false);
    f.store.setProjectPlanner({
      key: "example",
      agentId: planner,
      setBy: planner,
    });
    const ticketPath = await f.tickets.assigned("example");
    assert.ok(
      ticketPath,
      "the self-named T3 planner takes its ticket in the assignment",
    );
    const record = f.store.getMeta<{ path: string }>(
      plannerTicketKey("example"),
    );
    assert.equal(record?.path, ticketPath);
    const ticket = ticketOf(ticketPath);
    const identity = resolveTicketCaller(
      f.store,
      { participantId: ticket.participantId },
      ticket.token,
    );
    assert.equal(identity.caller, planner);
    assert.equal(identity.source, "participant-ticket");
    assert.deepEqual(
      callerSource(
        {
          NUCLEUS_TICKET: ticketPath,
          T3CODE_THREAD_ID: mcpSession,
          T3CODE_DESKTOP_HOST_SCOPE: desktopScope,
        },
        hostCallerIdentity,
      ),
      { source: "ticket", path: ticketPath },
    );

    const decisions = new Decisions(f.store);
    const decision = decisions.add({
      question: "Which planning lane?",
      askedBy: identity.caller,
      options: ["Keep the ticket thread", "Record the MCP session"],
      recommendation: "Keep the ticket thread",
    });
    assert.equal(f.store.decision(decision.id).askedBy.agentId, planner);

    const answered = decisions.answer({
      id: decision.id,
      version: 1,
      answer: "Keep the ticket thread.",
      answeredBy: "operator (board)",
      relayed: false,
      note: "",
    });
    assert.equal(answered.delivery?.agentId, planner);
    assert.equal(answered.delivery?.status, "pending");
    assert.equal(answered.delivery?.attempts, 0);

    f.engine.identifyOriginHost = async (agentId) =>
      parseAgentId(agentId)?.hostId === host ? host : undefined;
    f.engine.hostAvailable = () => true;
    try {
      await f.engine.resolution.deliverDecisionNotices();
      const delivered = f.store.decision(decision.id).delivery;
      assert.equal(
        delivered?.status,
        "delivered",
        `${delivered?.status}: ${delivered?.error}`,
      );
      assert.equal(delivered?.agentId, planner);
      assert.ok((delivered?.attempts ?? 0) > 0);
      assert.equal(f.sends.length, 1);
      assert.equal(f.sends[0]!.id, plannerNative);

      const unroutable = decisions.add({
        question: "Who receives this answer?",
        askedBy: planner,
        options: ["The ticket thread", "Nowhere"],
        recommendation: "The ticket thread",
      });
      decisions.answer({
        id: unroutable.id,
        version: 1,
        answer: "The ticket thread.",
        answeredBy: "operator (board)",
        relayed: false,
        note: "",
      });
      f.engine.identifyOriginHost = async () => undefined;
      await f.engine.resolution.deliverDecisionNotices();
      const queued = f.store.decision(unroutable.id).delivery;
      assert.equal(queued?.status, "pending");
      assert.ok(
        (queued?.attempts ?? 0) > 0,
        "an unroutable identity is queued with attempts, never silently pending",
      );
      assert.match(queued?.error ?? "", /Cannot route this identity/);
      assert.equal(f.sends.length, 1, "an unroutable identity is never sent");
    } finally {
      await f.engine.stop();
    }
  } finally {
    f.store.close();
  }
});

test("project.set-planner defaults to the verified T3 caller when its ticket file is missing", async () => {
  const thread = "mcp:launch:synthetic-planner";
  const hostScope = "synthetic-desktop-scope";
  const hostId = "t3code:32be2844-7204-4edc-a95a-35b05e42ded4";
  const caller = formatAgentId(hostId, thread);
  const cli = await callerCliFixture();
  try {
    const env = {
      NUCLEUS_TICKET: join(cli.dir, "gone.json"),
      T3CODE_THREAD_ID: thread,
      T3CODE_DESKTOP_HOST_SCOPE: hostScope,
    };
    assert.deepEqual(callerSource(env, hostCallerIdentity), {
      source: "host",
      hostKind: "t3code",
      nativeAgentId: thread,
      hostScope,
    });
    const result = await cli.invoke(
      "none",
      "queue-cli.mjs",
      ["project.set-planner", "-"],
      { key: "example" },
      env,
    );
    assert.match(result.stderr, /Synthetic caller payload received/);
    assert.deepEqual(cli.hostResolutions, [
      { hostKind: "t3code", nativeAgentId: thread, hostScope },
    ]);
    assert.deepEqual(cli.calls.at(-1), {
      method: "project.set-planner",
      input: { key: "example", agentId: caller, setBy: caller },
    });
  } finally {
    await cli.close();
  }
});
