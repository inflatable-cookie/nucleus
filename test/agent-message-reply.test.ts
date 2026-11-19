import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAgentId } from "../shared/agent-identity";
import { agentMessageRecordSchema, submissionSchema, type Task } from "../shared/contracts";
import {
  AGENT_MESSAGE_REPLY_TTL_MS,
  newReplyHandle,
  REPLY_HANDLE_PREFIX,
} from "../core/questions/agent-messages";
import { projectAgentsFixture } from "./support/project-agents-fixture";

/**
 * nucleus#1387: every delivered message carries its own reply route.
 *
 * A thread that is not a task role, a project planner or a named project agent can
 * send a `tell` but could not be answered, because nothing names it. The delivered
 * message now carries a service-issued reply handle bound to its sender, and
 * `tell {to: {reply: handle}}` resolves that handle back to the sender and delivers
 * through the ordinary path. These tests exercise the real delivery, observation and
 * refusal paths against the synthetic hosts for every host kind, not a mock of them.
 */

const base = "a".repeat(40);
const plannerAgent = (host: string) => formatAgentId(host, "planner");
const threadAgent = (host: string, native: string) => formatAgentId(host, native);

/** One project planner and one plain design thread on the same host. */
async function replyFixture(host: string) {
  const f = projectAgentsFixture({ hostId: host });
  f.store.setMeta("hostId", host);
  f.store.setProjectPlanner({
    key: "example",
    agentId: plannerAgent(host),
    setBy: "operator",
  });
  f.live("planner");
  f.live("design-thread");
  f.live("other-thread");
  return f;
}

/** One live worker task in the fixture's project, so a task role can send and be answered. */
function liveWorkerTask(
  f: Awaited<ReturnType<typeof replyFixture>>,
  host: string,
  title: string,
  agentNative: string,
): Task {
  const task = f.store.insert(
    submissionSchema.parse({
      submissionId: `sub-${title}`,
      title,
      repoPath: "/synthetic/example",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: threadAgent(host, agentNative),
    }),
    host,
    "handoff",
    base,
  );
  f.store.update(task.id, {
    phase: "working",
    runId: `run-${task.id}`,
    agentId: agentNative,
    workspaceId: "ws",
  });
  f.store.putRun({
    id: `run-${task.id}`,
    taskId: task.id,
    role: "revision",
    generation: 1,
    head: base,
    agentId: agentNative,
    hostId: host,
    workspaceId: "ws",
    status: "running",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
  } as unknown as Parameters<typeof f.store.putRun>[0]);
  f.store.update(task.id, {
    resolution: {
      ...f.store.task(task.id).resolution,
      currentRunId: `run-${task.id}`,
    },
  });
  f.store.setCredential(`run-${task.id}`, `token-${task.id}`);
  return f.store.task(task.id);
}

/** A tell from a plain host thread to the project planner, returning the recorded message. */
async function threadTell(
  f: Awaited<ReturnType<typeof replyFixture>>,
  host: string,
  eventId: string,
  text: string,
) {
  const receipt = await f.engine.resolution.hostAgentMessage(
    { caller: threadAgent(host, "design-thread"), hostId: host },
    { eventId, to: { project: "example" }, text },
  );
  assert.ok(
    receipt.status === "delivered" || receipt.status === "queued",
    `${receipt.status}: ${"detail" in receipt ? receipt.detail : ""}`,
  );
  const message = f.store.message(receipt.messageId)!;
  assert.match(
    String(receipt.replyTo),
    new RegExp(`^${REPLY_HANDLE_PREFIX}`),
    "the receipt names the message's reply handle",
  );
  assert.equal(message.replyTo, receipt.replyTo);
  return { receipt, message };
}

for (const host of ["t3code:synthetic", "paseo-synthetic", "bb-synthetic"]) {
  test(`a plain thread tells a project and is answered through the delivered reply route (${host})`, async () => {
    const f = await replyFixture(host);
    try {
      const { message } = await threadTell(
        f,
        host,
        "a".repeat(64),
        "The T3 design thread needs an answer.",
      );
      // The handle is issued to this one message, valid for the bounded time, and
      // the delivered text carries the exact command that answers it.
      const expiresAt = Date.parse(String(message.replyExpiresAt));
      assert.ok(
        expiresAt - Date.now() > AGENT_MESSAGE_REPLY_TTL_MS * 0.9,
        "the handle expires after the bounded window",
      );
      assert.equal(message.toAgentId, plannerAgent(host));
      const delivered = f.sends.find((send) =>
        send.text.includes("The T3 design thread needs an answer."),
      );
      assert.ok(delivered, "the planner's thread received the message");
      assert.match(
        delivered.text,
        new RegExp(
          `Reply: nucleus tell \\{to:\\{reply:"${message.replyTo}"\\}\\}`,
        ),
        "the delivered text carries the concrete reply line",
      );

      const reply = await f.engine.resolution.hostAgentMessage(
        { caller: plannerAgent(host), hostId: host },
        {
          eventId: "b".repeat(64),
          to: { reply: String(message.replyTo) },
          text: "Answered from the planner.",
        },
      );
      assert.equal(reply.status, "delivered");
      const answer = f.sends.find((send) =>
        send.text.includes("Answered from the planner."),
      );
      assert.ok(answer, "the reply reached the design thread");
      // The reply carries its own handle, so the conversation continues both ways.
      assert.notEqual(reply.replyTo, message.replyTo);
      const replyRecord = f.store.message(reply.messageId)!;
      assert.equal(replyRecord.inReplyTo, message.id);
      assert.match(
        answer.text,
        new RegExp(
          `Reply: nucleus tell \\{to:\\{reply:"${replyRecord.replyTo}"\\}\\}`,
        ),
      );

      const back = await f.engine.resolution.hostAgentMessage(
        { caller: threadAgent(host, "design-thread"), hostId: host },
        {
          eventId: "c".repeat(64),
          to: { reply: String(reply.replyTo) },
          text: "Thanks, received.",
        },
      );
      assert.equal(back.status, "delivered");
      assert.ok(
        f.sends.some((send) => send.text.includes("Thanks, received.")),
        "the answer's own handle reaches the planner again",
      );
    } finally {
      f.store.close();
    }
  });
}

test("a reply handle used by a different thread is refused and nothing is sent", async () => {
  const host = "paseo-synthetic";
  const f = await replyFixture(host);
  try {
    const { message } = await threadTell(f, host, "a".repeat(64), "Private note.");
    const before = f.sends.length;
    await assert.rejects(
      () =>
        f.engine.resolution.hostAgentMessage(
          { caller: threadAgent(host, "other-thread"), hostId: host },
          {
            eventId: "b".repeat(64),
            to: { reply: String(message.replyTo) },
            text: "Not my message.",
          },
        ),
      /issued to another recipient/,
    );
    assert.equal(f.sends.length, before, "no delivery was attempted");
  } finally {
    f.store.close();
  }
});

test("an expired reply handle is refused with the fact", async () => {
  const host = "paseo-synthetic";
  const f = await replyFixture(host);
  try {
    const { message } = await threadTell(f, host, "a".repeat(64), "Old note.");
    const expired = new Date(Date.now() - 60_000).toISOString();
    f.store.putMessage({ ...message, replyExpiresAt: expired });
    const before = f.sends.length;
    await assert.rejects(
      () =>
        f.engine.resolution.hostAgentMessage(
          { caller: plannerAgent(host), hostId: host },
          {
            eventId: "b".repeat(64),
            to: { reply: String(message.replyTo) },
            text: "Too late.",
          },
        ),
      /expired on .*; nothing was sent/,
    );
    assert.equal(f.sends.length, before);
  } finally {
    f.store.close();
  }
});

test("a sender archived after sending refuses the reply and is never revived", async () => {
  const host = "t3code:synthetic";
  const f = await replyFixture(host);
  try {
    const { message } = await threadTell(f, host, "a".repeat(64), "Before archiving.");
    f.observed.set("design-thread", {
      archived: true,
      status: "idle",
      active: false,
      updatedAt: "2026-11-19T10:00:00.000Z",
    });
    const before = f.sends.length;
    await assert.rejects(
      () =>
        f.engine.resolution.hostAgentMessage(
          { caller: plannerAgent(host), hostId: host },
          {
            eventId: "b".repeat(64),
            to: { reply: String(message.replyTo) },
            text: "Anyone there?",
          },
        ),
      /archived or gone; the reply was refused and that thread will not be revived/,
    );
    assert.equal(f.sends.length, before, "nothing was delivered into the archived thread");
    assert.equal(f.observed.get("design-thread")?.archived, true, "the thread stayed archived");
  } finally {
    f.store.close();
  }
});

test("a task role's tell is answered through its handle into the worker's thread", async () => {
  const host = "paseo-synthetic";
  const f = await replyFixture(host);
  try {
    const task = liveWorkerTask(f, host, "handled task", "worker");
    f.live("worker");
    const receipt = await f.engine.resolution.agentMessage(
      {
        eventId: "a".repeat(64),
        taskId: task.id,
        runId: `run-${task.id}`,
        to: { project: "example" },
        text: "Worker here; the design note matters to this task.",
      },
      `token-${task.id}`,
    );
    assert.ok(receipt.replyTo, "the worker's message carries a handle");
    // The planner answers the worker directly through the message's own address.
    const reply = await f.engine.resolution.hostAgentMessage(
      { caller: plannerAgent(host), hostId: host },
      {
        eventId: "b".repeat(64),
        to: { reply: String(receipt.replyTo) },
        text: "Planner acknowledges.",
      },
    );
    assert.equal(reply.status, "delivered");
    assert.ok(
      f.sends.some(
        (send) => send.id === "worker" && send.text.includes("Planner acknowledges."),
      ),
      "the reply reached the worker's thread, not a planner",
    );
  } finally {
    f.store.close();
  }
});

test("ask through a handle reaches a project planner and refuses any other sender", async () => {
  const host = "paseo-synthetic";
  const f = await replyFixture(host);
  try {
    const task = liveWorkerTask(f, host, "asking task", "worker");
    const run = { role: "revision" as const, agentId: "worker", hostId: host };
    // A message a project planner sent, with its own handle.
    const plannerMessage = agentMessageRecordSchema.parse({
      id: "planner-message",
      contentKey: "planner-content",
      fromTaskId: "project:example",
      fromRole: "planner",
      fromAgentId: plannerAgent(host),
      fromHostId: host,
      fromReference: "the example planner",
      fromProject: "Example",
      toTaskId: task.id,
      toRole: "worker",
      toAgentId: "worker",
      toHostId: host,
      toReference: task.reference,
      replyTo: newReplyHandle(),
      replyExpiresAt: new Date(Date.now() + AGENT_MESSAGE_REPLY_TTL_MS).toISOString(),
      inReplyTo: null,
      textDigest: "d".repeat(64),
      text: "Planner's note to the worker.",
      status: "delivered",
      createdAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      error: "",
    });
    f.store.putMessage(plannerMessage);
    const route = await f.engine.resolution.agentAsks.resolveAskRoute(
      task,
      run,
      { kind: "reply", reply: String(plannerMessage.replyTo) },
      "process",
    );
    assert.equal(route.target, "planner");
    assert.deepEqual(route.route, {
      kind: "reply",
      agentId: plannerAgent(host),
    });

    // A plain host thread's handle cannot be asked: it has no planning authority.
    const hostThreadMessage = agentMessageRecordSchema.parse({
      id: "host-thread-message",
      contentKey: "host-thread-content",
      fromTaskId: `host:${threadAgent(host, "design-thread")}`,
      fromRole: "agent",
      fromAgentId: threadAgent(host, "design-thread"),
      fromHostId: host,
      fromReference: threadAgent(host, "design-thread"),
      fromProject: null,
      toTaskId: task.id,
      toRole: "worker",
      toAgentId: "worker",
      toHostId: host,
      toReference: task.reference,
      replyTo: newReplyHandle(),
      replyExpiresAt: new Date(Date.now() + AGENT_MESSAGE_REPLY_TTL_MS).toISOString(),
      inReplyTo: null,
      textDigest: "e".repeat(64),
      text: "Host thread note to the worker.",
      status: "delivered",
      createdAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      error: "",
    });
    f.store.putMessage(hostThreadMessage);
    await assert.rejects(
      () =>
        f.engine.resolution.agentAsks.resolveAskRoute(
          task,
          run,
          { kind: "reply", reply: String(hostThreadMessage.replyTo) },
          "process",
        ),
      /a reply handle asks a project planner or agent, so answer this sender with tell/,
    );
  } finally {
    f.store.close();
  }
});
