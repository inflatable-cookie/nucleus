import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../core/engine";
import { Decisions } from "../core/planning/decisions";
import {
  bindOwner,
  boundOwner,
  proposedOwner,
  type DecisionScope,
} from "../core/acp/decisions";
import { Store } from "../core/store/store";
import { startCallbacks } from "../service/callbacks/callback";
import {
  AcpSessions,
  ACP_TURN_WAIT_MAX_MS,
  bindAcpSession,
} from "../core/acp/sessions";
import {
  acpLifecycleLine,
  acpLifecycleSignature,
  acpTaskName,
} from "../core/acp/lifecycle";
import type { AcpTurnReply } from "../shared/acp/surface";
import {
  acpBindingPath,
  acpSessionPath,
  readAcpBinding,
} from "../shared/acp/binding";
import { mintAcpSession, verifyAcpSession } from "../core/acp/binding";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { callbackRequest } from "../shared/service/callback-client.mjs";
import { callCatalogueMethod } from "../service/transport/dispatch";
import {
  decisionSchema,
  submissionSchema,
  type Run,
  type Task,
} from "../shared/contracts";
import type { Adapter } from "../core/host";
import { base, profile } from "./support/responsible-lifecycle-fixture";
import { socketFixtureDirectory } from "./support/socket-fixture";
import { CoordinatorEpisode } from "../core/recovery/coordinator-episode";
import { REPAIR_ATTEMPT_SETTLED } from "../core/recovery/repair-attempts";

/**
 * Spec 065: the service side of an ACP session — minting the binding, the held turn,
 * the release, the lifecycle text, and the operator's message. The engine, the store
 * and the real callback socket are the ones the service runs, so these cases are the
 * contract the agent talks to rather than a description of it.
 */

const WORKER = "worker-agent";

async function acpFixture(hostId = "host") {
  const dir = socketFixtureDirectory("callback.sock");
  const socketPath = join(dir, "callback.sock");
  const worktree = join(dir, "work");
  const store = new Store(join(dir, "queue.sqlite"));
  const author = profile("author", "glm-4.7", "pi");
  const notified: Array<{ agentId: string; messageId: string; text: string }> =
    [];
  const adapter = {
    hostId,
    profiles: async () => [author],
    observe: async (id: string) => ({
      id,
      workspaceId: "ws",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
      provider: "pi",
      model: author.model,
      updatedAt: "2026-11-17T10:00:00.000Z",
    }),
    originAgent: async (id: string) => ({
      id,
      workspaceId: "ws",
      title: id,
      archived: false,
    }),
    notify: async (agentId: string, messageId: string, text: string) => {
      notified.push({ agentId, messageId, text });
    },
    archiveAgent: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [author];
  engine.identifyOriginHost = async () => hostId;
  engine.resolution.worktreeValidationProbe = () => ({ state: "absent" });
  store.setMeta("paused", false);
  const task = store.insert(
    submissionSchema.parse({
      submissionId: "acp-fixture",
      title: "Synthetic ACP task",
      repoPath: join(dir, "repo"),
      planningCommit: base,
      brief: { text: "Synthetic ACP brief\n" },
      originAgentId: "origin",
    }),
    hostId,
    "brief",
    base,
  );
  // A live worker run: an operator message has someone to reach.
  store.update(task.id, {
    phase: "working",
    directory: worktree,
    agentId: WORKER,
    runId: "run-1",
    workspaceId: "ws",
    profile: author,
    workerModel: author.model,
    workerModels: [author.model],
  });
  store.putRun({
    id: "run-1",
    taskId: task.id,
    role: "revision",
    generation: 1,
    head: base,
    agentId: WORKER,
    workspaceId: "ws",
    profile: author,
    status: "running",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
  } as unknown as Run);
  store.update(task.id, {
    resolution: { ...store.task(task.id).resolution, currentRunId: "run-1" },
  });
  mkdirSync(worktree, { recursive: true });
  const acp = new AcpSessions(engine, {
    dataHome: dir,
    socketPath,
    pollMs: 50,
    answerDecision: (input) =>
      new Decisions(store).answer(input, { trustedT3: true }),
  });
  // Count the turn calls so a test can wait for a held turn to reach the service.
  let turns = 0;
  const served = acp.turn.bind(acp);
  acp.turn = async (input, token) => {
    turns += 1;
    return served(input, token);
  };
  engine.acp = acp;
  const stop = await startCallbacks(
    socketPath,
    join(dir, "helper.mjs"),
    engine,
  );
  const minted = acp.bind({ taskId: task.id });
  const binding = readAcpBinding(minted.bindingPath);
  return {
    dir,
    store,
    engine,
    acp,
    taskId: task.id,
    worktree,
    notified,
    minted,
    binding,
    token: binding.token,
    get turns(): number {
      return turns;
    },
    turn: (input: { waitMs?: number; attach?: boolean } = {}) =>
      acp.turn(
        {
          taskId: task.id,
          sessionId: minted.sessionId,
          waitMs: input.waitMs ?? 0,
          attach: input.attach,
        },
        binding.token,
      ),
    sessionId: minted.sessionId,
    message: (text: string, eventId = "a".repeat(64)) =>
      callbackRequest(binding, "/acp-message", {
        taskId: task.id,
        sessionId: minted.sessionId,
        eventId,
        text,
      }),
    async close() {
      await engine.stop();
      await stop();
      store.close();
    },
  };
}

test("bind mints an owner-only record and pointer, never puts the token in the record, and revokes the earlier token", async () => {
  const fixture = await acpFixture();
  try {
    const recordPath = acpSessionPath(fixture.dir, fixture.taskId);
    const recordText = readFileSync(recordPath, "utf8");
    assert.equal(
      statSync(recordPath).mode & 0o777,
      0o600,
      "the session record is owner-only",
    );
    assert.equal(
      statSync(fixture.minted.bindingPath).mode & 0o777,
      0o600,
      "the binding pointer is owner-only",
    );
    assert.equal(
      recordText.includes(fixture.token),
      false,
      "the authority record stores only the token's hash",
    );
    assert.equal(
      fixture.minted.bindingPath,
      acpBindingPath(fixture.dir, fixture.worktree),
      "the pointer is keyed by the task's checkout",
    );

    const again = fixture.acp.bind({ taskId: fixture.taskId });
    assert.notEqual(again.sessionId, fixture.minted.sessionId);
    assert.throws(
      () =>
        verifyAcpSession(
          {
            dataHome: fixture.dir,
            taskId: fixture.taskId,
            sessionId: fixture.minted.sessionId,
          },
          fixture.token,
        ),
      /Unauthorized callback/,
      "minting again revokes the session it replaced",
    );
    assert.equal(
      verifyAcpSession(
        {
          dataHome: fixture.dir,
          taskId: fixture.taskId,
          sessionId: again.sessionId,
        },
        readAcpBinding(again.bindingPath).token,
      ).taskId,
      fixture.taskId,
    );
  } finally {
    await fixture.close();
  }
});

test("a host adapter's mint names the prompt rules its launched agent reads", async () => {
  const fixture = await acpFixture();
  try {
    // The T3 adapter mints with its own two rules (nucleus#1305): an ignore pattern for
    // the host's wake text and a hold pattern for its re-entry. Both ride the binding
    // pointer, which is why the agent needs no host knowledge and parses no remote text.
    const minted = fixture.acp.bind({
      taskId: fixture.taskId,
      ignorePattern: "Delegated task node:delegated-task:",
      holdPattern: "nucleus-hold-the-task-thread",
    });
    const binding = readAcpBinding(minted.bindingPath);
    assert.equal(binding.ignorePattern, "Delegated task node:delegated-task:");
    assert.equal(binding.holdPattern, "nucleus-hold-the-task-thread");
    assert.ok("taskId" in binding);
    assert.equal(binding.taskId, fixture.taskId);
    // A mint without rules writes neither field: a host that has no such text is not
    // given a rule it never asked for.
    const plain = fixture.acp.bind({ taskId: fixture.taskId });
    const pointer = readAcpBinding(plain.bindingPath);
    assert.equal(pointer.ignorePattern, undefined);
    assert.equal(pointer.holdPattern, undefined);
    assert.equal(
      JSON.stringify(pointer).includes("nucleus-hold-the-task-thread"),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("acp.bind is a catalogue method whose answer carries no credential", async () => {
  const fixture = await acpFixture();
  try {
    // The served owner is the runtime (test/catalogue.test.ts proves `bindAcpSession`
    // exists there); this is that handler's one body, reached through the catalogue's
    // input and output contracts.
    const owner = {
      bindAcpSession: (input: { taskId: string }) =>
        bindAcpSession(fixture.engine.acp, input),
    };
    const answer = (await callCatalogueMethod(owner, "acp.bind", {
      taskId: fixture.taskId,
    })) as Record<string, unknown>;
    assert.deepEqual(Object.keys(answer).sort(), [
      "bindingPath",
      "sessionId",
      "taskId",
    ]);
    assert.equal(String(answer.bindingPath).includes("token"), false);
    assert.equal(
      JSON.stringify(answer).includes(
        readAcpBinding(String(answer.bindingPath)).token,
      ),
      false,
      "no credential is returned over the wire",
    );
    await assert.rejects(
      () =>
        callCatalogueMethod(owner, "acp.bind", {
          taskId: "no-such-task",
          extra: true,
        }),
      /unrecognized key|Unrecognized/i,
    );
    await assert.rejects(
      () => callCatalogueMethod(owner, "acp.bind", { taskId: "no-such-task" }),
      /Task not found/,
    );
  } finally {
    await fixture.close();
  }
});

test("a bind refuses a task without a checkout, a removed task, and a process that serves no ACP sessions", async () => {
  const fixture = await acpFixture();
  try {
    const bare = fixture.store.insert(
      submissionSchema.parse({
        submissionId: "acp-no-worktree",
        title: "No checkout",
        repoPath: join(fixture.dir, "repo2"),
        planningCommit: base,
        brief: { text: "Synthetic brief\n" },
        originAgentId: "origin",
      }),
      "host",
      "brief",
      base,
    );
    assert.equal(bare.directory, null);
    assert.throws(
      () => fixture.acp.bind({ taskId: bare.id }),
      /has no workspace checkout yet/,
    );
    fixture.store.update(fixture.taskId, {
      removedAt: new Date().toISOString(),
    });
    assert.throws(
      () => fixture.acp.bind({ taskId: fixture.taskId }),
      /was removed/,
    );
    assert.throws(
      () => bindAcpSession(null, { taskId: fixture.taskId }),
      /does not serve ACP sessions/,
      "a process that serves no ACP sessions mints nothing",
    );
  } finally {
    await fixture.close();
  }
});

test("a held turn answers with structured presentation, keeps messages for human events, and releases a finished task", async () => {
  const fixture = await acpFixture();
  try {
    const first = await fixture.turn();
    assert.equal(first.state, "hold");
    assert.ok("task" in first);
    assert.ok(first.presentation, "task turns carry structured presentation");
    assert.deepEqual(
      first.presentation.plan.map((e) => [e.content, e.status]),
      [
        ["Queued", "completed"],
        ["Working", "in_progress"],
        ["Review round 1 of 6", "pending"],
        ["Merge", "pending"],
        ["Close", "pending"],
      ],
    );
    assert.equal(first.presentation.toolCalls.length, 1);
    assert.equal(
      first.presentation.toolCalls[0]!.title,
      "Worker: implementing the brief",
    );
    assert.equal(first.presentation.toolCalls[0]!.status, "in_progress");
    assert.deepEqual(
      first.messages,
      [],
      "routine working state sends no chat message",
    );
    assert.match(
      String(first.task.reference),
      /#/,
      "the task carries its durable reference",
    );
    const quiet = await fixture.turn();
    assert.deepEqual(
      quiet.messages,
      [],
      "a held poll on an unchanged task says nothing",
    );
    fixture.store.update(fixture.taskId, { phase: "awaiting_review" });
    const changed = await fixture.turn();
    assert.ok("presentation" in changed && changed.presentation);
    assert.equal(changed.presentation.plan[1]!.status, "completed");
    assert.equal(changed.presentation.plan[2]!.status, "in_progress");
    assert.deepEqual(
      changed.messages,
      [],
      "phase changes update the plan rather than sending text lines",
    );
    fixture.store.update(fixture.taskId, {
      phase: "done",
      finishedAt: new Date().toISOString(),
    });
    const finished = await fixture.turn();
    assert.equal(finished.state, "release");
    assert.ok("presentation" in finished && finished.presentation);
    assert.equal(
      finished.presentation.plan.every((e) => e.status === "completed"),
      true,
    );
    assert.equal(finished.messages.length, 1);
    assert.match(finished.messages[0]!, /is done/);
    assert.match(finished.reason, /done/);
  } finally {
    await fixture.close();
  }
});

test("an attach rebuilds the current presentation even though this service already showed it", async () => {
  // The T3 restart path: the agent process dies while the service keeps running, so the
  // service still holds this session's shown signature. `session/load` attaches again and
  // rebuilds the plan, tool calls, and any current finish/question message.
  const fixture = await acpFixture();
  try {
    const opening = await fixture.turn();
    assert.ok("presentation" in opening && opening.presentation);
    assert.equal(opening.presentation.plan[1]!.status, "in_progress");
    assert.deepEqual(
      (await fixture.turn()).messages,
      [],
      "a held poll after that adds nothing",
    );
    const reattached = await fixture.turn({ attach: true });
    assert.ok("presentation" in reattached && reattached.presentation);
    assert.equal(reattached.presentation.plan[1]!.status, "in_progress");
    assert.equal(
      reattached.presentation.toolCalls[0]!.title,
      "Worker: implementing the brief",
    );
    fixture.store.update(fixture.taskId, { phase: "awaiting_review" });
    const changed = await fixture.turn({ attach: true });
    assert.ok("presentation" in changed && changed.presentation);
    assert.equal(changed.presentation.plan[2]!.status, "in_progress");
    fixture.store.update(fixture.taskId, {
      phase: "done",
      finishedAt: new Date().toISOString(),
    });
    const finished = await fixture.turn({ attach: true });
    assert.equal(finished.state, "release");
    assert.equal(finished.messages.length, 1);
    assert.match(finished.messages[0]!, /is done/);
  } finally {
    await fixture.close();
  }
});

test("unchanged writes stay quiet; reviewer tool calls name the PR and short head; messages stay human-only", async () => {
  const fixture = await acpFixture();
  try {
    await fixture.turn();
    fixture.store.update(fixture.taskId, { phase: "working" });
    assert.deepEqual(
      (await fixture.turn()).messages,
      [],
      "a same-state write sends no message",
    );
    fixture.store.update(fixture.taskId, {
      phase: "reviewing",
      prUrl: "https://example.test/pull/276",
      prHead: "c86dc5a999999999999999999999999999999999",
    });
    fixture.store.putRun({
      id: "run-review-1",
      taskId: fixture.taskId,
      role: "reviewer",
      generation: 1,
      head: "c86dc5a999999999999999999999999999999999",
      agentId: "reviewer-agent",
      workspaceId: "ws",
      profile: fixture.engine.profiles[0]!,
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    } as unknown as Run);
    fixture.store.update(fixture.taskId, {
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        currentRunId: "run-review-1",
      },
    });
    const reviewing = await fixture.turn();
    assert.ok("presentation" in reviewing && reviewing.presentation);
    assert.equal(
      reviewing.presentation.toolCalls.some(
        (c) => c.title === "Reviewer: reviewing PR #276 at c86dc5a",
      ),
      true,
    );
    assert.deepEqual(reviewing.messages, []);
    const reattached = await fixture.turn({ attach: true });
    assert.ok("presentation" in reattached && reattached.presentation);
    assert.equal(
      reattached.presentation.toolCalls.some(
        (c) => c.title === "Reviewer: reviewing PR #276 at c86dc5a",
      ),
      true,
      "a reattached session rebuilds the reviewer tool call",
    );
  } finally {
    await fixture.close();
  }
});

test("a long poll holds until the task changes, then answers with the updated presentation", async () => {
  const fixture = await acpFixture();
  try {
    await fixture.turn();
    const waiting = fixture.turn({ waitMs: 2_000 });
    // The change lands while the turn is waiting, exactly as a run completing would.
    setTimeout(
      () => fixture.store.update(fixture.taskId, { phase: "awaiting_review" }),
      50,
    );
    const answer = await waiting;
    assert.equal(answer.state, "hold");
    assert.ok("presentation" in answer && answer.presentation);
    assert.equal(answer.presentation.plan[2]!.status, "in_progress");
  } finally {
    await fixture.close();
  }
});

test("a host adapter's release ends the held turn with its reason, and the next turn holds again", async () => {
  const fixture = await acpFixture();
  try {
    await fixture.turn();
    const waiting = fixture.turn({ waitMs: 5_000 });
    setTimeout(
      () =>
        fixture.acp.release(
          fixture.minted.sessionId,
          "no role thread is active",
        ),
      20,
    );
    const released = await waiting;
    assert.equal(released.state, "release");
    assert.equal(released.reason, "no role thread is active");
    const after = await fixture.turn();
    assert.equal(
      after.state,
      "hold",
      "the directive is consumed by the turn that acted on it",
    );
  } finally {
    await fixture.close();
  }
});

test("the operator's message is recorded from the operator and delivered to the live worker", async () => {
  const fixture = await acpFixture();
  try {
    const answer = (await fixture.message(
      "please re-run the failing test",
    )) as { receipt: { status: string; messageId: string } };
    assert.equal(answer.receipt.status, "delivered");
    assert.equal(
      fixture.notified.length,
      1,
      "the live worker thread received it once",
    );
    assert.match(fixture.notified[0]!.text, /Queue message from the operator:/);
    assert.match(fixture.notified[0]!.text, /please re-run the failing test/);
    const record = fixture.store
      .messages(fixture.taskId)
      .find((message) => message.id === answer.receipt.messageId)!;
    assert.equal(record.fromRole, "operator");
    assert.equal(record.toRole, "worker");
    assert.equal(record.text, "please re-run the failing test");
    const replay = (await fixture.message(
      "please re-run the failing test",
    )) as { receipt: { status: string; messageId: string } };
    assert.equal(
      replay.receipt.status,
      "delivered",
      "the identical event id replays its recorded receipt",
    );
    assert.equal(replay.receipt.messageId, answer.receipt.messageId);
    const duplicate = (await fixture.message(
      "please re-run the failing test",
      "b".repeat(64),
    )) as { receipt: { status: string } };
    assert.equal(
      duplicate.receipt.status,
      "duplicate",
      "the same text under a new event id is not delivered twice",
    );
    assert.equal(fixture.notified.length, 1);
  } finally {
    await fixture.close();
  }
});

test("a session credential, a session id and a finished task are each refused where they belong", async () => {
  const fixture = await acpFixture();
  try {
    const wrongToken = { ...fixture.binding, token: "not-the-token" };
    await assert.rejects(
      () =>
        callbackRequest(wrongToken, "/acp-turn", {
          taskId: fixture.taskId,
          sessionId: fixture.minted.sessionId,
          waitMs: 0,
        }),
      (error) => (error as { callbackStatus?: number }).callbackStatus === 401,
    );
    await assert.rejects(
      () =>
        callbackRequest(fixture.binding, "/acp-turn", {
          taskId: fixture.taskId,
          sessionId: "5b1d4e1a-0000-4000-8000-000000000000",
          waitMs: 0,
        }),
      (error) => (error as { callbackStatus?: number }).callbackStatus === 401,
    );
    await assert.rejects(
      () =>
        callbackRequest(fixture.binding, "/acp-turn", {
          taskId: fixture.taskId,
          sessionId: fixture.minted.sessionId,
          waitMs: ACP_TURN_WAIT_MAX_MS + 1,
        }),
      (error) => (error as { callbackStatus?: number }).callbackStatus === 409,
      "a wait past the service's bound is a schema refusal",
    );
    fixture.store.update(fixture.taskId, {
      phase: "done",
      finishedAt: new Date().toISOString(),
    });
    await assert.rejects(
      () => fixture.message("too late"),
      /finished task cannot receive messages/,
    );
  } finally {
    await fixture.close();
  }
});

test("a process without the ACP surface refuses the routes instead of answering an empty turn", async () => {
  const fixture = await acpFixture();
  try {
    fixture.engine.acp = null;
    await assert.rejects(
      () =>
        callbackRequest(fixture.binding, "/acp-turn", {
          taskId: fixture.taskId,
          sessionId: fixture.minted.sessionId,
          waitMs: 0,
        }),
      /does not serve ACP sessions/,
    );
  } finally {
    await fixture.close();
  }
});

test("lifecycle text is one bounded line and its signature names every fact it shows", () => {
  const task = {
    id: "task-1",
    reference: "nucleus#1304",
    number: 1304,
    title: "A task",
    phase: "working",
    held: false,
    prUrl: null,
    prHead: null,
    version: 3,
  } as unknown as Task;
  assert.equal(acpTaskName(task), "nucleus#1304");
  assert.match(acpLifecycleLine(task), /^nucleus#1304 · Working$/);
  const withPr = {
    ...task,
    prUrl: "https://example.test/pr/1",
    prHead: "a".repeat(40),
  } as unknown as Task;
  assert.match(acpLifecycleLine(withPr), /https:\/\/example\.test\/pr\/1/);
  assert.notEqual(acpLifecycleSignature(task), acpLifecycleSignature(withPr));
  // A write that changes nothing the operator reads (a version bump, the same phase) keeps the signature.
  assert.equal(
    acpLifecycleSignature(task),
    acpLifecycleSignature({ ...task, version: 4 } as unknown as Task),
  );
  assert.equal(
    acpLifecycleSignature({
      ...task,
      prHead: "b".repeat(40),
    } as unknown as Task),
    acpLifecycleSignature(task),
  );
  assert.equal(
    acpTaskName({ ...task, reference: null, number: 12 } as unknown as Task),
    "task 12",
  );
});

test("a minted session outlives the service process that made it", () => {
  // The record is the authority and the pointer is derived from the checkout, so a
  // restarted service (a new AcpSessions instance) verifies the same files.
  const dir = socketFixtureDirectory("callback.sock");
  const minted = mintAcpSession({
    dataHome: dir,
    socketPath: join(dir, "callback.sock"),
    taskId: "task-restart",
    directory: join(dir, "work"),
  });
  const binding = readAcpBinding(minted.bindingPath);
  assert.equal(
    verifyAcpSession(
      { dataHome: dir, taskId: "task-restart", sessionId: minted.sessionId },
      binding.token,
    ).sessionId,
    minted.sessionId,
  );
  assert.equal(
    readAcpBinding(acpBindingPath(dir, join(dir, "work"))).sessionId,
    minted.sessionId,
  );
  assert.throws(
    () =>
      verifyAcpSession(
        { dataHome: dir, taskId: "another-task", sessionId: minted.sessionId },
        binding.token,
      ),
    /Unauthorized callback/,
  );
});

/** One line-addressed reader over a child's stdout, as ACP clients read it. */
function childLines(
  stream: NodeJS.ReadableStream,
  diagnostics: () => string = () => "",
) {
  const queued: Array<Record<string, unknown>> = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
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
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queued.push(message);
    }
  });
  return {
    next(): Promise<Record<string, unknown>> {
      const ready = queued.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `the agent process wrote nothing in time; stderr: ${diagnostics()}`,
              ),
            ),
          20_000,
        );
        timer.unref?.();
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    async untilId(id: number): Promise<{
      updates: Array<Record<string, unknown>>;
      answer: Record<string, unknown>;
    }> {
      const updates: Array<Record<string, unknown>> = [];
      for (;;) {
        const message = await this.next();
        if (message.id === id) return { updates, answer: message };
        updates.push(message);
      }
    },
  };
}

/**
 * Launch the packaged agent entry exactly as an ACP client does: the task's checkout as its
 * working directory, the data home in the environment, ACP on stdio.
 */
function launchAgent(fixture: { worktree: string; dir: string }) {
  // `--import tsx` resolves from the child's own working directory, which is the task's
  // checkout: name the loader by its absolute path so the launcher runs from there.
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const child = spawn(
    process.execPath,
    [
      "--import",
      tsx,
      fileURLToPath(new URL("../bin/nucleus-acp.mjs", import.meta.url)),
    ],
    {
      cwd: fixture.worktree,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: fixture.dir,
        TMPDIR: fixture.dir,
        NUCLEUS_DATA_HOME: fixture.dir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("error", (error) => {
    stderr += `\n[agent failed to start] ${String(error)}`;
  });
  child.on("exit", (code, signal) => {
    if (code !== 0) stderr += `\n[agent exited ${code ?? signal}]`;
  });
  const lines = childLines(child.stdout, () => stderr);
  const write = (message: unknown) =>
    child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    child,
    lines,
    write,
    stderr: () => stderr,
    /** Close the client's stdio and report the agent process's own exit code. */
    async close(): Promise<number | null> {
      child.stdin.end();
      return new Promise<number | null>((resolve) =>
        child.on("exit", (code) => resolve(code)),
      );
    },
  };
}

test("the launcher speaks ACP on stdio to the real service: bind, hold, release, operator text", async () => {
  const fixture = await acpFixture();
  const agent = launchAgent(fixture);
  const { child, lines, write } = agent;
  const settle = async (id: number) => {
    const answer = await lines.untilId(id);
    assert.equal(
      (answer.answer.result as Record<string, unknown>).stopReason,
      "end_turn",
      `request ${id}: ${agent.stderr()}`,
    );
  };
  try {
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    const initialized = await lines.untilId(1);
    assert.equal(
      (initialized.answer.result as Record<string, unknown>).protocolVersion,
      1,
    );

    write({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: fixture.worktree, mcpServers: [] },
    });
    const opened = await lines.untilId(2);
    assert.equal(
      (opened.answer.result as Record<string, unknown>).sessionId,
      fixture.sessionId,
      "the launcher found the binding minted for this checkout",
    );

    // The thread's opening prompt holds; the service releases it.
    write({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: fixture.sessionId,
        prompt: [{ type: "text", text: "opening prompt" }],
      },
    });
    await until(() => fixture.turns > 0);
    fixture.acp.release(fixture.sessionId, "the opening turn is done");
    await settle(3);
    assert.equal(
      fixture.notified.length,
      0,
      "the thread's opening prompt is not the operator speaking",
    );

    // The operator's next message is forwarded, and the turn holds until the service releases it.
    write({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: {
        sessionId: fixture.sessionId,
        prompt: [{ type: "text", text: "what is the CI saying?" }],
      },
    });
    await until(() => fixture.notified.length === 1);
    assert.match(fixture.notified[0]!.text, /what is the CI saying\?/);
    fixture.acp.release(fixture.sessionId, "the operator turn is done");
    await settle(4);

    const exit = await agent.close();
    assert.equal(
      exit,
      0,
      `the agent exits cleanly when its client closes stdio: ${agent.stderr()}`,
    );
  } finally {
    child.kill();
    await fixture.close();
  }
});

test("a relaunched launcher's session/load shows the line the previous process already showed", async () => {
  // The T3 restart path end to end: the first agent attaches and dies, the service keeps
  // running with that session's shown signature, and the second agent loads the thread.
  const fixture = await acpFixture();
  const first = launchAgent(fixture);
  try {
    first.write({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: fixture.worktree, mcpServers: [] },
    });
    const opened = await first.lines.untilId(1);
    assert.equal(
      (opened.answer.result as Record<string, unknown>).sessionId,
      fixture.sessionId,
    );
    assert.equal(
      await first.close(),
      0,
      `the first agent exits cleanly: ${first.stderr()}`,
    );

    const second = launchAgent(fixture);
    try {
      second.write({
        jsonrpc: "2.0",
        id: 1,
        method: "session/load",
        params: {
          sessionId: fixture.sessionId,
          cwd: fixture.worktree,
          mcpServers: [],
        },
      });
      const loaded = await second.lines.untilId(1);
      assert.equal(
        (loaded.answer.result as Record<string, unknown>).sessionId,
        fixture.sessionId,
      );
      const update = await second.lines.next();
      assert.equal(update.method, "session/update");
      assert.match(
        JSON.stringify(update),
        /Working/,
        "the reloaded thread shows where the task stands",
      );
      assert.equal(
        await second.close(),
        0,
        `the second agent exits cleanly: ${second.stderr()}`,
      );
    } finally {
      second.child.kill();
    }
  } finally {
    first.child.kill();
    await fixture.close();
  }
});

/** Wait for a fixture fact another process produces; `until` never silently passes on a timeout. */
async function until(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  for (const started = Date.now(); !predicate(); ) {
    if (Date.now() - started > timeoutMs)
      throw new Error("the fixture fact did not arrive in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("an inbox session can hold its own turn but cannot use a task's message authority", async () => {
  const fixture = await acpFixture();
  try {
    const inbox = fixture.acp.bindInbox({ hostId: "t3code:synthetic" });
    const binding = readAcpBinding(inbox.bindingPath);
    assert.ok("kind" in binding && binding.kind === "inbox");
    const reply = await callbackRequest(binding, "/acp-turn", {
      kind: "inbox",
      hostId: inbox.hostId,
      sessionId: inbox.sessionId,
      waitMs: 0,
    });
    assert.deepEqual(reply, {
      kind: "inbox",
      hostId: inbox.hostId,
      state: "hold",
      reason: "the inbox is open",
      messages: [],
      elicitations: [],
    });
    await assert.rejects(
      () =>
        callbackRequest(binding, "/acp-message", {
          taskId: fixture.taskId,
          sessionId: fixture.sessionId,
          eventId: "a".repeat(64),
          text: "synthetic",
        }),
      /Unauthorized callback/,
    );
    await assert.rejects(
      () =>
        callbackRequest(binding, "/acp-turn", {
          kind: "inbox",
          hostId: "t3code:other",
          sessionId: inbox.sessionId,
          waitMs: 0,
        }),
      /Unauthorized callback/,
    );
  } finally {
    await fixture.close();
  }
});

test("an inbox turn is released only when nothing is offered and the adapter has released it", async () => {
  const fixture = await acpFixture("t3code:synthetic");
  try {
    const stamp = new Date().toISOString();
    const decision = (id: string) =>
      decisionSchema.parse({
        id,
        version: 1,
        question: `Question ${id}?`,
        choices: [
          { label: "Yes", consequence: "Proceed" },
          { label: "No", consequence: "Hold" },
        ],
        askedBy: { agentId: "synthetic" },
        links: { tasks: [] },
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
      });
    const inbox = fixture.acp.bindInbox({ hostId: "t3code:synthetic" });
    const binding = readAcpBinding(inbox.bindingPath);
    const caller = {
      kind: "inbox" as const,
      hostId: inbox.hostId,
      sessionId: inbox.sessionId,
    };
    const turn = async () =>
      (await callbackRequest(binding, "/acp-turn", {
        ...caller,
        waitMs: 0,
      })) as { state: string; elicitations?: Array<{ id: string }> };
    // Nothing is offered and nothing has released it yet: the turn is held, not released.
    assert.equal((await turn()).state, "hold");
    fixture.acp.release(
      inbox.sessionId,
      "no operator decision is open for the inbox",
    );
    assert.equal((await turn()).state, "release");
    // The directive is consumed by its release; the next turn holds again.
    assert.equal((await turn()).state, "hold");
    // An offer holds the inbox, and it cancels a directive that arrives before the offer is answered.
    fixture.store.addDecision(decision("inbox-open"));
    fixture.acp.observedCards({ hostId: inbox.hostId }, []);
    fixture.acp.release(
      inbox.sessionId,
      "no operator decision is open for the inbox",
    );
    const offered = await turn();
    assert.equal(offered.state, "hold");
    assert.deepEqual(
      offered.elicitations?.map((row) => row.id),
      ["inbox-open"],
    );
    await fixture.acp.answer(
      {
        ...caller,
        id: "inbox-open",
        version: 1,
        action: "accept",
        answer: "Yes",
      },
      binding.token,
    );
    assert.equal((await turn()).state, "hold");
    // The pending-offer key the host gates re-entry on follows the same offer.
    assert.equal(fixture.acp.pendingInboxDecisionKey?.(inbox.hostId), null);
  } finally {
    await fixture.close();
  }
});

test("a task-linked decision and a decision with no task link are both offered in the Inbox, and the task thread raises none", async () => {
  // nucleus#1538 / Spec 032: the Inbox is a decision's only owner, so a planner
  // sign-off about a task reaches the operator where he looks for it.
  const fixture = await acpFixture("t3code:synthetic");
  try {
    const stamp = new Date().toISOString();
    const decision = (id: string, tasks: string[]) =>
      decisionSchema.parse({
        id,
        version: 1,
        question: `Question ${id}?`,
        choices: [
          { label: "Yes", consequence: "Proceed" },
          { label: "No", consequence: "Hold" },
        ],
        askedBy: { agentId: "synthetic" },
        links: { tasks },
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
      });
    fixture.store.addDecision(decision("task-question", [fixture.taskId]));
    fixture.store.addDecision(decision("inbox-question", []));
    fixture.acp.observedCards({ hostId: "t3code:synthetic" }, []);
    fixture.acp.observedCards({ taskId: fixture.taskId }, []);
    // The task's own thread shows its lifecycle line only: no card, and no hold for one.
    const attach = await fixture.turn({ attach: true });
    assert.equal("elicitations" in attach, false);
    const taskThread = await fixture.turn({ waitMs: 0 });
    assert.equal(taskThread.state, "hold");
    assert.equal("elicitations" in taskThread, false);
    // The task's row still names the decision that needs the operator, wherever its card is.
    assert.equal(
      fixture.acp.openDecisionKey(fixture.taskId),
      JSON.stringify([["task-question", 1]]),
    );
    const inbox = fixture.acp.bindInbox({ hostId: "t3code:synthetic" });
    const binding = readAcpBinding(inbox.bindingPath);
    const caller = {
      kind: "inbox" as const,
      hostId: inbox.hostId,
      sessionId: inbox.sessionId,
    };
    assert.throws(
      () =>
        new Decisions(fixture.store).answer({
          id: "inbox-question",
          version: 1,
          answer: "Yes",
          answeredBy: "operator (t3code:synthetic)",
          relayed: false,
          note: "",
        }),
      /authenticated T3 session/,
    );
    fixture.acp.observedCards({ hostId: inbox.hostId }, []);
    const offered = await fixture.acp.turn(
      { ...caller, waitMs: 0 },
      binding.token,
    );
    assert.deepEqual(offered.elicitations?.map((row) => row.id).sort(), [
      "inbox-question",
      "task-question",
    ]);
    // A task-linked card names the task it is about, as the board's task link does.
    const task = fixture.store.task(fixture.taskId);
    assert.equal(
      offered.elicitations?.find((row) => row.id === "task-question")?.headline,
      [task.reference, task.title].filter(Boolean).join(" · "),
    );
    assert.equal(
      offered.elicitations?.find((row) => row.id === "inbox-question")
        ?.headline,
      "Question inbox-question?",
    );
    // A task session cannot answer a card the Inbox owns.
    await assert.rejects(
      () =>
        fixture.acp.answer(
          {
            taskId: fixture.taskId,
            sessionId: fixture.minted.sessionId,
            id: "task-question",
            version: 1,
            action: "accept",
            answer: "Yes",
          },
          fixture.token,
        ),
      /not offered/,
    );
    // An answer from the Inbox settles a task-linked decision as the T3 operator.
    await fixture.acp.answer(
      {
        ...caller,
        id: "task-question",
        version: 1,
        action: "accept",
        answer: "Yes",
      },
      binding.token,
    );
    const taskAnswered = fixture.store.decision("task-question");
    assert.equal(taskAnswered.status, "answered");
    assert.equal(
      taskAnswered.answer?.answeredBy,
      "operator (t3code:synthetic)",
    );
    assert.equal(taskAnswered.answer?.relayed, null);
    await fixture.acp.answer(
      {
        ...caller,
        id: "inbox-question",
        version: 1,
        action: "accept",
        answer: "Yes",
      },
      binding.token,
    );
    const recorded = fixture.store.decision("inbox-question");
    assert.equal(recorded.answer?.answeredBy, "operator (t3code:synthetic)");
    assert.equal(recorded.answer?.relayed, null);
    assert.deepEqual(fixture.acp.decisionSettlement("inbox-question", 1), {
      state: "answered",
      answer: "Yes",
    });
    assert.deepEqual(fixture.acp.decisionSettlement("inbox-question", 2), {
      state: "cancelled",
    });
    assert.deepEqual(
      await fixture.acp.answer(
        {
          ...caller,
          id: "inbox-question",
          version: 1,
          action: "accept",
          answer: "Yes",
        },
        binding.token,
      ),
      { recorded: false },
    );
    fixture.store.addDecision(decision("cancel-question", []));
    const cancel = {
      ...caller,
      id: "cancel-question",
      version: 1,
      action: "cancel" as const,
      requestId: "card-1",
    };
    await fixture.acp.turn({ ...caller, waitMs: 0 }, binding.token);
    await fixture.acp.answer(cancel, binding.token);
    await fixture.acp.answer(cancel, binding.token); // The same delivery cannot consume the retry twice.
    assert.deepEqual(
      (
        await fixture.acp.turn({ ...caller, waitMs: 0 }, binding.token)
      ).elicitations?.map((row) => row.id),
      ["cancel-question"],
    );
    await fixture.acp.answer({ ...cancel, requestId: "card-2" }, binding.token);
    assert.deepEqual(
      (await fixture.acp.turn({ ...caller, waitMs: 0 }, binding.token))
        .elicitations,
      [],
    );
    assert.equal(fixture.store.decision("cancel-question").status, "open");
  } finally {
    await fixture.close();
  }
});

test("an Inbox-owned decision keeps its owner, and raises no duplicate, across a service restart", async () => {
  const fixture = await acpFixture("t3code:synthetic");
  try {
    fixture.store.update(fixture.taskId, { phase: "queued", held: true });
    const stamp = new Date().toISOString();
    const id = "11111111-1111-4111-8111-111111111114";
    fixture.store.addDecision(
      decisionSchema.parse({
        id,
        version: 1,
        question: "Approve?",
        askedBy: { agentId: "synthetic" },
        choices: [
          { label: "Yes", consequence: "Proceed" },
          { label: "No", consequence: "Hold" },
        ],
        links: { tasks: [fixture.taskId] },
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
      }),
    );
    const inbox = fixture.acp.bindInbox({ hostId: "t3code:synthetic" });
    const token = readAcpBinding(inbox.bindingPath).token;
    const caller = {
      kind: "inbox" as const,
      hostId: inbox.hostId,
      sessionId: inbox.sessionId,
    };
    fixture.acp.observedCards({ hostId: inbox.hostId }, []);
    assert.equal(
      fixture.acp.pendingInboxDecisionKey(inbox.hostId),
      JSON.stringify([[id, 1]]),
    );
    assert.deepEqual(
      (
        await fixture.acp.turn({ ...caller, waitMs: 0 }, token)
      ).elicitations?.map((d) => d.id),
      [id],
    );
    fixture.acp.observedCards({ hostId: inbox.hostId }, [{ id, version: 1 }]);
    const restarted = new AcpSessions(fixture.engine, {
      dataHome: fixture.dir,
      socketPath: "unused",
      answerDecision: (input) =>
        new Decisions(fixture.store).answer(input, { trustedT3: true }),
    });
    assert.deepEqual(
      (await restarted.turn({ ...caller, waitMs: 0 }, token)).elicitations,
      [],
      "an unobserved Inbox offers nothing",
    );
    restarted.observedCards({ hostId: inbox.hostId }, [{ id, version: 1 }]);
    assert.deepEqual(
      (await restarted.turn({ ...caller, waitMs: 0 }, token)).elicitations,
      [],
      "the version keeps its Inbox owner and its live card across the restart",
    );
    await restarted.answer(
      { ...caller, id, version: 1, action: "accept", answer: "Yes" },
      token,
    );
    assert.equal(fixture.store.decision(id).status, "answered");
    assert.equal(fixture.store.task(fixture.taskId).held, true);
  } finally {
    await fixture.close();
  }
});

test("proposedOwner names the linked T3 task's host, else the host whose Inbox is offering", async () => {
  const fixture = await acpFixture("t3code:synthetic");
  try {
    const other = fixture.store.insert(
      submissionSchema.parse({
        submissionId: "second-linked-task",
        title: "Second task",
        repoPath: join(fixture.dir, "second"),
        planningCommit: base,
        brief: { text: "Synthetic brief" },
        originAgentId: "origin",
      }),
      "t3code:other-registered-host",
      "brief",
      base,
    );
    const stamp = new Date().toISOString();
    const row = (tasks: string[]) =>
      decisionSchema.parse({
        id: "11111111-1111-4111-8111-111111111117",
        version: 1,
        question: "Approve?",
        askedBy: { agentId: "synthetic" },
        choices: [
          { label: "Yes", consequence: "Proceed" },
          { label: "No", consequence: "Hold" },
        ],
        links: { tasks },
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
      });
    // The linked task's own host owns the decision, so its Inbox shows the card.
    assert.deepEqual(
      proposedOwner(
        fixture.store,
        row([other.id, fixture.taskId]),
        "t3code:synthetic",
      ),
      { kind: "inbox", hostId: "t3code:other-registered-host" },
    );
    assert.deepEqual(
      proposedOwner(
        fixture.store,
        row([fixture.taskId]),
        "t3code:other-registered-host",
      ),
      { kind: "inbox", hostId: "t3code:synthetic" },
    );
    // A decision that links no T3 task belongs to the Inbox that offers it.
    assert.deepEqual(
      proposedOwner(fixture.store, row([]), "t3code:synthetic"),
      { kind: "inbox", hostId: "t3code:synthetic" },
    );
  } finally {
    await fixture.close();
  }
});

test("an open decision bound to a task thread moves to the Inbox once, and its old card is cancelled", async () => {
  // A version bound before nucleus#1538 belonged to the task's parent thread. The
  // board ruling moved every decision to the Inbox: the next offer re-binds it, and
  // the host's own read settles the card still shown on the task thread.
  const fixture = await acpFixture("t3code:synthetic");
  try {
    const stamp = new Date().toISOString();
    const id = "11111111-1111-4111-8111-111111111116";
    fixture.store.addDecision(
      decisionSchema.parse({
        id,
        version: 1,
        question: "Approve?",
        askedBy: { agentId: "synthetic" },
        choices: [
          { label: "Yes", consequence: "Proceed" },
          { label: "No", consequence: "Hold" },
        ],
        links: { tasks: [fixture.taskId] },
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
      }),
    );
    bindOwner(fixture.store, { id, version: 1 }, {
      kind: "task",
      taskId: fixture.taskId,
      hostId: "t3code:synthetic",
      sessionId: fixture.minted.sessionId,
    } as unknown as DecisionScope);
    const inbox = fixture.acp.bindInbox({ hostId: "t3code:synthetic" });
    const token = readAcpBinding(inbox.bindingPath).token;
    const caller = {
      kind: "inbox" as const,
      hostId: inbox.hostId,
      sessionId: inbox.sessionId,
    };
    fixture.acp.observedCards({ hostId: inbox.hostId }, []);
    assert.deepEqual(
      (
        await fixture.acp.turn({ ...caller, waitMs: 0 }, token)
      ).elicitations?.map((row) => row.id),
      [id],
    );
    assert.deepEqual(boundOwner(fixture.store, { id, version: 1 }), {
      kind: "inbox",
      hostId: "t3code:synthetic",
    });
    // The card left on the task thread is settled, and the Inbox card stays open.
    assert.deepEqual(
      fixture.acp.decisionSettlement(id, 1, {
        taskId: fixture.taskId,
        sessionId: fixture.minted.sessionId,
      }),
      { state: "cancelled" },
    );
    assert.deepEqual(
      fixture.acp.decisionSettlement(id, 1, { hostId: inbox.hostId }),
      {
        state: "open",
      },
    );
    // The moved owner is used once: the same version is not re-bound by the task thread.
    assert.equal(fixture.store.decision(id).version, 1);
  } finally {
    await fixture.close();
  }
});

test("a legacy Inbox card is adopted from the host's own read before the version is offered anywhere", async () => {
  const fixture = await acpFixture("t3code:synthetic");
  try {
    const stamp = new Date().toISOString();
    const id = "11111111-1111-4111-8111-111111111115";
    fixture.store.addDecision(
      decisionSchema.parse({
        id,
        version: 1,
        question: "Approve?",
        askedBy: { agentId: "synthetic" },
        choices: [
          { label: "Yes", consequence: "Proceed" },
          { label: "No", consequence: "Hold" },
        ],
        links: { tasks: [fixture.taskId] },
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
      }),
    );
    fixture.acp.observedCards({ hostId: "t3code:synthetic" }, null);
    fixture.acp.observedCards({ taskId: fixture.taskId }, []);
    // A live card on a task thread claims no ownership: the version is still the Inbox's.
    assert.equal(boundOwner(fixture.store, { id, version: 1 }), undefined);
    fixture.acp.observedCards({ hostId: "t3code:synthetic" }, [
      { id, version: 1 },
    ]);
    assert.deepEqual(boundOwner(fixture.store, { id, version: 1 }), {
      kind: "inbox",
      hostId: "t3code:synthetic",
    });
    assert.equal(
      fixture.acp.pendingInboxDecisionKey("t3code:synthetic"),
      JSON.stringify([[id, 1]]),
    );
  } finally {
    await fixture.close();
  }
});

test("a decision card the host's own read shows pending is not offered again, and its absence is", async () => {
  // nucleus#1395: presence is the host's read of T3's pending requests, never a
  // process's assumption. A version with a live card raises none, and the version
  // whose card is gone is offered again on the next held turn.
  const fixture = await acpFixture("t3code:synthetic");
  try {
    const stamp = new Date().toISOString();
    const id = "11111111-1111-4111-8111-111111111111";
    fixture.store.addDecision(
      decisionSchema.parse({
        id,
        version: 1,
        question: "Question?",
        choices: [
          { label: "Yes", consequence: "Proceed" },
          { label: "No", consequence: "Hold" },
        ],
        askedBy: { agentId: "synthetic" },
        links: { tasks: [] },
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
      }),
    );
    const inbox = fixture.acp.bindInbox({ hostId: "t3code:synthetic" });
    const binding = readAcpBinding(inbox.bindingPath);
    const caller = {
      kind: "inbox" as const,
      hostId: inbox.hostId,
      sessionId: inbox.sessionId,
    };
    const scope = { hostId: inbox.hostId };
    const held = async () =>
      (await fixture.acp.turn({ ...caller, waitMs: 0 }, binding.token)) as {
        state: string;
        elicitations?: Array<{ id: string; version: number }>;
      };
    assert.equal((await held()).state, "hold");
    assert.deepEqual(
      (await held()).elicitations,
      [],
      "a fresh service must wait for a card observation",
    );
    // The card is pending on T3: the turn holds for it and raises nothing.
    fixture.acp.observedCards(scope, [{ id, version: 1 }]);
    assert.equal((await held()).state, "hold");
    assert.deepEqual((await held()).elicitations, []);
    assert.equal(
      fixture.acp.pendingInboxDecisionKey(inbox.hostId),
      JSON.stringify([[id, 1]]),
      "the decision still needs the operator, so the inbox is held and its title counts it",
    );
    // A live card is never released away, even by a release directive that arrived first.
    fixture.acp.release(
      inbox.sessionId,
      "no operator decision is open for the inbox",
    );
    assert.equal((await held()).state, "hold");
    // The host's next read shows the card gone: the next held turn offers the version again.
    fixture.acp.observedCards(scope, []);
    assert.deepEqual(
      (await held()).elicitations?.map((row) => [row.id, row.version]),
      [[id, 1]],
    );
    fixture.acp.observedCards(scope, null);
    assert.deepEqual(
      (await held()).elicitations,
      [],
      "an unread thread invalidates the previous absence",
    );
    fixture.acp.observedCards(scope, []);
    assert.deepEqual(
      (await held()).elicitations?.map((row) => row.id),
      [id],
      "offers resume after a successful read",
    );
  } finally {
    await fixture.close();
  }
});

test("the operator's spent re-offer stops the Inbox offer and the task row's decision signal", async () => {
  // nucleus#1395: the cap is the same rule everywhere. An Inbox that no longer offers
  // the version releases its turn, and the task's row stops naming a decision the
  // operator dismissed twice.
  const fixture = await acpFixture("t3code:synthetic");
  try {
    const stamp = new Date().toISOString();
    fixture.store.addDecision(
      decisionSchema.parse({
        id: "task-question",
        version: 1,
        question: "Question?",
        choices: [
          { label: "Yes", consequence: "Proceed" },
          { label: "No", consequence: "Hold" },
        ],
        askedBy: { agentId: "synthetic" },
        links: { tasks: [fixture.taskId] },
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
      }),
    );
    const inbox = fixture.acp.bindInbox({ hostId: "t3code:synthetic" });
    const token = readAcpBinding(inbox.bindingPath).token || fixture.token;
    const caller = {
      kind: "inbox" as const,
      hostId: inbox.hostId,
      sessionId: inbox.sessionId,
    };
    fixture.acp.observedCards({ hostId: inbox.hostId }, []);
    assert.deepEqual(
      (
        await fixture.acp.turn({ ...caller, waitMs: 0 }, token)
      ).elicitations?.map((row) => [row.id, row.version]),
      [["task-question", 1]],
    );
    const cancel = {
      ...caller,
      id: "task-question",
      version: 1,
      action: "cancel" as const,
    };
    await fixture.acp.answer({ ...cancel, requestId: "card-1" }, token);
    // One dismissal still permits the one re-offer.
    assert.deepEqual(
      (
        await fixture.acp.turn({ ...caller, waitMs: 0 }, token)
      ).elicitations?.map((row) => row.id),
      ["task-question"],
    );
    await fixture.acp.answer({ ...cancel, requestId: "card-2" }, token);
    assert.deepEqual(
      (await fixture.acp.turn({ ...caller, waitMs: 0 }, token)).elicitations,
      [],
    );
    assert.equal(
      fixture.acp.pendingInboxDecisionKey(inbox.hostId),
      null,
      "a spent re-offer no longer needs the inbox",
    );
    assert.equal(
      fixture.acp.openDecisionKey(fixture.taskId),
      null,
      "and no longer names the task's row as waiting on a decision",
    );
    fixture.acp.release(
      inbox.sessionId,
      "no operator decision is open for the inbox",
    );
    assert.equal(
      (await fixture.acp.turn({ ...caller, waitMs: 0 }, token)).state,
      "release",
    );
  } finally {
    await fixture.close();
  }
});

test("a real agent re-raises its inbox card after a turn ends and the host settles it", async () => {
  // nucleus#1395 end to end on the real socket: a card is raised, the turn ends (a
  // replaced callback socket does that) and T3 settles the leftover card without the
  // agent hearing about it, then the next held turn raises the still-open version again —
  // as often as that happens. What counts as present is the host's own read of T3's
  // pending requests, never a process's assumption.
  const fixture = await acpFixture("t3code:synthetic");
  const stamp = new Date().toISOString();
  const decision = "11111111-1111-4111-8111-111111111111";
  const field = `nucleus_${decision}_1`;
  fixture.store.addDecision(
    decisionSchema.parse({
      id: decision,
      version: 1,
      question: "Re-offer?",
      choices: [
        { label: "Yes", consequence: "Proceed" },
        { label: "No", consequence: "Hold" },
      ],
      askedBy: { agentId: "synthetic" },
      links: { tasks: [] },
      status: "open",
      createdAt: stamp,
      updatedAt: stamp,
    }),
  );
  const inbox = fixture.acp.bindInbox({ hostId: "t3code:synthetic" });
  const scope = { hostId: inbox.hostId };
  const agent = launchAgent({ worktree: inbox.directory, dir: fixture.dir });
  try {
    agent.write({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: inbox.directory, mcpServers: [] },
    });
    const opened = await agent.lines.untilId(1);
    assert.equal(
      (opened.answer.result as Record<string, unknown>).sessionId,
      inbox.sessionId,
    );
    assert.equal(fixture.store.decision(decision).status, "open");

    /** The next card the agent raises, read past the lifecycle lines. */
    const nextCard = async (what: string): Promise<unknown> => {
      for (;;) {
        const message = await agent.lines.next();
        if (message.method !== "elicitation/create") continue;
        const params = message.params as {
          requestedSchema: { properties: Record<string, unknown> };
        };
        const [carried] = Object.keys(params.requestedSchema.properties);
        assert.equal(
          carried,
          field,
          `${what} carries the decision id and version as its field`,
        );
        return message.id;
      }
    };
    /**
     * Read T3 the way a sweep does, alternating present and absent, until the held turn
     * acts on a read and raises the card. Each read is that sweep's own answer.
     */
    const raiseNext = async (what: string): Promise<unknown> => {
      let present = false;
      const sweeps = setInterval(() => {
        present = !present;
        fixture.acp.observedCards(
          scope,
          present ? [{ id: decision, version: 1 }] : [],
        );
      }, 100);
      try {
        return await nextCard(what);
      } finally {
        clearInterval(sweeps);
        fixture.acp.observedCards(scope, [{ id: decision, version: 1 }]);
      }
    };

    const raised: unknown[] = [];
    for (const round of [1, 2, 3]) {
      const request = 10 + round;
      agent.write({
        jsonrpc: "2.0",
        id: request,
        method: "session/prompt",
        params: {
          sessionId: inbox.sessionId,
          prompt: [{ type: "text", text: `round ${round}` }],
        },
      });
      raised.push(await raiseNext(`round ${round}`));
      // The turn ends before anyone answers it. T3 settles the card the ended turn left
      // without telling the agent, so only the next turn's own read can raise it again.
      agent.write({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: inbox.sessionId },
      });
      const ended = await agent.lines.untilId(request);
      assert.equal(
        (ended.answer.result as Record<string, unknown>).stopReason,
        "cancelled",
        `round ${round} ended its turn`,
      );
    }
    assert.equal(
      new Set(raised).size,
      raised.length,
      "every held turn raised its own card",
    );
    // The settlements recorded nothing: the decision is open and still offered.
    assert.equal(fixture.store.decision(decision).status, "open");
    assert.notEqual(
      fixture.acp.pendingInboxDecisionKey?.(inbox.hostId) ?? null,
      null,
    );
    assert.equal(
      agent.child.exitCode,
      null,
      `the agent is still attached: ${agent.stderr()}`,
    );
  } finally {
    agent.child.kill();
    await fixture.close();
  }
});

test("inbox ui authenticates through the inbox binding and holds only while a decision is offerable", async () => {
  const fixture = await acpFixture();
  try {
    const uiHosts: string[] = [];
    let nextStatus: "opened" | "reused" = "opened";
    const acp = new AcpSessions(fixture.engine, {
      dataHome: fixture.dir,
      socketPath: join(fixture.dir, "callback.sock"),
      pollMs: 50,
      openInboxUi: async (hostId) => {
        uiHosts.push(hostId);
        return { status: nextStatus };
      },
    });
    fixture.engine.acp = acp;
    const inbox = acp.bindInbox({ hostId: "t3code:synthetic" });
    const inboxBinding = readAcpBinding(inbox.bindingPath);

    // Task credentials are refused on /acp-inbox-ui.
    await assert.rejects(
      () =>
        callbackRequest(fixture.binding, "/acp-inbox-ui", {
          kind: "inbox",
          hostId: inbox.hostId,
          sessionId: inbox.sessionId,
        }),
      /Unauthorized callback/,
    );

    // Real ACP agent child process handles `ui` over /acp-inbox-ui and goes idle when no decisions exist.
    const agent = launchAgent({ worktree: inbox.directory, dir: fixture.dir });
    try {
      agent.write({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: inbox.directory, mcpServers: [] },
      });
      await agent.lines.untilId(1);

      agent.write({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: {
          sessionId: inbox.sessionId,
          prompt: [{ type: "text", text: "ui" }],
        },
      });
      const first = await agent.lines.untilId(2);
      assert.equal(
        (first.answer.result as Record<string, unknown>).stopReason,
        "end_turn",
      );
      assert.deepEqual(uiHosts, [inbox.hostId]);

      // With an offerable decision, `ui` keeps the turn held so the card can be raised.
      nextStatus = "reused";
      const decisionId = "33333333-3333-4333-8333-333333333333";
      fixture.store.addDecision(
        decisionSchema.parse({
          id: decisionId,
          version: 1,
          question: "Hold after ui?",
          headline: "Hold after ui",
          choices: [
            { label: "Yes", consequence: "Proceed" },
            { label: "No", consequence: "Hold" },
          ],
          askedBy: { agentId: "synthetic" },
          links: {},
          status: "open",
          createdAt: "2026-11-19T00:00:00.000Z",
          updatedAt: "2026-11-19T00:00:00.000Z",
        }),
      );
      const reply = await callbackRequest(inboxBinding, "/acp-inbox-ui", {
        kind: "inbox",
        hostId: inbox.hostId,
        sessionId: inbox.sessionId,
      });
      assert.deepEqual(reply, { status: "reused", hold: true });
    } finally {
      agent.child.kill();
    }
  } finally {
    await fixture.close();
  }
});

test("an Inbox answer settles the decision and notifies the asker", async () => {
  const fixture = await acpFixture("t3code:synthetic");
  try {
    const stamp = new Date().toISOString();
    const id = "11111111-1111-4111-8111-111111111121";
    fixture.store.addDecision(
      decisionSchema.parse({
        id,
        version: 1,
        question: "Approve the retained reviewer?",
        askedBy: { agentId: WORKER },
        choices: [
          { label: "Approve", consequence: "Review proceeds" },
          { label: "Decline", consequence: "Keep waiting" },
        ],
        links: { tasks: [fixture.taskId] },
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
      }),
    );
    const inbox = fixture.acp.bindInbox({ hostId: "t3code:synthetic" });
    const token = readAcpBinding(inbox.bindingPath).token;
    const caller = {
      kind: "inbox" as const,
      hostId: inbox.hostId,
      sessionId: inbox.sessionId,
    };
    fixture.acp.observedCards({ hostId: inbox.hostId }, []);
    assert.deepEqual(
      (
        await fixture.acp.turn({ ...caller, waitMs: 0 }, token)
      ).elicitations?.map((row) => row.id),
      [id],
    );
    await fixture.acp.answer(
      { ...caller, id, version: 1, action: "accept", answer: "Approve" },
      token,
    );
    const settled = fixture.store.decision(id);
    assert.equal(settled.status, "answered");
    assert.equal(settled.answer?.answeredBy, "operator (t3code:synthetic)");
    assert.equal(settled.delivery?.agentId, WORKER);
    assert.equal(settled.delivery?.status, "pending");
    await fixture.engine.resolution.deliverDecisionNotices();
    assert.equal(fixture.notified.length, 1);
    assert.equal(fixture.notified[0]!.agentId, WORKER);
    assert.match(fixture.notified[0]!.text, /Approve/);
  } finally {
    await fixture.close();
  }
});

test("Spec 068 batch 2: real agent over stdio emits plan, tool_call, tool_call_update, and human-only messages across the full lifecycle", async () => {
  const fixture = await acpFixture();
  // Start the task in queued with no live run yet so we observe the full life from queued -> done.
  const workerRun = fixture.store.run("run-1")!;
  fixture.store.putRun({
    ...workerRun,
    released: true,
    status: "superseded",
  } as unknown as Run);
  fixture.store.update(fixture.taskId, {
    phase: "queued",
    agentId: null,
    runId: null,
    resolution: {
      ...fixture.store.task(fixture.taskId).resolution,
      currentRunId: null,
    },
  });
  const agent = launchAgent(fixture);
  const { child, lines, write } = agent;
  const collected: Array<Record<string, unknown>> = [];
  const nextUpdate = async (
    predicate: (u: Record<string, unknown>) => boolean,
    label: string,
  ) => {
    for (let i = 0; i < 40; i++) {
      const msg = await lines.next();
      collected.push(msg);
      const update = (msg.params as Record<string, unknown> | undefined)
        ?.update as Record<string, unknown> | undefined;
      if (msg.method === "session/update" && update && predicate(update))
        return update;
    }
    throw new Error(`Did not observe expected update: ${label}`);
  };

  try {
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    await lines.untilId(1);

    write({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: fixture.worktree, mcpServers: [] },
    });
    await lines.untilId(2);

    // Opening prompt holds the turn for the entire task life.
    write({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: fixture.sessionId,
        prompt: [{ type: "text", text: "opening prompt" }],
      },
    });

    // 1. Queued: plan has Queued in_progress, plus the current wait as its own call.
    const queuedPlan = await nextUpdate(
      (u) =>
        u.sessionUpdate === "plan" &&
        Array.isArray(u.entries) &&
        (u.entries[0] as Record<string, unknown>).status === "in_progress",
      "queued plan",
    );
    assert.equal(
      (queuedPlan.entries as Array<Record<string, unknown>>)[0]!.content,
      "Queued",
    );
    const queuedWait = await nextUpdate(
      (u) =>
        u.sessionUpdate === "tool_call" &&
        String(u.toolCallId).startsWith("activity:"),
      "queued between-steps wait",
    );
    assert.equal(queuedWait.title, "Nucleus: between steps");
    assert.match(
      JSON.stringify(queuedWait.content),
      /between steps: waiting for dispatch/i,
    );

    // 2. Working with a running tool: plan moves to Working; worker tool_call shows tool + elapsed time.
    const nowIso = new Date().toISOString();
    const threeMinAgo = new Date(Date.now() - 3 * 60_000).toISOString();
    fixture.store.putRun({
      id: "run-worker-2",
      taskId: fixture.taskId,
      role: "revision",
      generation: 1,
      head: base,
      agentId: WORKER,
      workspaceId: "ws",
      profile: fixture.engine.profiles[0]!,
      status: "running",
      createdAt: threeMinAgo,
      lastObservedAt: nowIso,
      lastActivityAt: nowIso,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
      participantActivity: {
        runId: "run-worker-2",
        agentId: WORKER,
        turnId: "turn-1",
        turnStartedAt: threeMinAgo,
        permission: null,
        tool: {
          callId: "call-1",
          name: "effigy test",
          startedAt: threeMinAgo,
          lastOutputAt: nowIso,
        },
        process: null,
      },
    } as unknown as Run);
    fixture.store.update(fixture.taskId, {
      phase: "working",
      agentId: WORKER,
      runId: "run-worker-2",
      lastActivityAt: nowIso,
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        currentRunId: "run-worker-2",
      },
    });

    await nextUpdate(
      (u) =>
        u.sessionUpdate === "plan" &&
        (u.entries as Array<Record<string, unknown>>)[1]!.status ===
          "in_progress",
      "working plan",
    );
    const workerCall = await nextUpdate(
      (u) =>
        u.sessionUpdate === "tool_call" && u.toolCallId === "run:run-worker-2",
      "worker tool_call",
    );
    assert.equal(workerCall.title, "Worker: implementing the brief");
    assert.equal(workerCall.status, "in_progress");
    assert.match(
      JSON.stringify(workerCall.content),
      /Running `effigy test` · 3 min/,
    );

    // 3. Review: worker completes, reviewer starts on PR #430 at c86dc5a.
    fixture.store.putRun({
      ...fixture.store.run("run-worker-2")!,
      status: "finished",
      released: true,
      active: false,
      completion: {
        status: "ready_for_review",
        headline: "Implemented Spec 068 batch 2",
        summary: "Implemented Spec 068 batch 2",
        prNumber: 430,
        head: "c86dc5a111111111111111111111111111111111",
      },
    } as unknown as Run);
    fixture.store.putRun({
      id: "run-reviewer-1",
      taskId: fixture.taskId,
      role: "reviewer",
      generation: 1,
      head: "c86dc5a111111111111111111111111111111111",
      agentId: "reviewer-agent-1",
      workspaceId: "ws",
      profile: fixture.engine.profiles[0]!,
      status: "running",
      createdAt: nowIso,
      lastObservedAt: nowIso,
      lastActivityAt: nowIso,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    } as unknown as Run);
    fixture.store.update(fixture.taskId, {
      phase: "reviewing",
      prUrl: "https://example.test/pull/430",
      prHead: "c86dc5a111111111111111111111111111111111",
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        currentRunId: "run-reviewer-1",
      },
    });

    await nextUpdate(
      (u) =>
        u.sessionUpdate === "plan" &&
        (u.entries as Array<Record<string, unknown>>)[2]!.status ===
          "in_progress",
      "review plan",
    );
    const reviewCall = await nextUpdate(
      (u) =>
        u.sessionUpdate === "tool_call" &&
        u.toolCallId === "run:run-reviewer-1",
      "reviewer tool_call",
    );
    assert.equal(reviewCall.title, "Reviewer: reviewing PR #430 at c86dc5a");
    assert.equal(reviewCall.status, "in_progress");

    // 4. Repair (Recovering): reviewer thread vanished -> its own tool_call with cause and attempt.
    fixture.store.update(fixture.taskId, {
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        recoveryAttempts: 1,
        incident: {
          id: "inc-1",
          role: "reviewer",
          runId: "run-reviewer-1",
          fingerprint: "fp-1",
          attempt: 1,
          cause: "stalled_turn",
          detail: "Reviewer thread vanished",
          action: "replacement",
          status: "reconciling",
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        recovery: {
          id: "rec-1",
          key: "k-1",
          generation: 1,
          runId: null,
          agentId: null,
          status: "running",
          summary: "Starting fresh reviewer",
          idleSince: null,
          incidentId: "inc-1",
        },
      },
    });
    const repairCall = await nextUpdate(
      (u) =>
        u.sessionUpdate === "tool_call" && u.toolCallId === "repair:rec-1:1",
      "repair tool_call",
    );
    assert.equal(
      repairCall.title,
      "Reviewer thread vanished · starting a fresh reviewer (1 of 3)",
    );
    assert.equal(repairCall.status, "in_progress");

    // 5. Verdict summary + Question for the operator (with raw IDs/SHA in source data that must be stripped).
    const decisionId = "9d4c2b1a-7e6f-4a5b-8c9d-0e1f2a3b4c5d";
    fixture.store.putRun({
      ...fixture.store.run("run-reviewer-1")!,
      status: "finished",
      released: true,
      active: false,
      completion: {
        status: "changes_required",
        headline:
          "Fix retry bound at c86dc5a111111111111111111111111111111111 for run:run-reviewer-1",
        summary: "Fix retry bound",
        head: "c86dc5a111111111111111111111111111111111",
      },
    } as unknown as Run);
    fixture.store.addDecision(
      decisionSchema.parse({
        id: decisionId,
        version: 1,
        headline: `Should we keep the fallback? Reported from mcp:delegated-work thread:delegated-task:abc for task:${fixture.taskId}`,
        question: "Should we keep the fallback?",
        askedBy: { agentId: WORKER, project: null },
        options: ["Yes", "No"],
        links: { tasks: [fixture.taskId] },
        status: "open",
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
    );
    fixture.store.update(fixture.taskId, {
      phase: "blocked",
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        recovery: null,
        incident: null,
      },
    });

    const verdictMsg = await nextUpdate(
      (u) =>
        u.sessionUpdate === "agent_message_chunk" &&
        /Changes requested \(PR #430\)/.test(
          String((u.content as Record<string, unknown>).text),
        ),
      "verdict summary message",
    );
    const verdictText = String(
      (verdictMsg.content as Record<string, unknown>).text,
    );
    assert.match(verdictText, /Fix retry bound/);
    assert.doesNotMatch(
      verdictText,
      /c86dc5a111111111111111111111111111111111/,
    );
    assert.doesNotMatch(verdictText, /run-reviewer-1/);

    const questionMsg = await nextUpdate(
      (u) =>
        u.sessionUpdate === "agent_message_chunk" &&
        /Question for you:/.test(
          String((u.content as Record<string, unknown>).text),
        ),
      "operator question message",
    );
    const questionText = String(
      (questionMsg.content as Record<string, unknown>).text,
    );
    assert.match(questionText, /Should we keep the fallback\?/);
    assert.doesNotMatch(questionText, new RegExp(decisionId));
    assert.doesNotMatch(questionText, new RegExp(fixture.taskId));
    // Every host identifier form is stripped from what a person reads.
    assert.doesNotMatch(questionText, /mcp:delegated-work/);
    assert.doesNotMatch(questionText, /thread:delegated-task:abc/);
    assert.doesNotMatch(questionText, /t3code:\S+/);
    assert.doesNotMatch(questionText, /paseo:\S+/);

    assert.match(questionText, /answer it in the Nucleus Inbox/);
    assert.doesNotMatch(questionText, /nucleus:\/\//);
    assert.equal(
      collected.some(
        (m) =>
          m.method === "session/update" &&
          (
            (m.params as Record<string, unknown>).update as Record<
              string,
              unknown
            >
          ).content !== undefined &&
          (
            (m.params as Record<string, unknown>).update as Record<
              string,
              unknown
            >
          ).sessionUpdate === "agent_message_chunk" &&
          (
            (
              (m.params as Record<string, unknown>).update as Record<
                string,
                unknown
              >
            ).content as Record<string, unknown>
          ).type === "resource_link",
      ),
      false,
      "no custom-scheme resource link is emitted",
    );

    // 6. Done: all 5 plan steps completed, finish message emitted, turn releases.
    fixture.store.update(fixture.taskId, {
      phase: "done",
      finishedAt: new Date().toISOString(),
    });
    const doneResult = await lines.untilId(3);
    assert.equal(
      (doneResult.answer.result as Record<string, unknown>).stopReason,
      "end_turn",
    );
    collected.push(...doneResult.updates);
    const allChunks = collected
      .filter(
        (m) =>
          m.method === "session/update" &&
          (
            (m.params as Record<string, unknown>).update as Record<
              string,
              unknown
            >
          ).sessionUpdate === "agent_message_chunk",
      )
      .map(
        (m) =>
          (
            (m.params as Record<string, unknown>).update as Record<
              string,
              unknown
            >
          ).content as Record<string, unknown>,
      )
      .filter((content) => content.type === "text")
      .map((content) => String(content.text));
    assert.equal(
      allChunks.some((t) => /is done · PR #430/.test(t)),
      true,
      "finish message is emitted",
    );
    for (const text of allChunks) {
      assert.doesNotMatch(
        text,
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
        `no raw UUID in message: ${text}`,
      );
      assert.doesNotMatch(
        text,
        /\b[0-9a-f]{40}\b/i,
        `no raw 40-char SHA in message: ${text}`,
      );
      assert.doesNotMatch(
        text,
        /\b(?:run|task|agent|decision)[_:-][A-Za-z0-9_.:-]+\b/i,
        `no raw internal ID in message: ${text}`,
      );
    }

    assert.equal(await agent.close(), 0);
  } finally {
    child.kill();
    await fixture.close();
  }
});

test("Spec 068 batch 2: relaunched agent rebuilds plan and tool_calls on session/load, and text fallback sends one status line", async () => {
  const fixture = await acpFixture();
  try {
    // Reattach rebuild: relaunched agent loads the session and gets both plan and tool_call.
    const reloaded = launchAgent(fixture);
    try {
      reloaded.write({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      });
      await reloaded.lines.untilId(1);
      reloaded.write({
        jsonrpc: "2.0",
        id: 2,
        method: "session/load",
        params: {
          sessionId: fixture.sessionId,
          cwd: fixture.worktree,
          mcpServers: [],
        },
      });
      await reloaded.lines.untilId(2);
      const firstUpdate = (
        (await reloaded.lines.next()).params as Record<string, unknown>
      ).update as Record<string, unknown>;
      const secondUpdate = (
        (await reloaded.lines.next()).params as Record<string, unknown>
      ).update as Record<string, unknown>;
      assert.equal(firstUpdate.sessionUpdate, "plan");
      assert.equal(secondUpdate.sessionUpdate, "tool_call");
      assert.equal(secondUpdate.title, "Worker: implementing the brief");
      assert.equal(await reloaded.close(), 0);
    } finally {
      reloaded.child.kill();
    }

    // Text fallback: client without structured update support gets one status line, no plan/tool_call.
    const fallback = launchAgent(fixture);
    try {
      fallback.write({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: { structuredUpdates: false },
        },
      });
      await fallback.lines.untilId(1);
      fallback.write({
        jsonrpc: "2.0",
        id: 2,
        method: "session/load",
        params: {
          sessionId: fixture.sessionId,
          cwd: fixture.worktree,
          mcpServers: [],
        },
      });
      await fallback.lines.untilId(2);
      const statusUpdate = (
        (await fallback.lines.next()).params as Record<string, unknown>
      ).update as Record<string, unknown>;
      assert.equal(statusUpdate.sessionUpdate, "agent_message_chunk");
      assert.match(
        String((statusUpdate.content as Record<string, unknown>).text),
        /Working/,
      );
      assert.equal(await fallback.close(), 0);
    } finally {
      fallback.child.kill();
    }
  } finally {
    await fixture.close();
  }
});

/** Release the fixture's live worker and leave a non-working task of the named phase. */
function parkWithoutLiveRun(
  fixture: Awaited<ReturnType<typeof acpFixture>>,
  phase: Task["phase"],
) {
  const worker = fixture.store.run("run-1")!;
  fixture.store.putRun({
    ...worker,
    status: "superseded",
    released: true,
    active: false,
  } as unknown as Run);
  const task = fixture.store.task(fixture.taskId);
  fixture.store.update(fixture.taskId, {
    phase,
    agentId: null,
    runId: null,
    completion: null,
    prUrl: "https://example.test/pull/430",
    prHead: "c86dc5a111111111111111111111111111111111",
    resolution: {
      ...task.resolution,
      currentRunId: null,
      recovery: null,
      incident: null,
    },
  });
}

test("the structured view surfaces a review gap and a person-owned wait that no run owns", async () => {
  const fixture = await acpFixture();
  try {
    parkWithoutLiveRun(fixture, "reviewing");

    // A review gap: the plan's review step is in progress, and until now nothing else
    // explained it. The current reading now has its own call.
    const gap = await fixture.turn();
    assert.equal(gap.state, "hold");
    assert.ok("presentation" in gap && gap.presentation);
    assert.equal(gap.presentation.plan[2]!.status, "in_progress");
    const gapCall = gap.presentation.toolCalls.find((call) =>
      call.toolCallId.startsWith("activity:"),
    );
    assert.ok(gapCall, "the review gap has a call of its own");
    assert.equal(gapCall.status, "in_progress");
    assert.match(String(gapCall.detail), /no live run or wait/i);
    assert.equal(
      gap.presentation.toolCalls.some(
        (call) =>
          call.status === "in_progress" &&
          !call.toolCallId.startsWith("activity:"),
      ),
      false,
      "nothing else claims to be running",
    );

    // A person-owned wait with no live run: the same call names whose move it is.
    const decisionId = "2f1d3c4b-5a69-4e78-8b90-a1b2c3d4e5f6";
    fixture.store.addDecision(
      decisionSchema.parse({
        id: decisionId,
        version: 3,
        headline: "Approve the scope change",
        question: "Approve the scope change?",
        askedBy: { agentId: WORKER, project: null },
        options: ["Yes", "No"],
        links: { tasks: [fixture.taskId] },
        status: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const waiting = await fixture.turn();
    assert.ok("presentation" in waiting && waiting.presentation);
    const waitCall = waiting.presentation.toolCalls.find((call) =>
      call.toolCallId.startsWith("activity:"),
    );
    assert.ok(waitCall, "the person-owned wait has a call of its own");
    assert.equal(waitCall.title, "Nucleus: waiting for a person");
    assert.match(String(waitCall.detail), /Needs operator input/);
    assert.deepEqual(
      waiting.messages,
      [
        "Question for you: Approve the scope change — answer it in the Nucleus Inbox.",
      ],
      "the question names its decision in plain words and points at the Inbox",
    );
    assert.equal(
      JSON.stringify(waiting).includes("nucleus://"),
      false,
      "no custom-scheme address reaches the thread (planner ruling, 2026-11-23)",
    );
  } finally {
    await fixture.close();
  }
});

test("each repair attempt keeps one call id and its own title across reserve, bind, settle and later repairs", async () => {
  const fixture = await acpFixture();
  const nowIso = new Date().toISOString();
  const launch = (
    runId: string,
    episodeId: string,
    targetRole: string,
    cause: string,
  ) =>
    fixture.store.event(
      fixture.taskId,
      "telemetry_recovery",
      JSON.stringify({
        runId,
        targetRole,
        cause,
        work: "w",
        outage: false,
        episodeId,
        action: "replacement",
      }),
    );
  const recoveryRun = (
    id: string,
    status: Run["status"],
    completion: Run["completion"],
  ) =>
    fixture.store.putRun({
      id,
      taskId: fixture.taskId,
      role: "recovery",
      generation: 1,
      head: base,
      agentId: `${id}-agent`,
      workspaceId: "ws",
      profile: fixture.engine.profiles[0]!,
      status,
      createdAt: nowIso,
      lastObservedAt: nowIso,
      active: false,
      idleSince: null,
      completion,
      released: completion !== null,
    } as unknown as Run);
  const repairCalls = (reply: AcpTurnReply) =>
    ("presentation" in reply
      ? (reply.presentation?.toolCalls ?? [])
      : []
    ).filter((call) => call.toolCallId.startsWith("repair:"));

  try {
    parkWithoutLiveRun(fixture, "reviewing");

    // 1. Reserved: an episode with no run yet is already its own call.
    const reserve = (
      episodeId: string,
      incident: { role: "reviewer" | "worker"; detail: string },
      attempts: number,
    ) => {
      const task = fixture.store.task(fixture.taskId);
      fixture.store.update(fixture.taskId, {
        resolution: {
          ...task.resolution,
          recoveryAttempts: attempts,
          incident: {
            id: `inc-${episodeId}`,
            role: incident.role,
            runId: null,
            fingerprint: `fp-${episodeId}`,
            attempt: attempts,
            cause: "stalled_turn",
            detail: incident.detail,
            action: "replacement",
            status: "reconciling",
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          recovery: {
            id: episodeId,
            key: `k-${episodeId}`,
            generation: 1,
            runId: null,
            agentId: null,
            status: "running",
            summary: "",
            idleSince: null,
            incidentId: `inc-${episodeId}`,
          },
        },
      });
    };
    reserve(
      "ep-a",
      { role: "reviewer", detail: "Reviewer thread vanished" },
      1,
    );
    const reserved = await fixture.turn();
    assert.deepEqual(
      repairCalls(reserved).map((call) => [
        call.toolCallId,
        call.title,
        call.status,
      ]),
      [
        [
          "repair:ep-a:1",
          "Reviewer thread vanished · starting a fresh reviewer (1 of 3)",
          "in_progress",
        ],
      ],
    );

    // 2. Bound: the attempt's own launch facts arrive and the same call stays put.
    recoveryRun("run-rec-a", "running", null);
    launch("run-rec-a", "ep-a", "reviewer", "Reviewer thread vanished");
    {
      const task = fixture.store.task(fixture.taskId);
      fixture.store.update(fixture.taskId, {
        resolution: {
          ...task.resolution,
          currentRunId: "run-rec-a",
          recovery: {
            ...task.resolution.recovery!,
            runId: "run-rec-a",
            status: "running",
          },
        },
      });
    }
    const bound = await fixture.turn();
    assert.deepEqual(
      repairCalls(bound).map((call) => [
        call.toolCallId,
        call.title,
        call.status,
      ]),
      [
        [
          "repair:ep-a:1",
          "Reviewer thread vanished · starting a fresh reviewer (1 of 3)",
          "in_progress",
        ],
      ],
      "binding the run updates the reserved call instead of opening a second one",
    );

    // 3. Settled: the same attempt completes, still under its own identity and title.
    recoveryRun("run-rec-a", "finished", {
      status: "recovered",
      headline: "Reviewer replaced",
      summary: "Reviewer replaced",
    } as Run["completion"]);
    {
      const task = fixture.store.task(fixture.taskId);
      fixture.store.update(fixture.taskId, {
        resolution: {
          ...task.resolution,
          currentRunId: null,
          recoveryActive: false,
          recovery: { ...task.resolution.recovery!, status: "resolved" },
          incident: {
            ...task.resolution.incident!,
            status: "resolved",
            updatedAt: nowIso,
          },
        },
      });
    }
    const settled = await fixture.turn();
    assert.deepEqual(
      repairCalls(settled).map((call) => [
        call.toolCallId,
        call.title,
        call.status,
      ]),
      [
        [
          "repair:ep-a:1",
          "Reviewer thread vanished · starting a fresh reviewer (1 of 3)",
          "completed",
        ],
      ],
    );

    // 4. A second repair: the first attempt keeps its identity and words.
    reserve("ep-b", { role: "worker", detail: "Worker thread vanished" }, 2);
    const second = await fixture.turn();
    assert.deepEqual(
      repairCalls(second).map((call) => [
        call.toolCallId,
        call.title,
        call.status,
      ]),
      [
        [
          "repair:ep-a:1",
          "Reviewer thread vanished · starting a fresh reviewer (1 of 3)",
          "completed",
        ],
        [
          "repair:ep-b:1",
          "Worker thread vanished · starting a fresh worker (1 of 3)",
          "in_progress",
        ],
      ],
      "a later fault never rewrites the earlier repair, and the new attempt is its own call",
    );

    // 5. Reattach rebuilds the same plan and calls from the service, statelessly.
    recoveryRun("run-rec-b", "running", null);
    launch("run-rec-b", "ep-b", "worker", "Worker thread vanished");
    {
      const task = fixture.store.task(fixture.taskId);
      fixture.store.update(fixture.taskId, {
        resolution: {
          ...task.resolution,
          currentRunId: "run-rec-b",
          recovery: { ...task.resolution.recovery!, runId: "run-rec-b" },
        },
      });
    }
    const reattached = await fixture.turn({ attach: true });
    assert.deepEqual(
      repairCalls(reattached).map((call) => [
        call.toolCallId,
        call.title,
        call.status,
      ]),
      [
        [
          "repair:ep-a:1",
          "Reviewer thread vanished · starting a fresh reviewer (1 of 3)",
          "completed",
        ],
        [
          "repair:ep-b:1",
          "Worker thread vanished · starting a fresh worker (1 of 3)",
          "in_progress",
        ],
      ],
      "a relaunched agent rebuilds each attempt from its own facts",
    );
  } finally {
    await fixture.close();
  }
});

test("a reported repair keeps one completed call until its episode settles", async () => {
  const fixture = await acpFixture();
  const nowIso = new Date().toISOString();
  try {
    parkWithoutLiveRun(fixture, "reviewing");
    const reserveEpisode = (episodeId: string) => {
      const task = fixture.store.task(fixture.taskId);
      fixture.store.update(fixture.taskId, {
        resolution: {
          ...task.resolution,
          recoveryAttempts: 1,
          incident: {
            id: `inc-${episodeId}`,
            role: "reviewer",
            runId: null,
            fingerprint: `fp-${episodeId}`,
            attempt: 1,
            cause: "stalled_turn",
            detail: "Reviewer thread vanished",
            action: "replacement",
            status: "reconciling",
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          recovery: {
            id: episodeId,
            key: `k-${episodeId}`,
            generation: 1,
            runId: null,
            agentId: null,
            status: "running",
            summary: "",
            idleSince: null,
            incidentId: `inc-${episodeId}`,
          },
        },
      });
    };
    reserveEpisode("ep-r");
    const reserved = await fixture.turn();
    assert.ok("presentation" in reserved && reserved.presentation);
    assert.deepEqual(
      reserved.presentation.toolCalls
        .filter((call) => call.toolCallId.startsWith("repair:"))
        .map((call) => [call.toolCallId, call.status]),
      [["repair:ep-r:1", "in_progress"]],
    );

    // The coordinator's authenticated report lands while the episode is still running
    // and its accepted action is pending: the run has a completion and is not released.
    fixture.store.putRun({
      id: "run-rec-r",
      taskId: fixture.taskId,
      role: "recovery",
      generation: 1,
      head: base,
      agentId: "run-rec-r-agent",
      workspaceId: "ws",
      profile: fixture.engine.profiles[0]!,
      status: "running",
      createdAt: nowIso,
      lastObservedAt: nowIso,
      active: false,
      idleSince: null,
      completion: {
        status: "recovered",
        headline: "Reviewer replaced",
        summary: "Reviewer replaced",
      },
      released: false,
    } as unknown as Run);
    fixture.store.event(
      fixture.taskId,
      "telemetry_recovery",
      JSON.stringify({
        runId: "run-rec-r",
        targetRole: "reviewer",
        cause: "Reviewer thread vanished",
        outage: false,
        episodeId: "ep-r",
        action: "replacement",
      }),
    );
    {
      const task = fixture.store.task(fixture.taskId);
      fixture.store.update(fixture.taskId, {
        resolution: {
          ...task.resolution,
          currentRunId: "run-rec-r",
          recovery: {
            ...task.resolution.recovery!,
            runId: "run-rec-r",
            status: "running",
          },
        },
      });
    }
    const reporting = await fixture.turn();
    assert.ok("presentation" in reporting && reporting.presentation);
    assert.deepEqual(
      reporting.presentation.toolCalls
        .filter((call) => call.toolCallId.startsWith("repair:"))
        .map((call) => [call.toolCallId, call.status, call.title]),
      [
        [
          "repair:ep-r:1",
          "completed",
          "Reviewer thread vanished · starting a fresh reviewer (1 of 3)",
        ],
      ],
      "a reported repair is one completed call, not completed and in progress at once",
    );

    // Settlement keeps that one status.
    fixture.store.putRun({
      ...fixture.store.run("run-rec-r")!,
      status: "finished",
      released: true,
    } as unknown as Run);
    {
      const task = fixture.store.task(fixture.taskId);
      fixture.store.update(fixture.taskId, {
        resolution: {
          ...task.resolution,
          currentRunId: null,
          recoveryActive: false,
          recovery: { ...task.resolution.recovery!, status: "resolved" },
          incident: {
            ...task.resolution.incident!,
            status: "resolved",
            updatedAt: nowIso,
          },
        },
      });
    }
    const settled = await fixture.turn();
    assert.ok("presentation" in settled && settled.presentation);
    assert.deepEqual(
      settled.presentation.toolCalls
        .filter((call) => call.toolCallId.startsWith("repair:"))
        .map((call) => [call.toolCallId, call.status]),
      [["repair:ep-r:1", "completed"]],
    );
  } finally {
    await fixture.close();
  }
});

test("a same-episode retry is its own attempt, and uncharged launches never raise the count", async () => {
  const fixture = await acpFixture();
  const nowIso = new Date().toISOString();
  const reserve = (episodeId: string) => {
    const task = fixture.store.task(fixture.taskId);
    const next = task.resolution.recoveryAttempts + 1;
    fixture.store.update(fixture.taskId, {
      resolution: {
        ...task.resolution,
        recoveryAttempts: next,
        incident: {
          id: `inc-${episodeId}`,
          role: "worker",
          runId: null,
          fingerprint: `fp-${episodeId}`,
          attempt: next,
          cause: "stalled_turn",
          detail: "Worker thread vanished",
          action: "replacement",
          status: "reconciling",
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        recovery: {
          id: episodeId,
          key: `k-${episodeId}`,
          generation: 1,
          runId: null,
          agentId: null,
          status: "running",
          summary: "",
          idleSince: null,
          incidentId: `inc-${episodeId}`,
        },
      },
    });
  };
  const launch = (runId: string, episodeId: string, outage: boolean) =>
    fixture.store.event(
      fixture.taskId,
      "telemetry_recovery",
      JSON.stringify({
        runId,
        targetRole: "worker",
        cause: "Worker thread vanished",
        outage,
        episodeId,
        action: "replacement",
      }),
    );
  const runs = (reply: AcpTurnReply) =>
    ("presentation" in reply ? (reply.presentation?.toolCalls ?? []) : [])
      .filter((call) => call.toolCallId.startsWith("repair:"))
      .map((call) => [call.toolCallId, call.status, call.title]);
  const recoveryRun = (id: string, released: boolean) =>
    fixture.store.putRun({
      id,
      taskId: fixture.taskId,
      role: "recovery",
      generation: 1,
      head: base,
      agentId: `${id}-agent`,
      workspaceId: "ws",
      profile: fixture.engine.profiles[0]!,
      status: released ? "superseded" : "running",
      createdAt: nowIso,
      lastObservedAt: nowIso,
      active: false,
      idleSince: null,
      completion: null,
      released,
    } as unknown as Run);
  const bind = (runId: string) => {
    const task = fixture.store.task(fixture.taskId);
    fixture.store.update(fixture.taskId, {
      resolution: {
        ...task.resolution,
        currentRunId: runId,
        recovery: { ...task.resolution.recovery!, runId },
      },
    });
  };
  try {
    parkWithoutLiveRun(fixture, "working");

    // The episode's first attempt is charged and released before any send, so the
    // episode is retained with no run bound to it.
    reserve("ep-u");
    const reservedFirst = await fixture.turn();
    assert.deepEqual(runs(reservedFirst), [
      [
        "repair:ep-u:1",
        "in_progress",
        "Worker thread vanished · starting a fresh worker (1 of 3)",
      ],
    ]);
    recoveryRun("run-rec-u", true);
    launch("run-rec-u", "ep-u", false);

    // The retry under the same episode is a new call, and its own attempt count.
    reserve("ep-u");
    const retried = await fixture.turn();
    assert.deepEqual(
      runs(retried),
      [
        [
          "repair:ep-u:1",
          "completed",
          "Worker thread vanished · starting a fresh worker (1 of 3)",
        ],
        [
          "repair:ep-u:2",
          "in_progress",
          "Worker thread vanished · starting a fresh worker (2 of 3)",
        ],
      ],
      "the retry is a new call under the same episode, never a reuse of the settled one",
    );

    // Binding the retry's run keeps its attempt identity and only changes its status.
    recoveryRun("run-rec-u2", false);
    launch("run-rec-u2", "ep-u", false);
    bind("run-rec-u2");
    const bound = await fixture.turn({ attach: true });
    assert.deepEqual(
      runs(bound),
      [
        [
          "repair:ep-u:1",
          "completed",
          "Worker thread vanished · starting a fresh worker (1 of 3)",
        ],
        [
          "repair:ep-u:2",
          "in_progress",
          "Worker thread vanished · starting a fresh worker (2 of 3)",
        ],
      ],
      "the retry keeps its id across bind",
    );

    // A launch no provider outage charged is still an attempt, but it does not raise
    // the count against the bound, and the limit stays three.
    fixture.store.putRun({
      ...fixture.store.run("run-rec-u2")!,
      released: true,
      status: "superseded",
    } as unknown as Run);
    {
      const task = fixture.store.task(fixture.taskId);
      fixture.store.update(fixture.taskId, {
        resolution: { ...task.resolution, currentRunId: null },
      });
    }
    recoveryRun("run-rec-u3", false);
    launch("run-rec-u3", "ep-u", true);
    bind("run-rec-u3");
    const uncharged = await fixture.turn();
    assert.deepEqual(
      runs(uncharged).at(-1),
      [
        "repair:ep-u:3",
        "in_progress",
        "Worker thread vanished · starting a fresh worker (2 of 3)",
      ],
      "an uncharged outage launch never raises the displayed attempt or the limit",
    );
  } finally {
    await fixture.close();
  }
});

test("a refunded launch stays out of the displayed repair count", async () => {
  const fixture = await acpFixture();
  const nowIso = new Date().toISOString();
  const recoveryRun = (id: string, released: boolean) =>
    fixture.store.putRun({
      id,
      taskId: fixture.taskId,
      role: "recovery",
      generation: 1,
      head: base,
      agentId: `${id}-agent`,
      workspaceId: "ws",
      profile: fixture.engine.profiles[0]!,
      status: released ? "superseded" : "running",
      createdAt: nowIso,
      lastObservedAt: nowIso,
      active: false,
      idleSince: null,
      completion: null,
      released,
    } as unknown as Run);
  const repairCalls = (reply: AcpTurnReply) =>
    ("presentation" in reply ? (reply.presentation?.toolCalls ?? []) : [])
      .filter((call) => call.toolCallId.startsWith("repair:"))
      .map((call) => [call.toolCallId, call.title]);
  try {
    parkWithoutLiveRun(fixture, "working");
    const task = fixture.store.task(fixture.taskId);
    fixture.store.update(fixture.taskId, {
      resolution: {
        ...task.resolution,
        recoveryAttempts: 1,
        incident: {
          id: "inc-refund",
          role: "worker",
          runId: null,
          fingerprint: "fp-refund",
          attempt: 1,
          cause: "stalled_turn",
          detail: "Worker thread vanished",
          action: "replacement",
          status: "reconciling",
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        recovery: {
          id: "ep-refund",
          key: "k-refund",
          generation: 1,
          runId: null,
          agentId: null,
          status: "running",
          summary: "",
          idleSince: null,
          incidentId: "inc-refund",
        },
      },
    });
    // The launch was recorded, then a proved pre-send host-read refusal released and
    // refunded it; the episode is retained with no run bound.
    recoveryRun("run-rec-refund", true);
    fixture.store.event(
      fixture.taskId,
      "telemetry_recovery",
      JSON.stringify({
        runId: "run-rec-refund",
        targetRole: "worker",
        cause: "Worker thread vanished",
        outage: false,
        episodeId: "ep-refund",
        action: "replacement",
      }),
    );
    fixture.store.event(
      fixture.taskId,
      "recovery_transient_read_released",
      "run-rec-refund",
    );
    const retried = await fixture.turn();
    assert.deepEqual(
      repairCalls(retried),
      [
        [
          "repair:ep-refund:1",
          "Worker thread vanished · starting a fresh worker (1 of 3)",
        ],
        [
          "repair:ep-refund:2",
          "Worker thread vanished · starting a fresh worker (1 of 3)",
        ],
      ],
      "the refunded launch keeps its own call but charges nothing, so the retry is still the first attempt",
    );
    assert.doesNotMatch(
      "presentation" in retried ? (retried.presentation?.statusLine ?? "") : "",
      /2 of 3/,
      "the fallback line agrees with the structured count",
    );
  } finally {
    await fixture.close();
  }
});

test("a later wait after work started keeps its own lifetime in one held session", async () => {
  const fixture = await acpFixture();
  try {
    // Dispatch wait: the fixture's worker is released and the task is queued.
    const worker = fixture.store.run("run-1")!;
    fixture.store.putRun({
      ...worker,
      released: true,
      status: "superseded",
      active: false,
    } as unknown as Run);
    fixture.store.update(fixture.taskId, {
      phase: "queued",
      agentId: null,
      runId: null,
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        currentRunId: null,
      },
    });
    const dispatch = await fixture.turn();
    assert.ok("presentation" in dispatch && dispatch.presentation);
    const dispatchWait = dispatch.presentation.toolCalls.find((call) =>
      call.toolCallId.startsWith("activity:"),
    );
    assert.ok(dispatchWait, "the dispatch wait has a call");
    assert.match(String(dispatchWait.detail), /waiting for dispatch/i);

    // Work starts: the wait call is gone and the worker's own call is live.
    const startedIso = new Date().toISOString();
    fixture.store.putRun({
      id: "run-worker-again",
      taskId: fixture.taskId,
      role: "revision",
      generation: 1,
      head: base,
      agentId: WORKER,
      workspaceId: "ws",
      profile: fixture.engine.profiles[0]!,
      status: "running",
      createdAt: startedIso,
      lastObservedAt: startedIso,
      lastActivityAt: startedIso,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    } as unknown as Run);
    fixture.store.update(fixture.taskId, {
      phase: "working",
      agentId: WORKER,
      runId: "run-worker-again",
      lastActivityAt: startedIso,
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        currentRunId: "run-worker-again",
      },
    });
    const working = await fixture.turn();
    assert.ok("presentation" in working && working.presentation);
    assert.equal(
      working.presentation.toolCalls.some((call) =>
        call.toolCallId.startsWith("activity:"),
      ),
      false,
      "the dispatch wait ends when work starts",
    );

    // A later wait: a new occurrence, with its own call and words.
    const waitingSince = new Date(Date.now() - 60_000).toISOString();
    fixture.store.putRun({
      ...fixture.store.run("run-worker-again")!,
      status: "finished",
      released: true,
      active: false,
      completion: {
        status: "ready_for_review",
        headline: "Implemented Spec 068 batch 2",
        summary: "Implemented Spec 068 batch 2",
        prNumber: 430,
        head: "c86dc5a111111111111111111111111111111111",
      },
    } as unknown as Run);
    fixture.store.update(fixture.taskId, {
      phase: "awaiting_review",
      prUrl: "https://example.test/pull/430",
      prHead: "c86dc5a111111111111111111111111111111111",
      reason: "Waiting on the host",
      updatedAt: waitingSince,
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        currentRunId: null,
        hostWait: { hostId: "t3code:one", since: waitingSince },
      } as Task["resolution"],
    });
    const waiting = await fixture.turn();
    assert.ok("presentation" in waiting && waiting.presentation);
    const laterWait = waiting.presentation.toolCalls.find((call) =>
      call.toolCallId.startsWith("activity:"),
    );
    assert.ok(laterWait, "the later wait is its own call");
    assert.notEqual(
      laterWait.toolCallId,
      dispatchWait.toolCallId,
      "each wait occurrence has its own lifetime",
    );
    assert.match(String(laterWait.detail), /host/i);
  } finally {
    await fixture.close();
  }
});

test("a recurring gap is a new call, and an unrelated write never splits an anchored wait", async () => {
  const fixture = await acpFixture();
  const nowIso = new Date().toISOString();
  const waitCall = (reply: AcpTurnReply) =>
    ("presentation" in reply ? (reply.presentation?.toolCalls ?? []) : []).find(
      (call) => call.toolCallId.startsWith("activity:"),
    );
  try {
    parkWithoutLiveRun(fixture, "reviewing");
    // Gap 1: a review with no live run reads as an unclassified stall.
    const gapOne = waitCall(await fixture.turn());
    assert.ok(gapOne, "the first gap is its own wait call");
    assert.equal(gapOne.toolCallId.startsWith("activity:unclassified:"), true);

    // Active review: the gap call is gone while the reviewer works.
    fixture.store.putRun({
      id: "run-review-gap",
      taskId: fixture.taskId,
      role: "reviewer",
      generation: 1,
      head: "c86dc5a111111111111111111111111111111111",
      agentId: "reviewer-agent-gap",
      workspaceId: "ws",
      profile: fixture.engine.profiles[0]!,
      status: "running",
      createdAt: nowIso,
      lastObservedAt: nowIso,
      lastActivityAt: nowIso,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    } as unknown as Run);
    fixture.store.update(fixture.taskId, {
      phase: "reviewing",
      lastActivityAt: nowIso,
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        currentRunId: "run-review-gap",
      },
    });
    assert.equal(waitCall(await fixture.turn()), undefined);

    // Gap 2: the same reading after that review ends is a fresh occurrence.
    fixture.store.putRun({
      ...fixture.store.run("run-review-gap")!,
      status: "finished",
      released: true,
      active: false,
      completion: {
        status: "changes_required",
        headline: "Fix the fallback bound",
        summary: "Fix the fallback bound",
        head: "c86dc5a111111111111111111111111111111111",
      },
    } as unknown as Run);
    fixture.store.update(fixture.taskId, {
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        currentRunId: null,
      },
    });
    const gapTwo = waitCall(await fixture.turn());
    assert.ok(gapTwo, "the second gap is its own wait call");
    assert.equal(gapTwo.toolCallId.startsWith("activity:unclassified:"), true);
    assert.notEqual(
      gapTwo.toolCallId,
      gapOne.toolCallId,
      "a fresh gap never reuses the call the agent already completed",
    );

    // An anchored wait keeps its id across an unrelated write.
    const hostSince = new Date(Date.now() - 120_000).toISOString();
    fixture.store.update(fixture.taskId, {
      phase: "awaiting_review",
      reason: "Waiting on the host",
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        hostWait: { hostId: "t3code:one", since: hostSince },
      } as Task["resolution"],
    });
    const anchored = waitCall(await fixture.turn());
    assert.ok(anchored, "the host wait is its own call");
    fixture.store.update(fixture.taskId, {
      reason: "Waiting on the host (unrelated note)",
    });
    const afterWrite = waitCall(await fixture.turn());
    assert.ok(afterWrite, "the host wait is still shown after the write");
    assert.equal(
      afterWrite.toolCallId,
      anchored.toolCallId,
      "an unrelated write never splits one wait into two calls",
    );
    assert.equal(
      afterWrite.detail,
      anchored.detail,
      "the wait's own words are unchanged",
    );
  } finally {
    await fixture.close();
  }
});

test("a new decision and a secondary stop each keep or open the wait call they belong to", async () => {
  const fixture = await acpFixture();
  const nowIso = new Date().toISOString();
  const waitCall = (reply: AcpTurnReply) =>
    ("presentation" in reply ? (reply.presentation?.toolCalls ?? []) : []).find(
      (call) => call.toolCallId.startsWith("activity:"),
    );
  const decision = (id: string, headline: string) =>
    decisionSchema.parse({
      id,
      version: 1,
      headline,
      question: `${headline}?`,
      askedBy: { agentId: WORKER, project: null },
      options: ["Yes", "No"],
      links: { tasks: [fixture.taskId] },
      status: "open",
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  try {
    parkWithoutLiveRun(fixture, "reviewing");

    // Decision A: the person-owned wait is its own call.
    const first = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const second = "1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
    fixture.store.addDecision(decision(first, "Approve the scope change"));
    const waitForFirst = waitCall(await fixture.turn());
    assert.ok(waitForFirst, "the first decision's wait has its own call");
    assert.match(String(waitForFirst.detail), /Needs operator input/);

    // Answer it and open a second decision: a new occurrence, so a new call.
    new Decisions(fixture.store).answer({
      id: first,
      version: 1,
      answer: "Yes",
      answeredBy: "operator",
      relayed: false,
      note: "",
    });
    fixture.store.addDecision(decision(second, "Approve the follow-up"));
    const waitForSecond = waitCall(await fixture.turn());
    assert.ok(waitForSecond, "the second decision's wait has its own call");
    assert.notEqual(
      waitForSecond.toolCallId,
      waitForFirst.toolCallId,
      "two separate operator decisions never share one completed wait call",
    );

    // A host wait keeps its call while a secondary stop is recorded beside it.
    new Decisions(fixture.store).answer({
      id: second,
      version: 1,
      answer: "Yes",
      answeredBy: "operator",
      relayed: false,
      note: "",
    });
    const hostSince = new Date(Date.now() - 180_000).toISOString();
    fixture.store.update(fixture.taskId, {
      reason: "Waiting on the host",
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        hostWait: { hostId: "t3code:one", since: hostSince },
      } as Task["resolution"],
    });
    const hostWait = waitCall(await fixture.turn());
    assert.ok(hostWait, "the host wait is its own call");
    assert.match(String(hostWait.detail), /host/i);
    fixture.store.update(fixture.taskId, {
      reason: "Participant turn stalled",
      resolution: {
        ...fixture.store.task(fixture.taskId).resolution,
        stop: {
          reason: "run_stalled",
          detail: "Participant turn stalled",
          since: nowIso,
          suggestedVerbs: [],
        },
      } as Task["resolution"],
    });
    const stillHostWait = waitCall(await fixture.turn());
    assert.ok(stillHostWait, "the host wait is still shown");
    assert.equal(
      stillHostWait.toolCallId,
      hostWait.toolCallId,
      "a secondary stop recorded beside a continuing host wait never splits its call",
    );
    assert.equal(
      stillHostWait.detail,
      hostWait.detail,
      "the wait's words are unchanged",
    );
  } finally {
    await fixture.close();
  }
});

test("a reserved repair keeps one call through an operator decision, its bind and its settlement", async () => {
  const fixture = await acpFixture();
  const nowIso = new Date().toISOString();
  const agent = launchAgent(fixture);
  const { child, lines, write } = agent;
  const decisionId = "3b4c5d6e-7f80-4a1b-9c2d-3e4f5a6b7c8d";
  try {
    parkWithoutLiveRun(fixture, "working");
    // A repair is reserved: an episode with no run bound, plus an operator decision.
    const task = fixture.store.task(fixture.taskId);
    fixture.store.update(fixture.taskId, {
      resolution: {
        ...task.resolution,
        recoveryAttempts: 1,
        incident: {
          id: "inc-held",
          role: "worker",
          runId: null,
          fingerprint: "fp-held",
          attempt: 1,
          cause: "stalled_turn",
          detail: "Worker thread vanished",
          action: "replacement",
          status: "reconciling",
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        recovery: {
          id: "ep-held",
          key: "k-held",
          generation: 1,
          runId: null,
          agentId: null,
          status: "running",
          summary: "",
          idleSince: null,
          incidentId: "inc-held",
        },
      },
    });
    fixture.store.addDecision(
      decisionSchema.parse({
        id: decisionId,
        version: 1,
        headline: "Approve the scope change",
        question: "Approve the scope change?",
        askedBy: { agentId: WORKER, project: null },
        options: ["Yes", "No"],
        links: { tasks: [fixture.taskId] },
        status: "open",
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
    );

    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    await lines.untilId(1);
    write({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: fixture.worktree, mcpServers: [] },
    });
    await lines.untilId(2);
    write({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: fixture.sessionId,
        prompt: [{ type: "text", text: "opening prompt" }],
      },
    });

    const collected: Array<Record<string, unknown>> = [];
    const nextUpdate = async (
      predicate: (update: Record<string, unknown>) => boolean,
      label: string,
    ) => {
      for (let i = 0; i < 60; i++) {
        const message = await lines.next();
        collected.push(message);
        const update = (message.params as Record<string, unknown> | undefined)
          ?.update as Record<string, unknown> | undefined;
        if (message.method === "session/update" && update && predicate(update))
          return update;
      }
      throw new Error(`Did not observe expected update: ${label}`);
    };
    const repairUpdates = () =>
      collected
        .map(
          (message) =>
            ((message.params as Record<string, unknown> | undefined)?.update ??
              {}) as Record<string, unknown>,
        )
        .filter((update) =>
          String(update.toolCallId ?? "").startsWith("repair:"),
        );

    // A decision is open and the repair is still reserved: both show, and the reserved
    // repair is its own call.
    await nextUpdate(
      (update) =>
        update.sessionUpdate === "tool_call" &&
        update.toolCallId === "repair:ep-held:1" &&
        update.status === "in_progress",
      "reserved repair call",
    );
    await nextUpdate(
      (update) =>
        update.sessionUpdate === "tool_call" &&
        String(update.toolCallId).startsWith("activity:needs_person:"),
      "operator decision wait",
    );

    // Answer the decision: the wait ends, the reserved repair must not be completed.
    new Decisions(fixture.store).answer({
      id: decisionId,
      version: 1,
      answer: "Yes",
      answeredBy: "operator",
      relayed: false,
      note: "",
    });
    await nextUpdate(
      (update) =>
        update.sessionUpdate === "tool_call_update" &&
        String(update.toolCallId).startsWith("activity:") &&
        update.status === "completed",
      "decision wait completed",
    );

    // Bind the coordinator: the same repair call continues, with its own attempt's facts.
    fixture.store.putRun({
      id: "run-coord-held",
      taskId: fixture.taskId,
      role: "recovery",
      generation: 1,
      head: base,
      agentId: "run-coord-held-agent",
      workspaceId: "ws",
      profile: fixture.engine.profiles[0]!,
      status: "running",
      createdAt: nowIso,
      lastObservedAt: nowIso,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
    } as unknown as Run);
    fixture.store.event(
      fixture.taskId,
      "telemetry_recovery",
      JSON.stringify({
        runId: "run-coord-held",
        targetRole: "worker",
        cause: "Worker thread vanished",
        outage: false,
        episodeId: "ep-held",
        action: "replacement",
      }),
    );
    {
      const bound = fixture.store.task(fixture.taskId);
      fixture.store.update(fixture.taskId, {
        resolution: {
          ...bound.resolution,
          currentRunId: "run-coord-held",
          recovery: { ...bound.resolution.recovery!, runId: "run-coord-held" },
        },
      });
    }
    await nextUpdate(
      (update) =>
        update.sessionUpdate === "tool_call_update" &&
        update.toolCallId === "repair:ep-held:1",
      "bound repair update",
    );

    // The attempt's own report settles it, once, under the same call.
    fixture.store.putRun({
      ...fixture.store.run("run-coord-held")!,
      status: "finished",
      released: true,
      active: false,
      completion: {
        status: "recovered",
        headline: "Worker replaced",
        summary: "Worker replaced",
      },
    } as unknown as Run);
    await nextUpdate(
      (update) =>
        update.sessionUpdate === "tool_call_update" &&
        update.toolCallId === "repair:ep-held:1" &&
        update.status === "completed",
      "settled repair call",
    );

    const ids = new Set(
      repairUpdates().map((update) => String(update.toolCallId)),
    );
    assert.deepEqual(
      [...ids],
      ["repair:ep-held:1"],
      "one attempt is one call from reservation through bind to settlement",
    );
    // The only completion is the settlement at the end of the sequence.
    const firstCompletion = repairUpdates().findIndex(
      (update) =>
        update.sessionUpdate === "tool_call_update" &&
        update.status === "completed",
    );
    assert.equal(
      firstCompletion,
      repairUpdates().length - 1,
      "nothing completes the reserved attempt before its own settlement",
    );
    assert.equal(
      repairUpdates().some(
        (update) =>
          update.sessionUpdate === "tool_call" && update.status === "completed",
      ),
      false,
      "the attempt is never re-created as a settled call",
    );
  } finally {
    child.kill();
    await fixture.close();
  }
});

test("an unbound reservation that escalates ends its one call as terminal, never in progress", async () => {
  const fixture = await acpFixture();
  const nowIso = new Date().toISOString();
  const agent = launchAgent(fixture);
  const { child, lines, write } = agent;
  try {
    parkWithoutLiveRun(fixture, "working");
    // A repair is reserved: an episode with no coordinator run row at all.
    const task = fixture.store.task(fixture.taskId);
    fixture.store.update(fixture.taskId, {
      resolution: {
        ...task.resolution,
        recoveryAttempts: 1,
        incident: {
          id: "inc-escalated",
          role: "worker",
          runId: null,
          fingerprint: "fp-escalated",
          attempt: 1,
          cause: "stalled_turn",
          detail: "Worker thread vanished",
          action: "replacement",
          status: "reconciling",
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        recovery: {
          id: "ep-escalated",
          key: "k-escalated",
          generation: 1,
          runId: null,
          agentId: null,
          status: "running",
          summary: "",
          idleSince: null,
          incidentId: "inc-escalated",
        },
      },
    });

    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    await lines.untilId(1);
    write({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: fixture.worktree, mcpServers: [] },
    });
    await lines.untilId(2);
    write({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: fixture.sessionId,
        prompt: [{ type: "text", text: "opening prompt" }],
      },
    });

    const collected: Array<Record<string, unknown>> = [];
    const nextUpdate = async (
      predicate: (update: Record<string, unknown>) => boolean,
      label: string,
    ) => {
      for (let i = 0; i < 60; i++) {
        const message = await lines.next();
        collected.push(message);
        const update = (message.params as Record<string, unknown> | undefined)
          ?.update as Record<string, unknown> | undefined;
        if (message.method === "session/update" && update && predicate(update))
          return update;
      }
      throw new Error(`Did not observe expected update: ${label}`);
    };
    const repairUpdates = () =>
      collected
        .map(
          (message) =>
            ((message.params as Record<string, unknown> | undefined)?.update ??
              {}) as Record<string, unknown>,
        )
        .filter((update) =>
          String(update.toolCallId ?? "").startsWith("repair:"),
        );

    await nextUpdate(
      (update) =>
        update.sessionUpdate === "tool_call" &&
        update.toolCallId === "repair:ep-escalated:1" &&
        update.status === "in_progress",
      "reserved repair call",
    );

    // The episode escalates before any coordinator run is recorded: the explicit
    // escalation is the attempt's own settlement fact.
    {
      const current = fixture.store.task(fixture.taskId);
      fixture.store.update(fixture.taskId, {
        phase: "needs_attention",
        reason: "Waiting for a planner decision",
        resolution: {
          ...current.resolution,
          recoveryActive: false,
          recovery: {
            ...current.resolution.recovery!,
            status: "escalated",
            summary:
              "The coordinator stopped after a reporting reminder, but this issue still needs attention",
          },
          incident: {
            ...current.resolution.incident!,
            status: "escalated",
            detail:
              "The coordinator stopped after a reporting reminder, but this issue still needs attention",
            updatedAt: nowIso,
          },
        },
      });
    }

    const terminal = await nextUpdate(
      (update) =>
        update.sessionUpdate === "tool_call_update" &&
        update.toolCallId === "repair:ep-escalated:1" &&
        update.status === "failed",
      "escalated repair call",
    );
    assert.equal(terminal.toolCallId, "repair:ep-escalated:1");
    await nextUpdate(
      (update) =>
        update.sessionUpdate === "tool_call" &&
        String(update.toolCallId).startsWith("activity:needs_person:"),
      "operator wait beside the escalation",
    );

    // One call, and it ends terminal: nothing is left in progress and no second id.
    assert.deepEqual(
      [...new Set(repairUpdates().map((update) => String(update.toolCallId)))],
      ["repair:ep-escalated:1"],
    );
    assert.deepEqual(
      repairUpdates().map((update) => String(update.status)),
      ["in_progress", "failed"],
      "the attempt ends terminal once, never left in progress",
    );
  } finally {
    child.kill();
    await fixture.close();
  }
});

/**
 * A real agent on stdio holding the opening prompt of one task session, collecting every
 * `session/update` frame it sends.
 */
async function heldSession(fixture: Awaited<ReturnType<typeof acpFixture>>) {
  const agent = launchAgent(fixture);
  const { lines, write } = agent;
  write({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  });
  await lines.untilId(1);
  write({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: fixture.worktree, mcpServers: [] },
  });
  await lines.untilId(2);
  write({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      sessionId: fixture.sessionId,
      prompt: [{ type: "text", text: "opening prompt" }],
    },
  });
  const updates: Array<Record<string, unknown>> = [];
  return {
    child: agent.child,
    updates,
    async next(
      predicate: (update: Record<string, unknown>) => boolean,
      label: string,
    ) {
      for (let i = 0; i < 80; i++) {
        const message = await lines.next();
        const update = (message.params as Record<string, unknown> | undefined)
          ?.update as Record<string, unknown> | undefined;
        if (message.method !== "session/update" || !update) continue;
        updates.push(update);
        if (predicate(update)) return update;
      }
      throw new Error(`Did not observe expected update: ${label}`);
    },
    /** Every status one call id was sent with, in order. */
    statuses(toolCallId: string) {
      return updates
        .filter((update) => update.toolCallId === toolCallId)
        .map((update) => String(update.status));
    },
  };
}

const isCall =
  (toolCallId: string, status: string) => (update: Record<string, unknown>) =>
    (update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update") &&
    update.toolCallId === toolCallId &&
    update.status === status;

/** A reserved repair: a live episode with no run bound, under an open incident. */
function reserveRepair(
  fixture: Awaited<ReturnType<typeof acpFixture>>,
  episodeId: string,
  status: "pending" | "running" = "running",
) {
  const nowIso = new Date().toISOString();
  const task = fixture.store.task(fixture.taskId);
  return fixture.store.update(fixture.taskId, {
    resolution: {
      ...task.resolution,
      recoveryActive: true,
      incident: {
        id: `inc-${episodeId}`,
        role: "worker",
        runId: null,
        fingerprint: `fp-${episodeId}`,
        attempt: 1,
        cause: "stalled_turn",
        detail: "Worker thread vanished",
        action: "replacement",
        status: "reconciling",
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      recovery: {
        id: episodeId,
        key: `k-${episodeId}`,
        generation: 1,
        runId: null,
        agentId: null,
        status,
        summary: "",
        idleSince: null,
        incidentId: `inc-${episodeId}`,
      },
    },
  });
}

/** Bind a coordinator run that never crossed the send boundary, with its own launch line. */
function bindRepairRun(
  fixture: Awaited<ReturnType<typeof acpFixture>>,
  runId: string,
  episodeId: string,
  attempt: number,
) {
  const nowIso = new Date().toISOString();
  const run = {
    id: runId,
    taskId: fixture.taskId,
    role: "recovery",
    generation: 1,
    head: base,
    agentId: null,
    workspaceId: "ws",
    profile: fixture.engine.profiles[0]!,
    status: "intent",
    createdAt: nowIso,
    lastObservedAt: null,
    active: null,
    idleSince: null,
    completion: null,
    released: false,
  } as unknown as Run;
  fixture.store.transaction(() => {
    fixture.store.putRun(run);
    fixture.store.event(
      fixture.taskId,
      "telemetry_recovery",
      JSON.stringify({
        runId,
        targetRole: "worker",
        cause: "Worker thread vanished",
        outage: false,
        episodeId,
        attempt,
        action: "replacement",
      }),
    );
    const task = fixture.store.task(fixture.taskId);
    fixture.store.update(fixture.taskId, {
      resolution: {
        ...task.resolution,
        recovery: {
          ...task.resolution.recovery!,
          runId,
          status: "running",
        },
      },
    });
  });
  return run;
}

const settlementFacts = (fixture: Awaited<ReturnType<typeof acpFixture>>) =>
  fixture.store
    .eventsAll(fixture.taskId)
    .filter((event) => event.kind === REPAIR_ATTEMPT_SETTLED)
    .map((event) => {
      const value = JSON.parse(event.detail) as Record<string, unknown>;
      return [value.episodeId, value.attempt, value.outcome];
    });

test("a retry under the same episode that escalates before binding ends its own call, and the earlier attempt stays completed", async () => {
  const fixture = await acpFixture();
  const episode = new CoordinatorEpisode(fixture.engine.resolution);
  let session: Awaited<ReturnType<typeof heldSession>> | null = null;
  try {
    parkWithoutLiveRun(fixture, "working");
    reserveRepair(fixture, "ep-retry");
    session = await heldSession(fixture);
    await session.next(isCall("repair:ep-retry:1", "in_progress"), "attempt 1");

    // Attempt 1 binds its run, then a proved pre-send host-read refusal releases that
    // run and keeps the episode pending with no run bound: attempt 2 is reserved.
    const run = bindRepairRun(fixture, "run-retry-1", "ep-retry", 1);
    episode.releaseTransientReadCreation(
      fixture.store.task(fixture.taskId),
      run,
    );
    assert.equal(
      fixture.store.task(fixture.taskId).resolution.recovery?.runId,
      null,
    );
    await session.next(
      isCall("repair:ep-retry:1", "completed"),
      "attempt 1 settles",
    );
    await session.next(isCall("repair:ep-retry:2", "in_progress"), "attempt 2");

    // The retry escalates before any run is bound to it.
    episode.escalate(
      fixture.store.task(fixture.taskId),
      "Coordinator admission kept failing",
    );
    await session.next(
      isCall("repair:ep-retry:2", "failed"),
      "attempt 2 escalates",
    );

    assert.deepEqual(session.statuses("repair:ep-retry:1"), [
      "in_progress",
      "completed",
    ]);
    assert.deepEqual(session.statuses("repair:ep-retry:2"), [
      "in_progress",
      "failed",
    ]);
    assert.deepEqual(settlementFacts(fixture), [["ep-retry", 2, "escalated"]]);

    // A relaunched agent rebuilds the same two settled attempts.
    const rebuilt = await fixture.turn({ attach: true });
    assert.deepEqual(
      ("presentation" in rebuilt ? (rebuilt.presentation?.toolCalls ?? []) : [])
        .filter((call) => call.toolCallId.startsWith("repair:"))
        .map((call) => [call.toolCallId, call.status, call.title]),
      [
        [
          "repair:ep-retry:1",
          "completed",
          "Worker thread vanished · starting a fresh worker (1 of 3)",
        ],
        [
          "repair:ep-retry:2",
          "failed",
          // The refunded pre-send launch charged nothing, so the retry is still the
          // first charged attempt.
          "Worker thread vanished · starting a fresh worker (1 of 3)",
        ],
      ],
    );
  } finally {
    session?.child.kill();
    await fixture.close();
  }
});

test("a reservation cleared for a capacity wait ends its call beside the wait", async () => {
  const fixture = await acpFixture();
  const episode = new CoordinatorEpisode(fixture.engine.resolution);
  let session: Awaited<ReturnType<typeof heldSession>> | null = null;
  try {
    parkWithoutLiveRun(fixture, "working");
    reserveRepair(fixture, "ep-capacity", "pending");
    session = await heldSession(fixture);
    await session.next(
      isCall("repair:ep-capacity:1", "in_progress"),
      "reserved",
    );

    episode.wait(
      fixture.store.task(fixture.taskId),
      "Waiting for a coordinator slot",
      "capacity",
    );
    assert.equal(fixture.store.task(fixture.taskId).resolution.recovery, null);
    await session.next(
      isCall("repair:ep-capacity:1", "completed"),
      "the deferred reservation ends",
    );
    assert.deepEqual(session.statuses("repair:ep-capacity:1"), [
      "in_progress",
      "completed",
    ]);
    assert.deepEqual(settlementFacts(fixture), [["ep-capacity", 1, "waiting"]]);
    const rebuilt = await fixture.turn({ attach: true });
    const calls =
      "presentation" in rebuilt ? (rebuilt.presentation?.toolCalls ?? []) : [];
    assert.deepEqual(
      calls
        .filter((call) => call.toolCallId.startsWith("repair:"))
        .map((call) => [call.toolCallId, call.status]),
      [["repair:ep-capacity:1", "completed"]],
    );
    assert.ok(
      calls.some(
        (call) =>
          call.toolCallId.startsWith("activity:") &&
          call.status === "in_progress",
      ),
      "the capacity wait is its own call",
    );
  } finally {
    session?.child.kill();
    await fixture.close();
  }
});

test("every path that ends a repair attempt ends its call exactly once", async () => {
  const fixture = await acpFixture();
  const episode = new CoordinatorEpisode(fixture.engine.resolution);
  const resolution = fixture.engine.resolution;
  const task = () => fixture.store.task(fixture.taskId);
  let session: Awaited<ReturnType<typeof heldSession>> | null = null;
  const expected: Array<[string, string]> = [];
  try {
    parkWithoutLiveRun(fixture, "working");
    reserveRepair(fixture, "ep-escalate");
    session = await heldSession(fixture);
    const reserved = async (episodeId: string, status?: "pending") => {
      reserveRepair(fixture, episodeId, status);
      await session!.next(
        isCall(`repair:${episodeId}:1`, "in_progress"),
        `${episodeId} reserved`,
      );
    };
    const ends = async (toolCallId: string, status: "completed" | "failed") => {
      expected.push([toolCallId, status]);
      await session!.next(
        isCall(toolCallId, status),
        `${toolCallId} ${status}`,
      );
    };

    // Escalated before a run was bound.
    await session.next(
      isCall("repair:ep-escalate:1", "in_progress"),
      "reserved",
    );
    episode.escalate(task(), "The coordinator could not be admitted");
    await ends("repair:ep-escalate:1", "failed");

    // Cleared for an admission or capacity wait.
    await reserved("ep-wait", "pending");
    episode.wait(task(), "Waiting for a coordinator slot", "capacity");
    await ends("repair:ep-wait:1", "completed");

    // Resolved before a run was bound.
    await reserved("ep-resolve");
    resolution.update(
      task(),
      episode.settledEpisodeChanges(task(), "Settled before launch", true)!,
    );
    await ends("repair:ep-resolve:1", "completed");

    // Superseded by a newer episode.
    await reserved("ep-old");
    reserveRepair(fixture, "ep-new");
    await ends("repair:ep-old:1", "completed");
    await session.next(
      isCall("repair:ep-new:1", "in_progress"),
      "ep-new reserved",
    );

    // Bound, then released before send: the run row settles attempt 1, and the episode
    // pending again with no run reserves attempt 2.
    const released = bindRepairRun(fixture, "run-new-1", "ep-new", 1);
    episode.releaseTransientReadCreation(task(), released);
    await ends("repair:ep-new:1", "completed");
    await session.next(
      isCall("repair:ep-new:2", "in_progress"),
      "ep-new retry",
    );

    // Cleared by an owner restart.
    resolution.operatorReturn(
      task(),
      { recoveryActive: false, recovery: null, recoveryAttempts: 0 },
      {},
      "coordinator_rearmed",
      "Owner restarted coordinator recovery",
    );
    await ends("repair:ep-new:2", "completed");

    // Bound, then settled by its own authenticated report.
    await reserved("ep-bound");
    const bound = bindRepairRun(fixture, "run-bound-1", "ep-bound", 1);
    fixture.store.putRun({
      ...bound,
      agentId: "coordinator-agent",
      status: "finished",
      released: true,
      completion: {
        status: "recovered",
        headline: "Worker replaced",
        summary: "Worker replaced",
      },
    } as unknown as Run);
    await ends("repair:ep-bound:1", "completed");

    // Bound, then released with its episode resolved: one settlement, from the run.
    await reserved("ep-resolved-release");
    const resolvedRun = bindRepairRun(
      fixture,
      "run-resolved-1",
      "ep-resolved-release",
      1,
    );
    episode.releaseTransientReadCreation(task(), resolvedRun, true);
    await ends("repair:ep-resolved-release:1", "completed");

    for (const [toolCallId, status] of expected) {
      const statuses = session.statuses(toolCallId);
      assert.deepEqual(
        statuses.filter((value) => value === "completed" || value === "failed"),
        [status],
        `${toolCallId} ends exactly once`,
      );
      assert.equal(statuses.at(-1), status, `${toolCallId} stays ended`);
    }
    // Reserved attempts carry their own settlement fact; bound attempts settle with
    // their own run rows, so they add none.
    assert.deepEqual(settlementFacts(fixture), [
      ["ep-escalate", 1, "escalated"],
      ["ep-wait", 1, "waiting"],
      ["ep-resolve", 1, "resolved"],
      ["ep-old", 1, "superseded"],
      ["ep-new", 2, "cleared"],
    ]);
  } finally {
    session?.child.kill();
    await fixture.close();
  }
});

test("launches recorded before they named an episode keep their own words and charge rule", async () => {
  const fixture = await acpFixture();
  const nowIso = new Date().toISOString();
  const recoveryRun = (id: string, released: boolean) =>
    fixture.store.putRun({
      id,
      taskId: fixture.taskId,
      role: "recovery",
      generation: 1,
      head: base,
      agentId: `${id}-agent`,
      workspaceId: "ws",
      profile: fixture.engine.profiles[0]!,
      status: released ? "finished" : "running",
      createdAt: nowIso,
      lastObservedAt: nowIso,
      active: false,
      idleSince: null,
      completion: null,
      released,
    } as unknown as Run);
  // Today's main shape of a launch line: no episode id, no attempt index, no action.
  const legacyLaunch = (runId: string, cause: string, outage: boolean) =>
    fixture.store.event(
      fixture.taskId,
      "telemetry_recovery",
      JSON.stringify({
        runId,
        targetRole: "worker",
        cause,
        work: "w",
        outage,
      }),
    );
  try {
    parkWithoutLiveRun(fixture, "working");
    // A retained launch during a provider outage, then a charged one.
    recoveryRun("run-legacy-outage", true);
    legacyLaunch("run-legacy-outage", "Worker provider was unavailable", true);
    recoveryRun("run-legacy-charged", false);
    legacyLaunch("run-legacy-charged", "Worker thread vanished", false);
    const task = fixture.store.task(fixture.taskId);
    fixture.store.update(fixture.taskId, {
      resolution: {
        ...task.resolution,
        recoveryActive: true,
        recovery: {
          id: "ep-legacy",
          key: "k-legacy",
          generation: 1,
          runId: "run-legacy-charged",
          agentId: "run-legacy-charged-agent",
          status: "running",
          summary: "",
          idleSince: null,
          incidentId: null,
        },
      },
    });
    const reply = await fixture.turn({ attach: true });
    assert.deepEqual(
      ("presentation" in reply ? (reply.presentation?.toolCalls ?? []) : [])
        .filter((call) => call.toolCallId.startsWith("repair:"))
        .map((call) => [call.toolCallId, call.status, call.title]),
      [
        [
          "repair:run-legacy-outage",
          "completed",
          "Worker provider was unavailable (1 of 3)",
        ],
        [
          "repair:run-legacy-charged",
          "in_progress",
          "Worker thread vanished (1 of 3)",
        ],
      ],
      "each launch keeps its cause, and the outage launch charges nothing",
    );
  } finally {
    await fixture.close();
  }
});

test("a deferred coordinator observation is its own wait call, opened and closed per occurrence", async () => {
  const fixture = await acpFixture();
  const firstObserved = new Date(Date.now() - 60_000).toISOString();
  let session: Awaited<ReturnType<typeof heldSession>> | null = null;
  const defer = (since: string) =>
    fixture.store.event(
      fixture.taskId,
      "coordinator_observation_deferred",
      JSON.stringify({
        runId: "run-coord-deferred",
        since,
        until: new Date(Date.parse(since) + 600_000).toISOString(),
        cause: "host read timed out",
      }),
    );
  const waitCalls = () => [
    ...new Set(
      session!.updates
        .filter(
          (update) =>
            update.sessionUpdate === "tool_call" &&
            String(update.toolCallId).startsWith("activity:nucleus:"),
        )
        .map((update) => String(update.toolCallId)),
    ),
  ];
  try {
    parkWithoutLiveRun(fixture, "working");
    reserveRepair(fixture, "ep-deferred");
    const run = bindRepairRun(fixture, "run-coord-deferred", "ep-deferred", 1);
    fixture.store.putRun({
      ...run,
      agentId: "coordinator-agent",
      status: "running",
      lastObservedAt: firstObserved,
    } as unknown as Run);
    session = await heldSession(fixture);
    await session.next(
      isCall("repair:ep-deferred:1", "in_progress"),
      "the coordinator's repair call",
    );

    // The coordinator's host does not answer: Nucleus waits for it, as its own call.
    defer(firstObserved);
    const opened = await session.next(
      (update) =>
        update.sessionUpdate === "tool_call" &&
        String(update.toolCallId).startsWith("activity:nucleus:") &&
        update.status === "in_progress",
      "deferral wait",
    );
    assert.match(
      JSON.stringify(opened.content),
      /waiting for the coordinator's host to answer/i,
    );
    const first = String(opened.toolCallId);

    // A good observation ends that wait; the repair call carries on.
    const secondObserved = new Date().toISOString();
    fixture.store.putRun({
      ...fixture.store.run("run-coord-deferred")!,
      lastObservedAt: secondObserved,
    } as unknown as Run);
    await session.next(isCall(first, "completed"), "deferral wait ends");

    // A later deferral is a new occurrence and a new call, never the settled one revived.
    defer(secondObserved);
    const reopened = await session.next(
      (update) =>
        update.sessionUpdate === "tool_call" &&
        String(update.toolCallId).startsWith("activity:nucleus:") &&
        update.status === "in_progress",
      "second deferral wait",
    );
    assert.notEqual(reopened.toolCallId, first);
    // The service names each deferral by its own occurrence, so a relaunched agent
    // rebuilds the second wait under its own id too.
    const rebuilt = await fixture.turn({ attach: true });
    const rebuiltWait = (
      "presentation" in rebuilt ? (rebuilt.presentation?.toolCalls ?? []) : []
    ).find((call) => call.toolCallId.startsWith("activity:nucleus:"));
    assert.ok(rebuiltWait);
    assert.notEqual(rebuiltWait.toolCallId, first);
    assert.deepEqual(session.statuses(first), ["in_progress", "completed"]);
    assert.equal(waitCalls().length, 2);
    assert.deepEqual(
      session
        .statuses("repair:ep-deferred:1")
        .filter((status) => status !== "in_progress"),
      [],
      "the waits never settle the repair attempt",
    );
  } finally {
    session?.child.kill();
    await fixture.close();
  }
});
