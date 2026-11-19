import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../core/engine";
import { Decisions } from "../core/planning/decisions";
import { Store } from "../core/store/store";
import { startCallbacks } from "../service/callbacks/callback";
import { AcpSessions, ACP_TURN_WAIT_MAX_MS, bindAcpSession } from "../core/acp/sessions";
import { acpLifecycleLine, acpLifecycleSignature, acpTaskName } from "../core/acp/lifecycle";
import { acpBindingPath, acpSessionPath, readAcpBinding } from "../shared/acp/binding";
import { mintAcpSession, verifyAcpSession } from "../core/acp/binding";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { callbackRequest } from "../shared/service/callback-client.mjs";
import { callCatalogueMethod } from "../service/transport/dispatch";
import { decisionSchema, submissionSchema, type Run, type Task } from "../shared/contracts";
import type { Adapter } from "../core/host";
import { base, profile } from "./support/responsible-lifecycle-fixture";
import { socketFixtureDirectory } from "./support/socket-fixture";

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
  const notified: Array<{ agentId: string; messageId: string; text: string }> = [];
  const adapter = {
    hostId,
    profiles: async () => [author],
    observe: async (id: string) => ({
      id, workspaceId: "ws", status: "idle", active: false, permissions: false, error: "",
      provider: "pi", model: author.model, updatedAt: "2026-11-17T10:00:00.000Z",
    }),
    originAgent: async (id: string) => ({ id, workspaceId: "ws", title: id, archived: false }),
    notify: async (agentId: string, messageId: string, text: string) => { notified.push({ agentId, messageId, text }); },
    archiveAgent: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [author];
  engine.identifyOriginHost = async () => hostId;
  engine.resolution.worktreeValidationProbe = () => ({ state: "absent" });
  store.setMeta("paused", false);
  const task = store.insert(submissionSchema.parse({
    submissionId: "acp-fixture", title: "Synthetic ACP task", repoPath: join(dir, "repo"),
    planningCommit: base, brief: { text: "Synthetic ACP brief\n" }, originAgentId: "origin",
  }), hostId, "brief", base);
  // A live worker run: an operator message has someone to reach.
  store.update(task.id, {
    phase: "working", directory: worktree, agentId: WORKER, runId: "run-1", workspaceId: "ws",
    profile: author, workerModel: author.model, workerModels: [author.model],
  });
  store.putRun({
    id: "run-1", taskId: task.id, role: "revision", generation: 1, head: base, agentId: WORKER, workspaceId: "ws",
    profile: author, status: "running", createdAt: new Date().toISOString(), lastObservedAt: null, active: true,
    idleSince: null, completion: null, released: false,
  } as unknown as Run);
  store.update(task.id, { resolution: { ...store.task(task.id).resolution, currentRunId: "run-1" } });
  mkdirSync(worktree, { recursive: true });
  const acp = new AcpSessions(engine, { dataHome: dir, socketPath, pollMs: 50, answerDecision: input => new Decisions(store).answer(input, { trustedT3: true }) });
  // Count the turn calls so a test can wait for a held turn to reach the service.
  let turns = 0;
  const served = acp.turn.bind(acp);
  acp.turn = async (input, token) => { turns += 1; return served(input, token); };
  engine.acp = acp;
  const stop = await startCallbacks(socketPath, join(dir, "helper.mjs"), engine);
  const minted = acp.bind({ taskId: task.id });
  const binding = readAcpBinding(minted.bindingPath);
  return {
    dir, store, engine, acp, taskId: task.id, worktree, notified, minted, binding,
    token: binding.token,
    get turns(): number { return turns; },
    turn: (input: { waitMs?: number; attach?: boolean } = {}) => acp.turn({
      taskId: task.id, sessionId: minted.sessionId, waitMs: input.waitMs ?? 0, attach: input.attach,
    }, binding.token),
    sessionId: minted.sessionId,
    message: (text: string, eventId = "a".repeat(64)) => callbackRequest(binding, "/acp-message", { taskId: task.id, sessionId: minted.sessionId, eventId, text }),
    async close() { await engine.stop(); await stop(); store.close(); },
  };
}

test("bind mints an owner-only record and pointer, never puts the token in the record, and revokes the earlier token", async () => {
  const fixture = await acpFixture();
  try {
    const recordPath = acpSessionPath(fixture.dir, fixture.taskId);
    const recordText = readFileSync(recordPath, "utf8");
    assert.equal(statSync(recordPath).mode & 0o777, 0o600, "the session record is owner-only");
    assert.equal(statSync(fixture.minted.bindingPath).mode & 0o777, 0o600, "the binding pointer is owner-only");
    assert.equal(recordText.includes(fixture.token), false, "the authority record stores only the token's hash");
    assert.equal(fixture.minted.bindingPath, acpBindingPath(fixture.dir, fixture.worktree), "the pointer is keyed by the task's checkout");

    const again = fixture.acp.bind({ taskId: fixture.taskId });
    assert.notEqual(again.sessionId, fixture.minted.sessionId);
    assert.throws(() => verifyAcpSession({ dataHome: fixture.dir, taskId: fixture.taskId, sessionId: fixture.minted.sessionId }, fixture.token),
      /Unauthorized callback/, "minting again revokes the session it replaced");
    assert.equal(verifyAcpSession({ dataHome: fixture.dir, taskId: fixture.taskId, sessionId: again.sessionId }, readAcpBinding(again.bindingPath).token).taskId, fixture.taskId);
  } finally { await fixture.close(); }
});

test("a host adapter's mint names the prompt rules its launched agent reads", async () => {
  const fixture = await acpFixture();
  try {
    // The T3 adapter mints with its own two rules (nucleus#1305): an ignore pattern for
    // the host's wake text and a hold pattern for its re-entry. Both ride the binding
    // pointer, which is why the agent needs no host knowledge and parses no remote text.
    const minted = fixture.acp.bind({ taskId: fixture.taskId,
      ignorePattern: 'Delegated task node:delegated-task:',
      holdPattern: 'nucleus-hold-the-task-thread' });
    const binding = readAcpBinding(minted.bindingPath);
    assert.equal(binding.ignorePattern, 'Delegated task node:delegated-task:');
    assert.equal(binding.holdPattern, 'nucleus-hold-the-task-thread');
    assert.ok("taskId" in binding);
    assert.equal(binding.taskId, fixture.taskId);
    // A mint without rules writes neither field: a host that has no such text is not
    // given a rule it never asked for.
    const plain = fixture.acp.bind({ taskId: fixture.taskId });
    const pointer = readAcpBinding(plain.bindingPath);
    assert.equal(pointer.ignorePattern, undefined);
    assert.equal(pointer.holdPattern, undefined);
    assert.equal(JSON.stringify(pointer).includes('nucleus-hold-the-task-thread'), false);
  } finally { await fixture.close(); }
});

test("acp.bind is a catalogue method whose answer carries no credential", async () => {
  const fixture = await acpFixture();
  try {
    // The served owner is the runtime (test/catalogue.test.ts proves `bindAcpSession`
    // exists there); this is that handler's one body, reached through the catalogue's
    // input and output contracts.
    const owner = { bindAcpSession: (input: { taskId: string }) => bindAcpSession(fixture.engine.acp, input) };
    const answer = await callCatalogueMethod(owner, "acp.bind", { taskId: fixture.taskId }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(answer).sort(), ["bindingPath", "sessionId", "taskId"]);
    assert.equal(String(answer.bindingPath).includes("token"), false);
    assert.equal(JSON.stringify(answer).includes(readAcpBinding(String(answer.bindingPath)).token), false, "no credential is returned over the wire");
    await assert.rejects(() => callCatalogueMethod(owner, "acp.bind", { taskId: "no-such-task", extra: true }), /unrecognized key|Unrecognized/i);
    await assert.rejects(() => callCatalogueMethod(owner, "acp.bind", { taskId: "no-such-task" }), /Task not found/);
  } finally { await fixture.close(); }
});

test("a bind refuses a task without a checkout, a removed task, and a process that serves no ACP sessions", async () => {
  const fixture = await acpFixture();
  try {
    const bare = fixture.store.insert(submissionSchema.parse({
      submissionId: "acp-no-worktree", title: "No checkout", repoPath: join(fixture.dir, "repo2"),
      planningCommit: base, brief: { text: "Synthetic brief\n" }, originAgentId: "origin",
    }), "host", "brief", base);
    assert.equal(bare.directory, null);
    assert.throws(() => fixture.acp.bind({ taskId: bare.id }), /has no workspace checkout yet/);
    fixture.store.update(fixture.taskId, { removedAt: new Date().toISOString() });
    assert.throws(() => fixture.acp.bind({ taskId: fixture.taskId }), /was removed/);
    assert.throws(() => bindAcpSession(null, { taskId: fixture.taskId }), /does not serve ACP sessions/,
      "a process that serves no ACP sessions mints nothing");
  } finally { await fixture.close(); }
});

test("a held turn answers with the lifecycle line once, stays quiet, then releases a finished task", async () => {
  const fixture = await acpFixture();
  try {
    const first = await fixture.turn();
    assert.equal(first.state, "hold");
    assert.deepEqual(first.messages, [acpLifecycleLine(fixture.store.task(fixture.taskId))]);
    assert.match(first.messages[0]!, /Working/);
    assert.ok("task" in first);
    assert.match(String(first.task.reference), /#/, "the line is named by the task's durable reference");
    const quiet = await fixture.turn();
    assert.deepEqual(quiet.messages, [], "a held poll on an unchanged task says nothing");
    fixture.store.update(fixture.taskId, { phase: "awaiting_review" });
    const changed = await fixture.turn();
    assert.equal(changed.messages.length, 1);
    assert.match(changed.messages[0]!, /Review/);
    fixture.store.update(fixture.taskId, { phase: "done", finishedAt: new Date().toISOString() });
    const finished = await fixture.turn();
    assert.equal(finished.state, "release");
    assert.match(finished.messages[0]!, /finished/);
    assert.match(finished.reason, /done/);
  } finally { await fixture.close(); }
});

test("an attach shows the current lifecycle line even though this service already showed it", async () => {
  // The T3 restart path: the agent process dies while the service keeps running, so the
  // service still holds this session's shown signature. `session/load` attaches again and
  // must show where the task stands.
  const fixture = await acpFixture();
  try {
    assert.equal((await fixture.turn()).messages.length, 1, "session/new attaches with the line");
    assert.deepEqual((await fixture.turn()).messages, [], "a held poll after that adds nothing");
    const reattached = await fixture.turn({ attach: true });
    assert.equal(reattached.messages.length, 1, "the relaunched agent's attach still gets the line");
    assert.equal(reattached.messages[0], acpLifecycleLine(fixture.store.task(fixture.taskId)));
    fixture.store.update(fixture.taskId, { phase: "awaiting_review" });
    const changed = await fixture.turn({ attach: true });
    assert.equal(changed.messages.length, 1);
    assert.match(changed.messages[0]!, /Review/);
    fixture.store.update(fixture.taskId, { phase: "done", finishedAt: new Date().toISOString() });
    const finished = await fixture.turn({ attach: true });
    assert.equal(finished.state, "release");
    assert.match(finished.messages[0]!, /finished/);
  } finally { await fixture.close(); }
});

test("milestone lines: same-state writes send nothing, the PR link and the reference show once", async () => {
  const fixture = await acpFixture();
  try {
    assert.equal((await fixture.turn()).messages.length, 1, "the opening line names the task");
    fixture.store.update(fixture.taskId, { phase: "working" });
    assert.deepEqual((await fixture.turn()).messages, [], "a same-state write sends no line");
    fixture.store.update(fixture.taskId, { phase: "awaiting_review", prUrl: "https://example.test/pull/276" });
    const review = await fixture.turn();
    assert.deepEqual(review.messages, ["Review · https://example.test/pull/276"], "the reference is not repeated and the link appears once");
    fixture.store.update(fixture.taskId, { phase: "reviewing" });
    const reviewing = await fixture.turn();
    assert.deepEqual(reviewing.messages, ["Reviewing · PR #276"], "a later milestone refers to the PR by number");
    fixture.store.update(fixture.taskId, { phase: "reviewing" });
    assert.deepEqual((await fixture.turn()).messages, [], "a later write with the same state repeats nothing");
    const reattached = await fixture.turn({ attach: true });
    assert.deepEqual(reattached.messages, [acpLifecycleLine(fixture.store.task(fixture.taskId))], "a reattached session shows the whole line");
    assert.match(reattached.messages[0]!, /https:\/\/example\.test\/pull\/276$/);
  } finally { await fixture.close(); }
});

test("a long poll holds until the task changes, then answers with the change", async () => {
  const fixture = await acpFixture();
  try {
    await fixture.turn();
    const waiting = fixture.turn({ waitMs: 2_000 });
    // The change lands while the turn is waiting, exactly as a run completing would.
    setTimeout(() => fixture.store.update(fixture.taskId, { phase: "awaiting_review" }), 50);
    const answer = await waiting;
    assert.equal(answer.state, "hold");
    assert.equal(answer.messages.length, 1);
    assert.match(answer.messages[0]!, /Review/);
  } finally { await fixture.close(); }
});

test("a host adapter's release ends the held turn with its reason, and the next turn holds again", async () => {
  const fixture = await acpFixture();
  try {
    await fixture.turn();
    const waiting = fixture.turn({ waitMs: 5_000 });
    setTimeout(() => fixture.acp.release(fixture.minted.sessionId, "no role thread is active"), 20);
    const released = await waiting;
    assert.equal(released.state, "release");
    assert.equal(released.reason, "no role thread is active");
    const after = await fixture.turn();
    assert.equal(after.state, "hold", "the directive is consumed by the turn that acted on it");
  } finally { await fixture.close(); }
});

test("the operator's message is recorded from the operator and delivered to the live worker", async () => {
  const fixture = await acpFixture();
  try {
    const answer = await fixture.message("please re-run the failing test") as { receipt: { status: string; messageId: string } };
    assert.equal(answer.receipt.status, "delivered");
    assert.equal(fixture.notified.length, 1, "the live worker thread received it once");
    assert.match(fixture.notified[0]!.text, /Queue message from the operator:/);
    assert.match(fixture.notified[0]!.text, /please re-run the failing test/);
    const record = fixture.store.messages(fixture.taskId).find(message => message.id === answer.receipt.messageId)!;
    assert.equal(record.fromRole, "operator");
    assert.equal(record.toRole, "worker");
    assert.equal(record.text, "please re-run the failing test");
    const replay = await fixture.message("please re-run the failing test") as { receipt: { status: string; messageId: string } };
    assert.equal(replay.receipt.status, "delivered", "the identical event id replays its recorded receipt");
    assert.equal(replay.receipt.messageId, answer.receipt.messageId);
    const duplicate = await fixture.message("please re-run the failing test", "b".repeat(64)) as { receipt: { status: string } };
    assert.equal(duplicate.receipt.status, "duplicate", "the same text under a new event id is not delivered twice");
    assert.equal(fixture.notified.length, 1);
  } finally { await fixture.close(); }
});

test("a session credential, a session id and a finished task are each refused where they belong", async () => {
  const fixture = await acpFixture();
  try {
    const wrongToken = { ...fixture.binding, token: "not-the-token" };
    await assert.rejects(() => callbackRequest(wrongToken, "/acp-turn", { taskId: fixture.taskId, sessionId: fixture.minted.sessionId, waitMs: 0 }),
      error => (error as { callbackStatus?: number }).callbackStatus === 401);
    await assert.rejects(() => callbackRequest(fixture.binding, "/acp-turn", { taskId: fixture.taskId, sessionId: "5b1d4e1a-0000-4000-8000-000000000000", waitMs: 0 }),
      error => (error as { callbackStatus?: number }).callbackStatus === 401);
    await assert.rejects(() => callbackRequest(fixture.binding, "/acp-turn", { taskId: fixture.taskId, sessionId: fixture.minted.sessionId, waitMs: ACP_TURN_WAIT_MAX_MS + 1 }),
      error => (error as { callbackStatus?: number }).callbackStatus === 409, "a wait past the service's bound is a schema refusal");
    fixture.store.update(fixture.taskId, { phase: "done", finishedAt: new Date().toISOString() });
    await assert.rejects(() => fixture.message("too late"), /finished task cannot receive messages/);
  } finally { await fixture.close(); }
});

test("a process without the ACP surface refuses the routes instead of answering an empty turn", async () => {
  const fixture = await acpFixture();
  try {
    fixture.engine.acp = null;
    await assert.rejects(() => callbackRequest(fixture.binding, "/acp-turn", { taskId: fixture.taskId, sessionId: fixture.minted.sessionId, waitMs: 0 }), /does not serve ACP sessions/);
  } finally { await fixture.close(); }
});

test("lifecycle text is one bounded line and its signature names every fact it shows", () => {
  const task = {
    id: "task-1", reference: "nucleus#1304", number: 1304, title: "A task", phase: "working",
    held: false, prUrl: null, prHead: null, version: 3,
  } as unknown as Task;
  assert.equal(acpTaskName(task), "nucleus#1304");
  assert.match(acpLifecycleLine(task), /^nucleus#1304 · Working$/);
  const withPr = { ...task, prUrl: "https://example.test/pr/1", prHead: "a".repeat(40) } as unknown as Task;
  assert.match(acpLifecycleLine(withPr), /https:\/\/example\.test\/pr\/1/);
  assert.notEqual(acpLifecycleSignature(task), acpLifecycleSignature(withPr));
  // A write that changes nothing the operator reads (a version bump, the same phase) keeps the signature.
  assert.equal(acpLifecycleSignature(task), acpLifecycleSignature({ ...task, version: 4 } as unknown as Task));
  assert.equal(acpLifecycleSignature({ ...task, prHead: "b".repeat(40) } as unknown as Task), acpLifecycleSignature(task));
  assert.equal(acpTaskName({ ...task, reference: null, number: 12 } as unknown as Task), "task 12");
});

test("a minted session outlives the service process that made it", () => {
  // The record is the authority and the pointer is derived from the checkout, so a
  // restarted service (a new AcpSessions instance) verifies the same files.
  const dir = socketFixtureDirectory("callback.sock");
  const minted = mintAcpSession({ dataHome: dir, socketPath: join(dir, "callback.sock"), taskId: "task-restart", directory: join(dir, "work") });
  const binding = readAcpBinding(minted.bindingPath);
  assert.equal(verifyAcpSession({ dataHome: dir, taskId: "task-restart", sessionId: minted.sessionId }, binding.token).sessionId, minted.sessionId);
  assert.equal(readAcpBinding(acpBindingPath(dir, join(dir, "work"))).sessionId, minted.sessionId);
  assert.throws(() => verifyAcpSession({ dataHome: dir, taskId: "another-task", sessionId: minted.sessionId }, binding.token), /Unauthorized callback/);
});

/** One line-addressed reader over a child's stdout, as ACP clients read it. */
function childLines(stream: NodeJS.ReadableStream, diagnostics: () => string = () => "") {
  const queued: Array<Record<string, unknown>> = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(message); else queued.push(message);
    }
  });
  return {
    next(): Promise<Record<string, unknown>> {
      const ready = queued.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the agent process wrote nothing in time; stderr: ${diagnostics()}`)), 20_000);
        timer.unref?.();
        waiters.push(message => { clearTimeout(timer); resolve(message); });
      });
    },
    async untilId(id: number): Promise<{ updates: Array<Record<string, unknown>>; answer: Record<string, unknown> }> {
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
  const child = spawn(process.execPath, ["--import", tsx, fileURLToPath(new URL("../bin/nucleus-acp.mjs", import.meta.url))], {
    cwd: fixture.worktree,
    env: { PATH: process.env.PATH ?? "", HOME: fixture.dir, TMPDIR: fixture.dir, NUCLEUS_DATA_HOME: fixture.dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.on("error", error => { stderr += `\n[agent failed to start] ${String(error)}`; });
  child.on("exit", (code, signal) => { if (code !== 0) stderr += `\n[agent exited ${code ?? signal}]`; });
  const lines = childLines(child.stdout, () => stderr);
  const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    child, lines, write,
    stderr: () => stderr,
    /** Close the client's stdio and report the agent process's own exit code. */
    async close(): Promise<number | null> {
      child.stdin.end();
      return new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
    },
  };
}

test("the launcher speaks ACP on stdio to the real service: bind, hold, release, operator text", async () => {
  const fixture = await acpFixture();
  const agent = launchAgent(fixture);
  const { child, lines, write } = agent;
  const settle = async (id: number) => {
    const answer = await lines.untilId(id);
    assert.equal((answer.answer.result as Record<string, unknown>).stopReason, "end_turn", `request ${id}: ${agent.stderr()}`);
  };
  try {
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    const initialized = await lines.untilId(1);
    assert.equal((initialized.answer.result as Record<string, unknown>).protocolVersion, 1);

    write({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: fixture.worktree, mcpServers: [] } });
    const opened = await lines.untilId(2);
    assert.equal((opened.answer.result as Record<string, unknown>).sessionId, fixture.sessionId, "the launcher found the binding minted for this checkout");

    // The thread's opening prompt holds; the service releases it.
    write({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: fixture.sessionId, prompt: [{ type: "text", text: "opening prompt" }] } });
    await until(() => fixture.turns > 0);
    fixture.acp.release(fixture.sessionId, "the opening turn is done");
    await settle(3);
    assert.equal(fixture.notified.length, 0, "the thread's opening prompt is not the operator speaking");

    // The operator's next message is forwarded, and the turn holds until the service releases it.
    write({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: fixture.sessionId, prompt: [{ type: "text", text: "what is the CI saying?" }] } });
    await until(() => fixture.notified.length === 1);
    assert.match(fixture.notified[0]!.text, /what is the CI saying\?/);
    fixture.acp.release(fixture.sessionId, "the operator turn is done");
    await settle(4);

    const exit = await agent.close();
    assert.equal(exit, 0, `the agent exits cleanly when its client closes stdio: ${agent.stderr()}`);
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
    first.write({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: fixture.worktree, mcpServers: [] } });
    const opened = await first.lines.untilId(1);
    assert.equal((opened.answer.result as Record<string, unknown>).sessionId, fixture.sessionId);
    assert.equal(await first.close(), 0, `the first agent exits cleanly: ${first.stderr()}`);

    const second = launchAgent(fixture);
    try {
      second.write({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: fixture.sessionId, cwd: fixture.worktree, mcpServers: [] } });
      const loaded = await second.lines.untilId(1);
      assert.equal((loaded.answer.result as Record<string, unknown>).sessionId, fixture.sessionId);
      const update = await second.lines.next();
      assert.equal(update.method, "session/update");
      assert.match(JSON.stringify(update), /Working/, "the reloaded thread shows where the task stands");
      assert.equal(await second.close(), 0, `the second agent exits cleanly: ${second.stderr()}`);
    } finally { second.child.kill(); }
  } finally {
    first.child.kill();
    await fixture.close();
  }
});

/** Wait for a fixture fact another process produces; `until` never silently passes on a timeout. */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  for (const started = Date.now(); !predicate();) {
    if (Date.now() - started > timeoutMs) throw new Error("the fixture fact did not arrive in time");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("an inbox session can hold its own turn but cannot use a task's message authority", async () => {
  const fixture = await acpFixture();
  try {
    const inbox = fixture.acp.bindInbox({ hostId: "t3code:synthetic" });
    const binding = readAcpBinding(inbox.bindingPath);
    assert.ok("kind" in binding && binding.kind === "inbox");
    const reply = await callbackRequest(binding, "/acp-turn", { kind: "inbox", hostId: inbox.hostId, sessionId: inbox.sessionId, waitMs: 0 });
    assert.deepEqual(reply, { kind: "inbox", hostId: inbox.hostId, state: "hold", reason: "the inbox is open", messages: [], elicitations: [] });
    await assert.rejects(() => callbackRequest(binding, "/acp-message", { taskId: fixture.taskId, sessionId: fixture.sessionId, eventId: "a".repeat(64), text: "synthetic" }), /Unauthorized callback/);
    await assert.rejects(() => callbackRequest(binding, "/acp-turn", { kind: "inbox", hostId: "t3code:other", sessionId: inbox.sessionId, waitMs: 0 }), /Unauthorized callback/);
  } finally { await fixture.close(); }
});


test("task and inbox cards have distinct scopes and a versioned operator answer", async () => {
  const fixture = await acpFixture("t3code:synthetic");
  try {
    const stamp = new Date().toISOString();
    const decision = (id: string, tasks: string[]) => decisionSchema.parse({ id, version: 1, question: `Question ${id}?`,
      choices: [{ label: "Yes", consequence: "Proceed" }, { label: "No", consequence: "Hold" }],
      askedBy: { agentId: "synthetic" }, links: { tasks }, status: "open", createdAt: stamp, updatedAt: stamp });
    fixture.store.addDecision(decision("task-question", [fixture.taskId]));
    fixture.store.addDecision(decision("inbox-question", []));
    const task = await fixture.turn({ attach: true });
    assert.deepEqual(task.elicitations?.map(row => row.id), ["task-question"]);
    const inbox = fixture.acp.bindInbox({ hostId: "t3code:synthetic" });
    const binding = readAcpBinding(inbox.bindingPath);
    const caller = { kind: "inbox" as const, hostId: inbox.hostId, sessionId: inbox.sessionId };
    assert.throws(() => new Decisions(fixture.store).answer({ id: "inbox-question", version: 1, answer: "Yes", answeredBy: "operator (t3code:synthetic)", relayed: false, note: "" }), /authenticated T3 session/);
    const offered = await fixture.acp.turn({ ...caller, attach: true }, binding.token);
    assert.deepEqual(offered.elicitations?.map(row => row.id), ["inbox-question"]);
    await assert.rejects(() => fixture.acp.answer({ ...caller, id: "task-question", version: 1, action: "accept", answer: "Yes" }, binding.token), /not offered/);
    await fixture.acp.answer({ ...caller, id: "inbox-question", version: 1, action: "accept", answer: "Yes" }, binding.token);
    const recorded = fixture.store.decision("inbox-question");
    assert.equal(recorded.answer?.answeredBy, "operator (t3code:synthetic)");
    assert.equal(recorded.answer?.relayed, null);
    assert.deepEqual(fixture.acp.decisionSettlement("inbox-question", 1), { state: "answered", answer: "Yes" });
    assert.deepEqual(fixture.acp.decisionSettlement("inbox-question", 2), { state: "cancelled" });
    assert.deepEqual(await fixture.acp.answer({ ...caller, id: "inbox-question", version: 1, action: "accept", answer: "Yes" }, binding.token), { recorded: false });
    fixture.store.addDecision(decision("cancel-question", []));
    const cancel = { ...caller, id: "cancel-question", version: 1, action: "cancel" as const, requestId: "card-1" };
    await fixture.acp.answer(cancel, binding.token);
    await fixture.acp.answer(cancel, binding.token); // The same delivery cannot consume the retry twice.
    assert.deepEqual((await fixture.acp.turn({ ...caller, attach: true }, binding.token)).elicitations?.map(row => row.id), ["cancel-question"]);
    await fixture.acp.answer({ ...cancel, requestId: "card-2" }, binding.token);
    assert.deepEqual((await fixture.acp.turn({ ...caller, attach: true }, binding.token)).elicitations, []);
    assert.equal(fixture.store.decision("cancel-question").status, "open");
  } finally { await fixture.close(); }
});
