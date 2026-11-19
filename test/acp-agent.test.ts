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
import { runAcpAgentFromEnvironment } from "../shared/acp/entry";
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
  answer(input: import("../shared/acp/surface").AcpAnswerInput): Promise<unknown> { this.answers.push(input); return Promise.resolve({}); }
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
    respond(id: unknown, result: unknown): void { input.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); },
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

test("an injected hold rule keeps the turn without showing or forwarding the host's re-entry", async () => {
  // A host that released the thread re-enters it to parent its next child: the prompt
  // is configuration, so it is never shown as the agent's words and never forwarded as
  // the operator's, but the turn is held — which is the whole point of the re-entry.
  const client = harness({
    agent: { hold: (text) => text.includes("nucleus-hold-the-task-thread") },
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
    prompt: [{ type: "text", text: "nucleus-hold-the-task-thread: task-1" }],
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
  assert.equal(updates.length, 1, "only the release line is shown");
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

test("a service that never answers ends the turn with one explanation after bounded retries", async () => {
  const client = harness({
    agent: {
      maxTransportFailures: 2,
      async resolve() {
        return {
          binding,
          transport: {
            turn: async (input: AcpTurnRequest) => {
              if (input.waitMs === 0)
                return reply("hold", ["nucleus#1304 · Working"]);
              throw new Error("connect ENOENT /nonexistent/callback.sock");
            },
            message: async () => {
              throw new Error("unreachable");
            },
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
  assert.deepEqual(
    result.result,
    { stopReason: "end_turn" },
    "a turn nobody can release is ended, not held",
  );
  const text = JSON.stringify(updates);
  assert.match(text, /Nucleus is unreachable/);
  assert.match(text, /ENOENT/);
  await client.closed();
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
  const inbox = { format: "nucleus.acp.inbox" as const, version: 1 as const, kind: "inbox" as const,
    hostId: "t3code:synthetic", sessionId: "6b1d4e1a-9c1f-4f80-9b0b-3a0e1a6f2c11", socketPath: "/nonexistent/callback.sock", token: "fixture-token" };
  const client = harness({ agent: { resolve: async () => ({ binding: inbox, transport }) } });
  try {
    await client.lines.untilResult(client.request("session/load", { sessionId: inbox.sessionId, cwd: "/synthetic" }));
    const prompt = client.request("session/prompt", { sessionId: inbox.sessionId, prompt: [{ type: "text", text: "stale card answer" }] });
    await turnStarted(transport, 2);
    assert.deepEqual(transport.turns[0], { kind: "inbox", hostId: inbox.hostId, sessionId: inbox.sessionId, waitMs: 0, attach: true });
    assert.equal(transport.messages.length, 0);
    client.notify("session/cancel", { sessionId: inbox.sessionId });
    await client.lines.untilResult(prompt);
  } finally { await client.closed(); }
});


test("a held turn offers concurrent decision cards and forwards accepted answers once", async () => {
  const question = (id: string) => ({ id, version: 1, headline: `Choose ${id}`, question: `Question ${id}?`, choices: [{ label: "Yes", consequence: "Proceed" }, { label: "No", consequence: "Hold" }] });
  const client = harness({ replies: [reply("hold"), { ...reply("hold"), elicitations: [question("one"), question("two")] }] });
  try {
    await client.lines.untilResult(client.request("session/new", { cwd: "/synthetic" }));
    const prompt = client.request("session/prompt", { sessionId: binding.sessionId, prompt: [{ type: "text", text: "start" }] });
    const first = await client.lines.next();
    const second = await client.lines.next();
    assert.equal(first.method, "elicitation/create");
    assert.equal(second.method, "elicitation/create");
    client.respond(first.id, { action: "accept", content: { nucleus_one_1: "Yes" } });
    client.respond(second.id, { action: "accept", content: { nucleus_two_1: "No" } });
    for (let i = 0; i < 100 && client.transport.answers.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(client.transport.answers.map(row => [row.id, "answer" in row ? row.answer : null]), [["one", "Yes"], ["two", "No"]]);
    client.notify("session/cancel", { sessionId: binding.sessionId });
    await client.lines.untilResult(prompt);
  } finally { await client.closed(); }
});
