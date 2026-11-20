import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  ACP_MODELS,
  ACP_PROTOCOL_VERSION,
  AcpAgent,
  type AcpAgentOptions,
  type AcpMessageRequest,
  type AcpSessionTransport,
  type AcpTurnReply,
  type AcpTurnRequest,
} from "../shared/acp/agent";
import { isLegacyT3Hold, T3_HOLD_TEXT } from "../shared/acp/t3-hold";
import { runAcpAgentFromEnvironment } from "../shared/acp/entry";
import { createAcpTransport } from "../shared/acp/transport";
import { createServer } from "node:http";
import { acpBindingSchema, type AcpBinding } from "../shared/acp/binding";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Spec 065: the ACP agent driven over stdio, exactly as a client drives it — one
 * JSON-RPC object per line in, one per line out. The service is a scripted transport,
 * so every case is the protocol's own behaviour rather than a service's.
 */

type Json = Record<string, unknown>;

const binding: AcpBinding = acpBindingSchema.parse({
  format: "nucleus.acp.binding",
  version: 1,
  sessionId: "6b1d4e1a-9c1f-4f80-9b0b-3a0e1a6f2c11",
  taskId: "task-1",
  socketPath: "/nonexistent/callback.sock",
  token: "fixture-token",
});

/** The service, scripted: queued answers first, then one mutable default the test can change. */
class ScriptedTransport implements AcpSessionTransport {
  readonly turns: AcpTurnRequest[] = [];
  readonly messages: AcpMessageRequest[] = [];
  readonly answers: import("../shared/acp/surface").AcpAnswerInput[] = [];
  openUi?: (
    input: import("../shared/acp/surface").AcpInboxUiInput,
    signal: AbortSignal,
  ) => Promise<import("../shared/acp/surface").AcpInboxUiReply>;
  answer(
    input: import("../shared/acp/surface").AcpAnswerInput,
  ): Promise<unknown> {
    this.answers.push(input);
    return Promise.resolve({});
  }
  /** Answers waiting to be handed out, in order. */
  readonly replies: AcpTurnReply[];
  /** The answer every call without a queued one receives. */
  defaultReply: AcpTurnReply = reply("hold");
  /** A turn that never settles until the caller cancels, for the cancel case. */
  hang = false;
  constructor(replies: AcpTurnReply[] = []) {
    this.replies = replies;
  }
  /** Let the next held poll release, the way the service does when the task settles. */
  release(reason = "released"): void {
    this.replies.push(reply("release", [reason]));
  }
  turn(input: AcpTurnRequest, signal: AbortSignal): Promise<AcpTurnReply> {
    this.turns.push(input);
    if (this.hang)
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              Object.assign(new Error("cancelled"), { name: "AbortError" }),
            ),
          { once: true },
        );
      });
    return Promise.resolve(this.replies.shift() ?? this.defaultReply);
  }
  message(
    input: AcpMessageRequest,
  ): Promise<{ receipt: { status: string; detail?: string } }> {
    this.messages.push(input);
    return Promise.resolve({ receipt: { status: "delivered" } });
  }
}

/** Wait until the held turn has made its nth service call, so a release lands on a held poll. */
async function turnStarted(
  transport: ScriptedTransport,
  calls: number,
): Promise<void> {
  for (let waited = 0; transport.turns.length < calls && waited < 400; waited++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    transport.turns.length >= calls,
    true,
    `the turn made ${calls} service calls`,
  );
}

const reply = (
  state: "hold" | "release",
  messages: string[] = [],
): AcpTurnReply => ({
  state,
  reason: state === "hold" ? "the task is working" : "the task is done",
  messages,
  task: {
    taskId: "task-1",
    reference: "nucleus#1304",
    phase: state === "hold" ? "working" : "done",
    name: "nucleus#1304",
  },
});

/** A line-addressed view of the agent's output, so a test can await the next message. */
function lineReader(stream: PassThrough) {
  const queued: Json[] = [];
  const waiters: Array<(value: Json) => void> = [];
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (
      let index = buffer.indexOf("\n");
      index >= 0;
      index = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Json;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queued.push(message);
    }
  });
  return {
    next(): Promise<Json> {
      const queuedMessage = queued.shift();
      if (queuedMessage) return Promise.resolve(queuedMessage);
      return new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("the agent wrote nothing in time")),
          5_000,
        );
        timer.unref?.();
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    /** Everything the agent wrote after the given message, up to a result for `id`. */
    async untilResult(id: number): Promise<{ updates: Json[]; result: Json }> {
      const updates: Json[] = [];
      for (;;) {
        const message = await this.next();
        if (message.id === id) return { updates, result: message };
        updates.push(message);
      }
    },
    get pending(): Json[] {
      return [...queued];
    },
  };
}

function harness(
  options: { replies?: AcpTurnReply[]; agent?: Partial<AcpAgentOptions> } = {},
) {
  const transport = new ScriptedTransport(options.replies);
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = lineReader(output);
  const agent = new AcpAgent({
    resolve: async () => ({ binding, transport }),
    turnWaitMs: 5,
    retryDelayMs: 2,
    ...options.agent,
  });
  const running = agent.run(input, output);
  let nextId = 1;
  return {
    agent,
    transport,
    lines,
    request(method: string, params: unknown): number {
      const id = nextId++;
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      return id;
    },
    respond(id: unknown, result: unknown): void {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    },
    notify(method: string, params: unknown): void {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    async closed(): Promise<void> {
      input.end();
      await running;
    },
  };
}

test("initialize advertises loadSession, two models and the Nucleus identity", async () => {
  const client = harness();
  const initialized = await client.lines.untilResult(
    client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    }),
  );
  const result = initialized.result.result as Json;
  assert.equal(result.protocolVersion, ACP_PROTOCOL_VERSION);
  assert.equal(
    (result.agentCapabilities as Json).loadSession,
    true,
    "session/load must be advertised: T3 fails every turn without it",
  );
  assert.equal((result.agentInfo as Json).name, "nucleus");
  assert.equal(
    ACP_MODELS.length >= 2,
    true,
    "an ACP client may require at least two models",
  );
  await client.closed();
});

test("session/new binds the thread's working directory and answers with the two display models", async () => {
  const client = harness();
  const id = client.request("session/new", {
    cwd: "/fixture/checkout",
    mcpServers: [],
  });
  const { result } = await client.lines.untilResult(id);
  const session = result.result as Json;
  assert.equal(session.sessionId, binding.sessionId);
  assert.deepEqual(
    (session.models as Json).currentModelId,
    ACP_MODELS[0].modelId,
  );
  assert.equal(
    ((session.models as Json).availableModels as unknown[]).length,
    ACP_MODELS.length,
  );
  assert.equal(
    client.transport.turns.length,
    1,
    "session/new attaches to the service once",
  );
  assert.equal(
    client.transport.turns[0]!.waitMs,
    0,
    "the opening attach never holds the turn",
  );
  assert.equal(
    client.transport.turns[0]!.attach,
    true,
    "and it asks for the current lifecycle line, not only a change",
  );
  await client.closed();
});

test("session/load accepts its own session id, shows where the task stands, and replays no history", async () => {
  const client = harness({
    replies: [reply("hold", ["nucleus#1304 · Working"])],
  });
  const id = client.request("session/load", {
    sessionId: binding.sessionId,
    cwd: "/fixture/checkout",
    mcpServers: [],
  });
  const { updates, result } = await client.lines.untilResult(id);
  assert.equal((result.result as Json).sessionId, binding.sessionId);
  // The load answer comes first and the current lifecycle line follows it as one update.
  const reloaded = await client.lines.next();
  assert.equal(reloaded.method, "session/update");
  assert.match(JSON.stringify(reloaded), /Working/);
  assert.deepEqual(
    updates,
    [],
    "nothing but that line is replayed: Nucleus holds the history",
  );
  await client.closed();
});

test("each lifecycle line is its own paragraph on the wire", async () => {
  const client = harness({
    replies: [reply("hold", ["nucleus#1304 · Working"])],
  });
  const id = client.request("session/load", {
    sessionId: binding.sessionId,
    cwd: "/fixture/checkout",
    mcpServers: [],
  });
  await client.lines.untilResult(id);
  const shown = await client.lines.next();
  const content = ((shown.params as Json).update as Json).content as Json;
  // Clients join chunks without a separator, so a line without its paragraph break runs into the next one.
  assert.equal(content.text, "nucleus#1304 · Working\n\n");
  await client.closed();
});

test("session/load refuses a session id the binding does not hold", async () => {
  const client = harness();
  const id = client.request("session/load", {
    sessionId: "5b1d4e1a-0000-4000-8000-000000000000",
    cwd: "/fixture/checkout",
  });
  const { result } = await client.lines.untilResult(id);
  const error = result.error as Json;
  assert.equal(error.code, -32000);
  assert.match(String(error.message), /binding is session/);
  assert.equal(
    client.transport.turns.length,
    0,
    "a refused load never touches the service",
  );
  await client.closed();
});

test("the opening prompt holds the turn, shows the lifecycle line, and ends when the service releases it", async () => {
  const client = harness({
    replies: [
      reply("hold", ["nucleus#1304 · Working"]),
      reply("release", ["nucleus#1304 finished · Done"]),
    ],
  });
  const opened = client.request("session/new", { cwd: "/fixture/checkout" });
  await client.lines.untilResult(opened);
  const prompt = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "Synthetic task brief" }],
  });
  const { updates, result } = await client.lines.untilResult(prompt);
  assert.deepEqual(result.result, { stopReason: "end_turn" });
  const text = JSON.stringify(updates);
  assert.match(text, /Working/, "the first prompt shows the attach line");
  assert.match(
    text,
    /finished · Done/,
    "the release line is shown before the turn ends",
  );
  assert.equal(
    client.transport.messages.length,
    0,
    "the thread's opening prompt is not an operator message",
  );
  assert.equal(
    client.transport.turns.length,
    2,
    "attach, then the poll that released the turn",
  );
  await client.closed();
});

test("a later prompt forwards the operator's text and holds again", async () => {
  const client = harness();
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const first = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "opening" }],
  });
  await turnStarted(client.transport, 2);
  client.transport.release();
  await client.lines.untilResult(first);
  const second = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "please check the CI log" }],
  });
  await turnStarted(client.transport, 3);
  client.transport.release();
  await client.lines.untilResult(second);
  assert.equal(client.transport.messages.length, 1);
  assert.equal(client.transport.messages[0]!.text, "please check the CI log");
  assert.equal(client.transport.messages[0]!.taskId, binding.taskId);
  assert.match(client.transport.messages[0]!.eventId, /^[a-f0-9]{64}$/);
  assert.equal(
    client.transport.messages[0]!.eventId,
    client.transport.messages[0]!.eventId.toLowerCase(),
  );
  await client.closed();
});

test("an injected ignore rule ends the prompt silently: no text shown, nothing forwarded", async () => {
  const client = harness({
    agent: {
      ignore: (text) => text.includes("Delegated task node:delegated-task:"),
    },
  });
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const prompt = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [
      {
        type: "text",
        text: "Delegated task node:delegated-task:abc [completed]",
      },
    ],
  });
  const { updates, result } = await client.lines.untilResult(prompt);
  assert.deepEqual(result.result, { stopReason: "end_turn" });
  assert.equal(
    updates.length,
    0,
    "an ignored wake prompt is never shown as the agent's words",
  );
  assert.equal(
    client.transport.messages.length,
    0,
    "and never forwarded as the operator's",
  );
  assert.equal(
    client.transport.turns.length,
    1,
    "only the attach call reached the service",
  );
  await client.closed();
});

test("legacy T3 compatibility reserves only the exact readable sentence for the old binding", () => {
  assert.equal(
    isLegacyT3Hold("nucleus-hold-the-task-thread", T3_HOLD_TEXT),
    true,
  );
  assert.equal(isLegacyT3Hold("other", T3_HOLD_TEXT), false);
  assert.equal(
    isLegacyT3Hold(
      "nucleus-hold-the-task-thread",
      `${T3_HOLD_TEXT} Please help`,
    ),
    false,
  );
});

test("an injected hold rule keeps the turn without showing or forwarding the host's re-entry", async () => {
  // A host that released the thread re-enters it to parent its next child: the prompt
  // is configuration, so it is never shown as the agent's words and never forwarded as
  // the operator's, but the turn is held — which is the whole point of the re-entry.
  const client = harness({
    agent: {
      hold: (text) => isLegacyT3Hold("nucleus-hold-the-task-thread", text),
    },
  });
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const opening = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "opening" }],
  });
  await turnStarted(client.transport, 2);
  client.transport.release();
  await client.lines.untilResult(opening);
  const pollsBefore = client.transport.turns.length;
  const reentry = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: T3_HOLD_TEXT }],
  });
  await turnStarted(client.transport, pollsBefore + 1);
  assert.equal(
    client.transport.messages.length,
    0,
    "the re-entry is never the operator's message",
  );
  // It holds: the service's release is what ends it, exactly as for a held turn, and
  // the host's marker is never shown as the agent's own words.
  client.transport.release();
  const { updates, result } = await client.lines.untilResult(reentry);
  assert.deepEqual(result.result, { stopReason: "end_turn" });
  assert.equal(
    updates.some((update) =>
      JSON.stringify(update).includes("nucleus-hold-the-task-thread"),
    ),
    false,
    "a re-entry prompt is never shown as the agent's words",
  );
  // The re-entry's release repeats the line the session already showed, so nothing new is sent.
  assert.equal(
    updates.length,
    0,
    "an identical line the session already showed is not sent again",
  );
  // The operator's next message still forwards: one re-entry does not consume the thread.
  const operator = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "what is left?" }],
  });
  await turnStarted(client.transport, 5);
  client.transport.release();
  await client.lines.untilResult(operator);
  assert.equal(client.transport.messages.length, 1);
  assert.equal(client.transport.messages[0]!.text, "what is left?");
  await client.closed();
});

test("a hold rule and an ignore rule stay distinct: an ignored prompt ends the turn", async () => {
  const client = harness({
    agent: {
      hold: (text) => text.includes("nucleus-hold-the-task-thread"),
      ignore: (text) => text.includes("Delegated task node:delegated-task:"),
    },
  });
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const opening = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "opening" }],
  });
  await turnStarted(client.transport, 2);
  client.transport.release();
  await client.lines.untilResult(opening);
  const pollsBefore = client.transport.turns.length;
  const wake = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [
      {
        type: "text",
        text: "Delegated task node:delegated-task:abc [completed]",
      },
    ],
  });
  const { result } = await client.lines.untilResult(wake);
  assert.deepEqual(result.result, { stopReason: "end_turn" });
  assert.equal(
    client.transport.turns.length,
    pollsBefore,
    "an ignored prompt never reaches the service",
  );
  assert.equal(client.transport.messages.length, 0);
  await client.closed();
});

test("a wake prompt arriving first consumes the opening slot, so the operator's next message is forwarded", async () => {
  const client = harness({
    agent: {
      ignore: (text) => text.includes("Delegated task node:delegated-task:"),
    },
  });
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const wake = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [
      {
        type: "text",
        text: "Delegated task node:delegated-task:wake [completed]",
      },
    ],
  });
  await client.lines.untilResult(wake);
  assert.equal(
    client.transport.messages.length,
    0,
    "the wake itself is never forwarded",
  );
  // The operator's text may hold, so release it from the service's side.
  const operator = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "carry on with the review" }],
  });
  await turnStarted(client.transport, 2);
  client.transport.release();
  await client.lines.untilResult(operator);
  assert.equal(client.transport.messages.length, 1);
  assert.equal(client.transport.messages[0]!.text, "carry on with the review");
  await client.closed();
});

test("an empty first prompt also consumes the opening slot", async () => {
  const client = harness();
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const empty = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [],
  });
  const emptyAnswer = await client.lines.untilResult(empty);
  assert.deepEqual(emptyAnswer.result.result, { stopReason: "end_turn" });
  const operator = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "what is left?" }],
  });
  await turnStarted(client.transport, 2);
  client.transport.release();
  await client.lines.untilResult(operator);
  assert.equal(client.transport.messages.length, 1);
  assert.equal(client.transport.messages[0]!.text, "what is left?");
  await client.closed();
});

test("session/cancel ends a held turn at once, and the next prompt holds again", async () => {
  const client = harness();
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  client.transport.hang = true;
  const prompt = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "opening" }],
  });
  // Wait until the turn is actually in flight before cancelling it.
  await turnStarted(client.transport, 2);
  client.notify("session/cancel", { sessionId: binding.sessionId });
  const { result } = await client.lines.untilResult(prompt);
  assert.deepEqual(result.result, { stopReason: "cancelled" });
  // The client steers by cancelling and sending the person's text as a new prompt.
  client.transport.hang = false;
  client.transport.defaultReply = reply("release");
  const steered = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "try the other branch" }],
  });
  const next = await client.lines.untilResult(steered);
  assert.deepEqual(next.result.result, { stopReason: "end_turn" });
  assert.equal(client.transport.messages.length, 1);
  assert.equal(client.transport.messages[0]!.text, "try the other branch");
  await client.closed();
});

test("a prompt while another turn is in flight is refused rather than queued", async () => {
  const client = harness();
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  client.transport.hang = true;
  const first = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "opening" }],
  });
  await turnStarted(client.transport, 2);
  const second = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "second" }],
  });
  const secondAnswer = await client.lines.untilResult(second);
  assert.equal((secondAnswer.result.error as Json).code, -32602);
  assert.match(
    String((secondAnswer.result.error as Json).message),
    /already in flight/,
  );
  client.notify("session/cancel", { sessionId: binding.sessionId });
  await client.lines.untilResult(first);
  await client.closed();
});

/** The next agent message that matches, skipping the lines a prompt shows first. */
async function nextMatching(
  lines: ReturnType<typeof lineReader>,
  matches: (message: Json) => boolean,
): Promise<Json> {
  for (;;) {
    const message = await lines.next();
    if (matches(message)) return message;
  }
}

/** The fault line a held turn shows for one outage, counted in the agent's output. */
const faultLines = (updates: Json[]): number =>
  updates.filter((update) =>
    JSON.stringify(update).includes("Nucleus is unreachable"),
  ).length;

test("a service that is unreachable mid-turn holds the turn quietly: one fault line, the same session, released only by the service", async () => {
  let resolves = 0;
  let polls = 0;
  const transport: AcpSessionTransport = {
    turn: async (input: AcpTurnRequest) => {
      if (input.waitMs === 0) return reply("hold", ["nucleus#1304 · Working"]);
      polls += 1;
      if (polls <= 6)
        throw new Error("connect ENOENT /nonexistent/callback.sock");
      return reply("release", ["nucleus#1304 · Done"]);
    },
    message: async () => ({ receipt: { status: "delivered" } }),
  };
  const client = harness({
    agent: {
      faultLineAfter: 2,
      retryDelayMs: 1,
      retryMaxDelayMs: 4,
      async resolve() {
        resolves += 1;
        return { binding, transport };
      },
    },
  });
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const prompt = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "opening" }],
  });
  const { updates, result } = await client.lines.untilResult(prompt);
  assert.deepEqual(
    result.result,
    { stopReason: "end_turn" },
    "the turn ends when the service releases it, not when the socket fails",
  );
  assert.equal(
    polls,
    7,
    "six failed polls, then the poll that the service answers",
  );
  assert.equal(
    resolves,
    1,
    "the outage re-mints nothing: one binding, one session",
  );
  assert.equal(
    faultLines(updates),
    1,
    "a sustained outage shows one fault line",
  );
  const text = JSON.stringify(updates);
  assert.match(text, /resumes when Nucleus answers/);
  assert.match(text, /ENOENT/);
  assert.doesNotMatch(text, /ending this turn/);
  assert.match(
    text,
    /nucleus#1304 · Done/,
    "the service's line after recovery is shown",
  );
  await client.closed();
});

test("each outage shows its own fault line, even when the failure reads the same as the last", async () => {
  let polls = 0;
  const transport: AcpSessionTransport = {
    turn: async (input: AcpTurnRequest) => {
      if (input.waitMs === 0) return reply("hold", ["nucleus#1304 · Working"]);
      polls += 1;
      // Two outages of three failed polls each, separated by one answered poll, then release.
      if ((polls >= 1 && polls <= 3) || (polls >= 5 && polls <= 7))
        throw new Error("connect ENOENT /nonexistent/callback.sock");
      if (polls === 4 || polls === 8) return reply("hold");
      return reply("release", ["nucleus#1304 · Done"]);
    },
    message: async () => ({ receipt: { status: "delivered" } }),
  };
  const client = harness({
    agent: {
      faultLineAfter: 3,
      retryDelayMs: 1,
      retryMaxDelayMs: 2,
      async resolve() {
        return { binding, transport };
      },
    },
  });
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const prompt = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "opening" }],
  });
  const { updates, result } = await client.lines.untilResult(prompt);
  assert.deepEqual(result.result, { stopReason: "end_turn" });
  assert.equal(
    faultLines(updates),
    2,
    "a repeated identical outage is shown again, not suppressed as a repeat of the last line",
  );
  await client.closed();
});

test("a socket replaced while the turn is held resumes the same session, with an open decision still one card", async () => {
  const question = {
    id: "decision-1",
    version: 1,
    headline: "Choose a path",
    question: "Which path?",
    choices: [{ label: "Yes", consequence: "Proceed" }],
  };
  let polls = 0;
  const transport: AcpSessionTransport & {
    answers: import("../shared/acp/surface").AcpAnswerInput[];
  } = {
    answers: [],
    turn: async (input: AcpTurnRequest) => {
      if (input.waitMs === 0) return reply("hold", ["nucleus#1304 · Working"]);
      polls += 1;
      // Poll 1 raises the card; the socket is replaced for polls 2-4; the new socket
      // answers poll 5 with the same version still offered and the turn still held.
      if (polls === 1) return { ...reply("hold"), elicitations: [question] };
      if (polls <= 4) throw new Error("connect ECONNREFUSED callback.sock");
      if (polls === 5) return { ...reply("hold"), elicitations: [question] };
      return reply("release", ["nucleus#1304 · Done"]);
    },
    message: async () => ({ receipt: { status: "delivered" } }),
    answer: async (input) => {
      transport.answers.push(input);
      return {};
    },
  };
  let resolves = 0;
  const client = harness({
    agent: {
      retryDelayMs: 1,
      retryMaxDelayMs: 2,
      faultLineAfter: 2,
      async resolve() {
        resolves += 1;
        return { binding, transport };
      },
    },
  });
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const prompt = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "opening" }],
  });
  const card = await nextMatching(
    client.lines,
    (message) => message.method === "elicitation/create",
  );
  client.respond(card.id, {
    action: "accept",
    content: { "nucleus_decision-1_1": "Yes" },
  });
  for (let i = 0; i < 200 && transport.answers.length < 1; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    transport.answers.map((row) => [
      row.id,
      "answer" in row ? row.answer : null,
    ]),
    [["decision-1", "Yes"]],
    "the answer routes on the same session after the socket returns",
  );
  const { updates, result } = await client.lines.untilResult(prompt);
  assert.deepEqual(result.result, { stopReason: "end_turn" });
  assert.equal(
    resolves,
    1,
    "the same binding and session carried the whole outage",
  );
  assert.equal(
    polls,
    6,
    "poll 5 re-offered the version and the card was not raised again",
  );
  assert.equal(faultLines(updates), 1);
  await client.closed();
});

test("session/cancel ends a turn waiting out an outage at once, not after the backoff", async () => {
  const client = harness({
    agent: {
      faultLineAfter: 1,
      retryDelayMs: 60_000,
      retryMaxDelayMs: 60_000,
      async resolve() {
        return {
          binding,
          transport: {
            turn: async (input: AcpTurnRequest) => {
              if (input.waitMs === 0)
                return reply("hold", ["nucleus#1304 · Working"]);
              throw new Error("connect ENOENT /nonexistent/callback.sock");
            },
            message: async () => ({ receipt: { status: "delivered" } }),
          } satisfies AcpSessionTransport,
        };
      },
    },
  });
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const prompt = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "opening" }],
  });
  // The fault line shows the outage has begun, so the turn is now in its backoff.
  await nextMatching(client.lines, (message) =>
    JSON.stringify(message).includes("Nucleus is unreachable"),
  );
  client.notify("session/cancel", { sessionId: binding.sessionId });
  const { result } = await client.lines.untilResult(prompt);
  assert.deepEqual(result.result, { stopReason: "cancelled" });
  await client.closed();
});

test("a refused credential is permanent: the held turn ends once with its reason instead of holding forever", async () => {
  const client = harness({
    agent: {
      retryDelayMs: 1,
      async resolve() {
        return {
          binding,
          transport: {
            turn: async (input: AcpTurnRequest) => {
              if (input.waitMs === 0)
                return reply("hold", ["nucleus#1304 · Working"]);
              throw Object.assign(new Error("unauthorized"), { status: 401 });
            },
            message: async () => ({ receipt: { status: "delivered" } }),
          } satisfies AcpSessionTransport,
        };
      },
    },
  });
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const prompt = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "opening" }],
  });
  const { updates, result } = await client.lines.untilResult(prompt);
  assert.deepEqual(result.result, { stopReason: "end_turn" });
  const text = JSON.stringify(updates);
  assert.match(text, /refused this session's credential/);
  assert.doesNotMatch(text, /resumes when Nucleus answers/);
  await client.closed();
});

test("the callback socket's refusal reaches the agent with its status, and a socket that is gone carries none", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "acp-socket-"));
  const socketPath = join(dir, "callback.sock");
  const server = createServer((_request, response) => {
    response.statusCode = 401;
    response.end("unauthorized");
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const input: AcpTurnRequest = {
    kind: "task",
    taskId: binding.taskId,
    sessionId: binding.sessionId,
    waitMs: 0,
  } as AcpTurnRequest;
  try {
    await assert.rejects(
      createAcpTransport({ ...binding, socketPath }).turn(
        input,
        new AbortController().signal,
      ),
      (error: unknown) =>
        (error as { status?: unknown }).status === 401 &&
        /unauthorized/.test((error as Error).message),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
  await assert.rejects(
    createAcpTransport({
      ...binding,
      socketPath: join(dir, "gone.sock"),
    }).turn(input, new AbortController().signal),
    (error: unknown) => (error as { status?: unknown }).status === undefined,
    "an absent socket is an outage, which the held turn retries",
  );
});

test("a session open that meets a socket gap waits on the same backoff, and a refused credential refuses at once", async () => {
  let attaches = 0;
  const transport: AcpSessionTransport = {
    turn: async (input: AcpTurnRequest) => {
      if (input.waitMs === 0) {
        attaches += 1;
        // The first two attaches meet the gap; the third reaches the socket again.
        if (attaches <= 2)
          throw new Error("connect ENOENT /nonexistent/callback.sock");
        return reply("hold", ["nucleus#1304 · Working"]);
      }
      return reply("release", ["nucleus#1304 · Done"]);
    },
    message: async () => ({ receipt: { status: "delivered" } }),
  };
  const client = harness({
    agent: {
      retryDelayMs: 1,
      async resolve() {
        return { binding, transport };
      },
    },
  });
  const opened = await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  assert.equal(
    (opened.result.result as Json).sessionId,
    binding.sessionId,
    "the session opens on the same binding once the socket answers",
  );
  assert.equal(attaches, 3, "two gap attaches, then the answered one");
  await client.closed();

  let refusedAttaches = 0;
  const refused = harness({
    agent: {
      retryDelayMs: 1,
      async resolve() {
        return {
          binding,
          transport: {
            turn: async () => {
              refusedAttaches += 1;
              throw Object.assign(new Error("unauthorized"), { status: 401 });
            },
            message: async () => ({ receipt: { status: "delivered" } }),
          } satisfies AcpSessionTransport,
        };
      },
    },
  });
  const rejected = await refused.lines.untilResult(
    refused.request("session/new", { cwd: "/fixture/checkout" }),
  );
  assert.match(
    String((rejected.result.error as Json).message),
    /Nucleus is unreachable/,
  );
  assert.equal(refusedAttaches, 1, "a refused credential is not retried");
  await refused.closed();
});

test("a service that cannot be reached at session/new refuses the session instead of inventing one", async () => {
  const client = harness({
    agent: {
      async resolve() {
        return {
          binding,
          transport: {
            turn: async () => {
              throw new Error("connect ENOENT");
            },
            message: async () => ({ receipt: { status: "delivered" } }),
          },
        };
      },
    },
  });
  const id = client.request("session/new", { cwd: "/fixture/checkout" });
  const { result } = await client.lines.untilResult(id);
  assert.equal((result.error as Json).code, -32000);
  assert.match(
    String((result.error as Json).message),
    /Nucleus is unreachable/,
  );
  await client.closed();
});

test("unknown methods, unknown sessions and unknown models are refused with their own codes", async () => {
  const client = harness();
  const unknown = await client.lines.untilResult(
    client.request("session/nonsense", {}),
  );
  assert.equal((unknown.result.error as Json).code, -32601);
  const session = await client.lines.untilResult(
    client.request("session/prompt", {
      sessionId: "no-such-session",
      prompt: [],
    }),
  );
  assert.equal((session.result.error as Json).code, -32602);
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  const model = await client.lines.untilResult(
    client.request("session/set_model", {
      sessionId: binding.sessionId,
      modelId: "gpt-9000",
    }),
  );
  assert.equal((model.result.error as Json).code, -32602);
  const accepted = await client.lines.untilResult(
    client.request("session/set_model", {
      sessionId: binding.sessionId,
      modelId: ACP_MODELS[1].modelId,
    }),
  );
  assert.deepEqual(accepted.result.result, {});
  await client.closed();
});

test("closing the client's stdio ends a held turn instead of leaving the agent holding it", async () => {
  const client = harness();
  await client.lines.untilResult(
    client.request("session/new", { cwd: "/fixture/checkout" }),
  );
  client.transport.hang = true;
  const prompt = client.request("session/prompt", {
    sessionId: binding.sessionId,
    prompt: [{ type: "text", text: "opening" }],
  });
  await turnStarted(client.transport, 2);
  // A host that shuts down closes stdio; `closed()` only resolves once the turn ended.
  const closing = client.closed();
  const { result } = await client.lines.untilResult(prompt);
  assert.deepEqual(
    result.result,
    { stopReason: "cancelled" },
    "the held turn ends with the stream",
  );
  await closing;
});

test("an unbound directory opens an inert session but cannot prompt or load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-acp-entry-"));
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = lineReader(output);
    const errors: string[] = [];
    const running = runAcpAgentFromEnvironment({
      env: { HOME: dir, NUCLEUS_DATA_HOME: dir },
      cwd: dir,
      stdin: input,
      stdout: output,
      stderr: {
        write: (line: string) => {
          errors.push(line);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
    });
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: dir, mcpServers: [] } })}\n`,
    );
    const { result } = await lines.untilResult(1);
    const opened = result.result as Json;
    const models = opened.models as Json;
    assert.deepEqual(
      (models.availableModels as Json[]).map((model) => model.modelId),
      ["nucleus", "nucleus-quiet"],
    );
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: opened.sessionId, prompt: [] } })}\n`,
    );
    const prompt = (await lines.untilResult(2)).result.error as Json;
    assert.notEqual(prompt.code, -32000);
    assert.match(
      String(prompt.message),
      /No Nucleus task is bound to this directory; Nucleus opens task threads itself/i,
    );
    assert.doesNotMatch(
      String(prompt.message),
      /authenticat|credentials|log in/i,
    );
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/load", params: { cwd: dir, sessionId: opened.sessionId } })}\n`,
    );
    assert.equal(
      ((await lines.untilResult(3)).result.error as Json).code,
      -32000,
    );
    input.end();
    assert.equal(
      await running,
      0,
      "a client closing stdin is an ordinary exit",
    );
    assert.deepEqual(
      errors,
      [],
      "nothing is logged for a session refusal; the client shows it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an inbox session holds with its host identity and never forwards stale prompt text as a task message", async () => {
  const transport = new ScriptedTransport();
  const inbox = {
    format: "nucleus.acp.inbox" as const,
    version: 1 as const,
    kind: "inbox" as const,
    hostId: "t3code:synthetic",
    sessionId: "6b1d4e1a-9c1f-4f80-9b0b-3a0e1a6f2c11",
    socketPath: "/nonexistent/callback.sock",
    token: "fixture-token",
  };
  const client = harness({
    agent: { resolve: async () => ({ binding: inbox, transport }) },
  });
  try {
    await client.lines.untilResult(
      client.request("session/load", {
        sessionId: inbox.sessionId,
        cwd: "/synthetic",
      }),
    );
    const prompt = client.request("session/prompt", {
      sessionId: inbox.sessionId,
      prompt: [{ type: "text", text: "stale card answer" }],
    });
    await turnStarted(transport, 2);
    assert.deepEqual(transport.turns[0], {
      kind: "inbox",
      hostId: inbox.hostId,
      sessionId: inbox.sessionId,
      waitMs: 0,
      attach: true,
    });
    assert.equal(transport.messages.length, 0);
    client.notify("session/cancel", { sessionId: inbox.sessionId });
    await client.lines.untilResult(prompt);
  } finally {
    await client.closed();
  }
});

test("a held turn offers concurrent decision cards and forwards accepted answers once", async () => {
  const question = (id: string) => ({
    id,
    version: 1,
    headline: `Choose ${id}`,
    question: `Question ${id}?`,
    choices: [
      { label: "Yes", consequence: "Proceed" },
      { label: "No", consequence: "Hold" },
    ],
  });
  const client = harness({
    replies: [
      reply("hold"),
      { ...reply("hold"), elicitations: [question("one"), question("two")] },
    ],
  });
  try {
    await client.lines.untilResult(
      client.request("session/new", { cwd: "/synthetic" }),
    );
    const prompt = client.request("session/prompt", {
      sessionId: binding.sessionId,
      prompt: [{ type: "text", text: "start" }],
    });
    const first = await client.lines.next();
    const second = await client.lines.next();
    assert.equal(first.method, "elicitation/create");
    assert.equal(second.method, "elicitation/create");
    client.respond(first.id, {
      action: "accept",
      content: { nucleus_one_1: "Yes" },
    });
    client.respond(second.id, {
      action: "accept",
      content: { nucleus_two_1: "No" },
    });
    for (let i = 0; i < 100 && client.transport.answers.length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(
      client.transport.answers.map((row) => [
        row.id,
        "answer" in row ? row.answer : null,
      ]),
      [
        ["one", "Yes"],
        ["two", "No"],
      ],
    );
    client.notify("session/cancel", { sessionId: binding.sessionId });
    await client.lines.untilResult(prompt);
  } finally {
    await client.closed();
  }
});

/** One offered decision version, as the service sends it. */
const decisionCard = (id: string, version = 1) => ({
  id,
  version,
  headline: `Choose ${id}`,
  question: `Question ${id}?`,
  choices: [
    { label: "Yes", consequence: "Proceed" },
    { label: "No", consequence: "Hold" },
  ],
});

/** The decision field id a card carries: `nucleus_<id>_<version>`. */
const fieldOf = (message: Json): string => {
  const params = message.params as Json;
  const schema = params.requestedSchema as Json;
  return Object.keys(schema.properties as Json)[0]!;
};

/** Wait for a fact the agent reaches asynchronously, so no assertion races a poll. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (const started = Date.now(); !predicate(); ) {
    if (Date.now() - started > 5_000)
      throw new Error(`the agent did not reach: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a card settled after its ACP turn ended is the host's settlement, and the version is offered again", async () => {
  // nucleus#1395's live shape: the turn ends while the socket is replaced, T3 then
  // settles the card the ended turn left behind. Two such turns used to spend the
  // version's whole re-offer, so the third turn raised nothing at all.
  const card = decisionCard("reoffered");
  const client = harness({
    replies: [reply("hold"), { ...reply("hold"), elicitations: [card] }],
  });
  try {
    await client.lines.untilResult(
      client.request("session/new", { cwd: "/synthetic" }),
    );
    const raised: Array<Json["id"]> = [];
    for (const turn of [1, 2, 3]) {
      if (turn > 1)
        client.transport.replies.push({
          ...reply("hold"),
          elicitations: [card],
        });
      const prompt = client.request("session/prompt", {
        sessionId: binding.sessionId,
        prompt: [{ type: "text", text: `turn ${turn}` }],
      });
      const message = await client.lines.next();
      assert.equal(
        message.method,
        "elicitation/create",
        `turn ${turn} raises the open version's card`,
      );
      assert.equal(
        fieldOf(message),
        "nucleus_reoffered_1",
        "the field id carries the version the card shows",
      );
      raised.push(message.id);
      // The turn ends before anyone answers; T3 settles the card the ended turn left.
      client.notify("session/cancel", { sessionId: binding.sessionId });
      await client.lines.untilResult(prompt);
      client.respond(message.id, { action: "cancel" });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(new Set(raised).size, 3, "each held turn raised its own card");
    assert.deepEqual(
      client.transport.answers,
      [],
      "a settlement that follows an ended turn is not the operator's dismissal",
    );
  } finally {
    await client.closed();
  }
});

test("an operator's dismissal of a live card is recorded once, and the version is raised again", async () => {
  const card = decisionCard("dismissed");
  const client = harness({
    replies: [reply("hold"), { ...reply("hold"), elicitations: [card] }],
  });
  try {
    await client.lines.untilResult(
      client.request("session/new", { cwd: "/synthetic" }),
    );
    const prompt = client.request("session/prompt", {
      sessionId: binding.sessionId,
      prompt: [{ type: "text", text: "start" }],
    });
    const first = await client.lines.next();
    assert.equal(first.method, "elicitation/create");
    // The operator dismisses the card while its turn is held: that is the dismissal the
    // service's one re-offer budget counts. The same delivery twice counts once.
    client.respond(first.id, { action: "cancel" });
    client.respond(first.id, { action: "cancel" });
    await until(
      () => client.transport.answers.length === 1,
      "the dismissal to be recorded",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(client.transport.answers, [
      {
        taskId: "task-1",
        sessionId: binding.sessionId,
        id: "dismissed",
        version: 1,
        action: "cancel",
        requestId: first.id,
      },
    ]);
    // A dismissal does not block the version: the service may offer it once more.
    client.transport.replies.push({ ...reply("hold"), elicitations: [card] });
    const second = await client.lines.next();
    assert.equal(second.method, "elicitation/create");
    assert.notEqual(
      second.id,
      first.id,
      "the re-offer is a new card, not the dismissed one",
    );
    client.notify("session/cancel", { sessionId: binding.sessionId });
    await client.lines.untilResult(prompt);
  } finally {
    await client.closed();
  }
});

test("an answer whose delivery failed is never resent, and the version is offered again on the next turn", async () => {
  const card = decisionCard("unknown");
  const client = harness({
    replies: [reply("hold"), { ...reply("hold"), elicitations: [card] }],
  });
  // The socket was replaced between the operator's answer and the service seeing it.
  client.transport.answer = async (input) => {
    client.transport.answers.push(input);
    throw new Error("connect ENOENT /nonexistent/callback.sock");
  };
  try {
    await client.lines.untilResult(
      client.request("session/new", { cwd: "/synthetic" }),
    );
    const prompt = client.request("session/prompt", {
      sessionId: binding.sessionId,
      prompt: [{ type: "text", text: "start" }],
    });
    const first = await client.lines.next();
    assert.equal(first.method, "elicitation/create");
    client.respond(first.id, {
      action: "accept",
      content: { nucleus_unknown_1: "Yes" },
    });
    await until(
      () => client.transport.answers.length === 1,
      "the failed delivery",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      client.transport.answers.length,
      1,
      "an unknown delivery is reconciled, never resent",
    );
    client.notify("session/cancel", { sessionId: binding.sessionId });
    await client.lines.untilResult(prompt);
    // Nothing was recorded, so the service still offers the version: the next held turn
    // asks again with a new card.
    client.transport.replies.push({ ...reply("hold"), elicitations: [card] });
    const again = client.request("session/prompt", {
      sessionId: binding.sessionId,
      prompt: [{ type: "text", text: "again" }],
    });
    const second = await client.lines.next();
    assert.equal(second.method, "elicitation/create");
    assert.equal(fieldOf(second), "nucleus_unknown_1");
    assert.notEqual(second.id, first.id);
    assert.equal(
      client.transport.answers.length,
      1,
      "the earlier answer was not sent a second time",
    );
    client.notify("session/cancel", { sessionId: binding.sessionId });
    await client.lines.untilResult(again);
  } finally {
    await client.closed();
  }
});

test("one held turn raises one card per decision version, however often the service offers it", async () => {
  const one = decisionCard("one");
  const two = decisionCard("two", 2);
  const client = harness({
    replies: [
      reply("hold"),
      { ...reply("hold"), elicitations: [one, two] },
      { ...reply("hold"), elicitations: [one, two] },
      { ...reply("hold"), elicitations: [one] },
    ],
  });
  try {
    await client.lines.untilResult(
      client.request("session/new", { cwd: "/synthetic" }),
    );
    const prompt = client.request("session/prompt", {
      sessionId: binding.sessionId,
      prompt: [{ type: "text", text: "start" }],
    });
    const first = await client.lines.next();
    const second = await client.lines.next();
    assert.deepEqual(
      [fieldOf(first), fieldOf(second)],
      ["nucleus_one_1", "nucleus_two_2"],
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(
      client.lines.pending.filter(
        (message) => message.method === "elicitation/create",
      ),
      [],
      "a version that already has a live card is never offered a second one",
    );
    client.notify("session/cancel", { sessionId: binding.sessionId });
    await client.lines.untilResult(prompt);
  } finally {
    await client.closed();
  }
});

test("an inbox session routes exact ui through openUi and goes idle when no decisions are offered", async () => {
  const uiCalls: unknown[] = [];
  let holdNext = false;
  let hangNext = false;
  let status: "opened" | "reused" | "failed" = "opened";
  let detail: string | undefined;
  const transport = new ScriptedTransport();
  transport.openUi = async (input, signal) => {
    uiCalls.push(input);
    // A board open that never answers on its own: only the operator's Stop ends it.
    if (hangNext)
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              Object.assign(new Error("cancelled"), { name: "AbortError" }),
            ),
          { once: true },
        );
      });
    return { status, hold: holdNext, ...(detail ? { detail } : {}) };
  };
  const inbox = {
    format: "nucleus.acp.inbox" as const,
    version: 1 as const,
    kind: "inbox" as const,
    hostId: "t3code:synthetic",
    sessionId: "6b1d4e1a-9c1f-4f80-9b0b-3a0e1a6f2c11",
    socketPath: "/nonexistent/callback.sock",
    token: "fixture-token",
  };
  const client = harness({
    agent: { resolve: async () => ({ binding: inbox, transport }) },
  });
  try {
    await client.lines.untilResult(
      client.request("session/load", {
        sessionId: inbox.sessionId,
        cwd: "/synthetic",
      }),
    );
    // Exact `ui` works on the very first prompt and returns end_turn at once when idle.
    const first = await client.lines.untilResult(
      client.request("session/prompt", {
        sessionId: inbox.sessionId,
        prompt: [{ type: "text", text: "ui" }],
      }),
    );
    assert.deepEqual(first.result.result, { stopReason: "end_turn" });
    assert.equal(
      transport.turns.length,
      1,
      "no held poll is started when hold is false",
    );
    assert.deepEqual(uiCalls, [
      { kind: "inbox", hostId: inbox.hostId, sessionId: inbox.sessionId },
    ]);
    assert.match(JSON.stringify(first.updates), /Opened the Nucleus board\./);

    // A `reused` reply means this same `ui` was already served — usually by the pass that
    // answered the message T3 queued while the inbox's turn was held — and nothing is
    // replayed. It is still a success line, and the turn still ends at once.
    status = "reused";
    const second = await client.lines.untilResult(
      client.request("session/prompt", {
        sessionId: inbox.sessionId,
        prompt: [{ type: "text", text: "ui" }],
      }),
    );
    assert.deepEqual(second.result.result, { stopReason: "end_turn" });
    assert.match(JSON.stringify(second.updates), /board is open/i);

    // Repeating the same `reused` reply still emits on a new prompt.
    const third = await client.lines.untilResult(
      client.request("session/prompt", {
        sessionId: inbox.sessionId,
        prompt: [{ type: "text", text: "ui" }],
      }),
    );
    assert.match(JSON.stringify(third.updates), /board is open/i);

    // Stop during a board open that never answers ends the command at once, with no
    // invented line and no failed open.
    hangNext = true;
    const callsBeforeHang = uiCalls.length;
    const stopped = client.request("session/prompt", {
      sessionId: inbox.sessionId,
      prompt: [{ type: "text", text: "ui" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(uiCalls.length, callsBeforeHang + 1, "the open is in flight");
    client.notify("session/cancel", { sessionId: inbox.sessionId });
    const stoppedResult = await client.lines.untilResult(stopped);
    assert.deepEqual(stoppedResult.result.result, { stopReason: "cancelled" });
    assert.doesNotMatch(
      JSON.stringify(stoppedResult.updates),
      /could not open the board/i,
    );
    hangNext = false;

    // Failed openUi redacts any pairing token fragment and ends turn when idle.
    status = "failed";
    detail = "http://127.0.0.1:4318/#token=secret-token failed";
    const failed = await client.lines.untilResult(
      client.request("session/prompt", {
        sessionId: inbox.sessionId,
        prompt: [{ type: "text", text: "ui" }],
      }),
    );
    assert.deepEqual(failed.result.result, { stopReason: "end_turn" });
    assert.doesNotMatch(JSON.stringify(failed.updates), /secret-token/);
    assert.match(JSON.stringify(failed.updates), /\[redacted\]/);

    // Non-exact text never triggers openUi.
    const callsBeforeOther = uiCalls.length;
    for (const nonExact of ["UI", "ui please", "hello"]) {
      const other = client.request("session/prompt", {
        sessionId: inbox.sessionId,
        prompt: [{ type: "text", text: nonExact }],
      });
      await turnStarted(transport, transport.turns.length + 1);
      transport.release();
      await client.lines.untilResult(other);
    }
    assert.equal(uiCalls.length, callsBeforeOther);

    // When offerable decisions exist, `ui` keeps the turn held until released/cancelled.
    status = "reused";
    detail = undefined;
    holdNext = true;
    const turnsBeforeHold = transport.turns.length;
    const held = client.request("session/prompt", {
      sessionId: inbox.sessionId,
      prompt: [{ type: "text", text: "ui" }],
    });
    await turnStarted(transport, turnsBeforeHold + 1);
    client.notify("session/cancel", { sessionId: inbox.sessionId });
    const heldResult = await client.lines.untilResult(held);
    assert.deepEqual(heldResult.result.result, { stopReason: "cancelled" });
  } finally {
    await client.closed();
  }
});

test("a task session still forwards literal ui text as an operator message", async () => {
  const client = harness();
  let uiCalled = false;
  client.transport.openUi = async () => {
    uiCalled = true;
    return { status: "opened", hold: false };
  };
  try {
    await client.lines.untilResult(
      client.request("session/new", { cwd: "/fixture/checkout" }),
    );
    const opening = client.request("session/prompt", {
      sessionId: binding.sessionId,
      prompt: [{ type: "text", text: "opening" }],
    });
    await turnStarted(client.transport, 2);
    client.transport.release();
    await client.lines.untilResult(opening);

    const prompt = client.request("session/prompt", {
      sessionId: binding.sessionId,
      prompt: [{ type: "text", text: "ui" }],
    });
    await turnStarted(client.transport, 3);
    client.transport.release();
    await client.lines.untilResult(prompt);
    assert.equal(uiCalled, false);
    assert.equal(client.transport.messages.at(-1)?.text, "ui");
  } finally {
    await client.closed();
  }
});
