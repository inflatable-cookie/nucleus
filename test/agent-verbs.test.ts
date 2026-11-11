import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Engine } from "../core/engine";
import { Store, digest } from "../core/store/store";
import { startCallbacks } from "../service/callbacks/callback";
import { plannerTicketKey } from "../core/dispatch/participant-tickets";
import { answerFixturePrompt } from "./support/delegated-reply";
import { socketFixtureDirectory } from "./support/socket-fixture";
import { base, profile } from "./support/responsible-lifecycle-fixture";
import { submissionSchema, type Run, type Task } from "../shared/contracts";
import type { Adapter } from "../core/host";
import { normalizeAskTarget, normalizeTellTarget } from "../shared/agent-verbs.mjs";
import { callerCliFixture } from "./support/caller-cli-fixture";

/**
 * Task 1108: `ask` and `tell`, the two agent verbs, on both kinds of run. The MCP
 * binding stands for a Paseo-style run; the ticket-only `nucleus ask` / `nucleus tell`
 * CLI stands for a T3-style run. Recipients are named by role, task, project or named
 * agent, and nothing a caller sends carries an agent or thread ID.
 */

type Json = Record<string, unknown>;

async function verbFixture(options: { askWaitMs?: number } = {}) {
  const dir = socketFixtureDirectory("callback.sock");
  const store = new Store(join(dir, "queue.sqlite"));
  const author = profile("author", "glm-4.7", "pi");
  const archived = new Set<string>();
  const replies: Record<string, string> = {
    origin: "Answer: Keep it\nReason: Fixture origin ruling",
    "planner-1": "Answer: Use the project\nReason: Fixture project ruling",
    "lead-1": "Answer: Ship\nReason: Fixture lead ruling",
    "sibling-origin": "Answer: Sibling answers\nReason: Fixture sibling ruling",
  };
  const asked: Array<{ planner: string; prompt: string }> = [];
  const notified: Array<{ agentId: string; messageId: string; text: string }> = [];
  const adapter = {
    hostId: "host",
    profiles: async () => [author],
    observe: async (id: string) => ({
      id, workspaceId: "ws", status: "idle", active: false, permissions: false, error: "",
      provider: "pi", model: author.model, updatedAt: "2026-11-11T10:00:00.000Z",
    }),
    originAgent: async (id: string) => ({ id, workspaceId: "ws", title: id, archived: archived.has(id) }),
    notify: async (agentId: string, messageId: string, text: string) => { notified.push({ agentId, messageId, text }); },
    archiveAgent: async () => {},
    askPlanner: async (planner: string, input: { prompt: string }) => {
      asked.push({ planner, prompt: input.prompt });
      return answerFixturePrompt(engine.resolution, planner, input.prompt, replies[planner] ?? null);
    },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [author];
  // Every thread in this fixture lives on one host, as a single daemon would report it.
  engine.identifyOriginHost = async () => "host";
  engine.resolution.worktreeValidationProbe = () => ({ state: "absent" });
  engine.resolution.delegatedAnswerWaitMs = 10;
  engine.resolution.agentAskWaitMs = options.askWaitMs ?? 10_000;
  engine.resolution.agentAskPollMs = 20;
  store.setMeta("paused", false);
  const repo = join(dir, "repo");
  const insertTask = (submissionId: string, title: string, originAgentId: string) =>
    store.insert(submissionSchema.parse({ submissionId, title, repoPath: repo, planningCommit: base,
      brief: { text: `${title} brief\n` }, originAgentId }), "host", "brief", base);
  const sender = insertTask("sender", "Sender task", "origin");
  const sibling = insertTask("sibling", "Sibling task", "sibling-origin");
  // A live worker run on the sender (the binding's run) and on the sibling (its worker is "peer").
  const liveRun = (id: string, task: Task, agentId: string) => {
    store.update(task.id, { phase: "working", runId: id, agentId, workspaceId: "ws", profile: author,
      workerModel: author.model, workerModels: [author.model] });
    store.putRun({ id, taskId: task.id, role: "revision", generation: 1, head: base, agentId, workspaceId: "ws",
      profile: author, status: "running", createdAt: new Date().toISOString(), lastObservedAt: null, active: true,
      idleSince: null, completion: null, released: false } as unknown as Run);
    store.update(task.id, { resolution: { ...store.task(task.id).resolution, currentRunId: id } });
    store.setCredential(id, `${id}-token`);
  };
  liveRun("run-1", sender, "worker");
  liveRun("run-2", sibling, "peer");
  store.upsertProject({ key: "app", name: "App", repositories: [{ origin: null, path: repo }] });
  store.setProjectPlanner({ key: "app", agentId: "planner-1", setBy: "operator" });
  const binding = join(dir, "binding.json");
  writeFileSync(binding, JSON.stringify({ socketPath: join(dir, "callback.sock"), taskId: sender.id, runId: "run-1", token: "run-1-token" }), { mode: 0o600 });
  const ticket = join(dir, "ticket.json");
  writeFileSync(ticket, JSON.stringify({ socketPath: join(dir, "callback.sock"), taskId: sender.id, runId: "run-1", token: "run-1-token" }), { mode: 0o600 });
  const stop = await startCallbacks(join(dir, "callback.sock"), join(dir, "helper.mjs"), engine);
  const client = new Client({ name: "verb-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp-report.mjs", import.meta.url)), binding],
    stderr: "pipe",
  }));
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = String((result.content as { text: string }[])[0]!.text);
    return { isError: Boolean(result.isError), text, json: result.isError ? null : JSON.parse(text) as Json };
  };
  /** The CLI helper for a ticket-only run: NUCLEUS_TICKET names the ticket, stdin carries the JSON. */
  const cli = (verb: "ask" | "tell", payload: unknown, ticketPath = ticket) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/agent-verbs.mjs", import.meta.url)), verb, "-"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: dir, NUCLEUS_TICKET: ticketPath, NUCLEUS_DATA_HOME: dir },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
  const eventsOf = (taskId: string, kind: string) => store.eventsAll(taskId).filter(event => event.kind === kind);
  return {
    dir, store, engine, adapter, sender, sibling, archived, replies, asked, notified, callTool, cli, eventsOf, ticket, binding,
    ask: (args: Record<string, unknown>) => callTool("ask", args),
    tell: (args: Record<string, unknown>) => callTool("tell", args),
    close: async () => {
      await client.close();
      await engine.stop();
      await stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("the verb targets normalise to one route each and refuse what they cannot address", () => {
  assert.deepEqual(normalizeAskTarget(undefined), { kind: "default" });
  assert.deepEqual(normalizeAskTarget("reviewer"), { kind: "reviewer" });
  assert.deepEqual(normalizeAskTarget(undefined, "planner"), { kind: "planner" });
  assert.deepEqual(normalizeAskTarget({ project: "app" }), { kind: "project", project: "app", agent: null });
  assert.deepEqual(normalizeAskTarget({ project: "app", agent: "lead" }), { kind: "project", project: "app", agent: "lead" });
  assert.deepEqual(normalizeAskTarget({ task: "effigy#590", role: "planner" }), { kind: "task", task: "effigy#590", role: "planner" });
  assert.throws(() => normalizeAskTarget("worker"), /ask goes to/);
  assert.throws(() => normalizeAskTarget({ task: "effigy#590", role: "worker" }), /tell reaches its worker or reviewer/);
  assert.throws(() => normalizeAskTarget("reviewer", "planner"), /not both/);
  assert.deepEqual(normalizeTellTarget("reviewer"), { kind: "counterpart", role: "reviewer" });
  assert.deepEqual(normalizeTellTarget("planner"), { kind: "planner" });
  assert.deepEqual(normalizeTellTarget("effigy#590", "reviewer"), { kind: "task", task: "effigy#590", role: "reviewer" });
  assert.deepEqual(normalizeTellTarget({ task: "effigy#590" }), { kind: "task", task: "effigy#590", role: "worker" });
  assert.deepEqual(normalizeTellTarget({ project: "app", agent: "lead" }), { kind: "project", project: "app", agent: "lead" });
  assert.throws(() => normalizeTellTarget(undefined), /tell requires to/);
  assert.throws(() => normalizeTellTarget("reviewer", "worker"), /already names its recipient/);
});

test("MCP run: ask to the planner ladder is answered in turn and names no planner ID", async () => {
  const f = await verbFixture();
  try {
    const receipt = await f.ask({ question: "Which API should the retry use?", to: "planner" });
    assert.equal(receipt.json?.status, "answered");
    assert.equal(receipt.json?.answeredBy, "planner origin");
    assert.deepEqual(f.asked.map(item => item.planner), ["origin"], "the task's own planner answers first");
    assert.equal(f.eventsOf(f.sender.id, "agent_ask").length, 1);
    assert.equal(receipt.text.includes("planner-1"), false, "the receipt names the answering role, not a project planner it never asked");
  } finally { await f.close(); }
});

test("MCP run: ask to the reviewer with no retained reviewer falls through to the planner ladder", async () => {
  const f = await verbFixture();
  try {
    const receipt = await f.ask({ question: "A second opinion on the gate?", to: "reviewer" });
    assert.equal(receipt.json?.status, "answered");
    assert.equal(receipt.json?.answeredBy, "planner origin");
    assert.equal(f.asked.length, 1);
  } finally { await f.close(); }
});

test("MCP run: ask to a project by key is answered by that project's fallback planner", async () => {
  const f = await verbFixture();
  try {
    const receipt = await f.ask({ question: "Which project owns this?", to: { project: "app" } });
    assert.equal(receipt.json?.status, "answered");
    assert.equal(receipt.json?.answeredBy, "planner planner-1");
    assert.deepEqual(f.asked.map(item => item.planner), ["planner-1"], "the asking task's own ladder is not asked");
    assert.deepEqual(f.eventsOf(f.sender.id, "agent_ask_delegated").map(event => event.detail.slice(event.detail.indexOf(": ") + 2)), ["project planner planner-1; asked"]);
  } finally { await f.close(); }
});

test("MCP run: ask to a named project agent is answered by that agent; an archived one is refused with its state", async () => {
  const f = await verbFixture();
  try {
    f.store.registerProjectAgent({ key: "app", name: "lead", purpose: "Coordinates the release", agentId: "lead-1", hostId: "host", registeredBy: "test" });
    const receipt = await f.ask({ question: "Ship the release?", to: { project: "app", agent: "lead" } });
    assert.equal(receipt.json?.answeredBy, "planner lead-1");
    f.archived.add("lead-1");
    const refused = await f.ask({ question: "Ship it again?", to: { project: "app", agent: "lead" } });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /archived/);
    assert.equal(f.eventsOf(f.sender.id, "agent_ask").length, 1, "a refused named agent records no ask");
    assert.deepEqual(f.asked.map(item => item.planner), ["lead-1"], "nothing was sent to the archived agent");
  } finally { await f.close(); }
});

test("MCP run: ask to another task's planner routes to that task's own ladder", async () => {
  const f = await verbFixture();
  try {
    const receipt = await f.ask({ question: "Ruling for the sibling?", to: { task: f.sibling.id, role: "planner" } });
    assert.equal(receipt.json?.answeredBy, "planner sibling-origin");
    assert.deepEqual(f.asked.map(item => item.planner), ["sibling-origin"]);
  } finally { await f.close(); }
});

test("an ask whose project fallback is archived moves on: no archived thread is asked and the skip is recorded", async () => {
  const f = await verbFixture({ askWaitMs: 1_500 });
  try {
    f.archived.add("planner-1");
    const receipt = await f.ask({ question: "Who answers now?", to: { project: "app" } });
    assert.equal(receipt.json?.status, "pending", "with no live rung and no decider the ask waits on the board");
    assert.equal(f.asked.some(item => item.planner === "planner-1"), false, "an archived planner is never sent to");
    assert.equal(f.eventsOf(f.sender.id, "agent_ask_delegation_skipped").length, 1);
  } finally { await f.close(); }
});

test("MCP run: tell to a sibling task's worker is delivered labelled with the sender's role and project", async () => {
  const f = await verbFixture();
  try {
    const receipt = await f.tell({ to: f.sibling.id, text: "Your consumer can bind the API now." });
    assert.equal(receipt.json?.status, "delivered");
    assert.equal(f.notified.length, 1);
    assert.equal(f.notified[0]!.agentId, "peer");
    assert.match(f.notified[0]!.text, /\(worker, project App\)/);
    assert.equal(f.notified[0]!.text.includes(f.sender.id), false, "the label names the task reference, never a thread or task UUID");
  } finally { await f.close(); }
});

test("MCP run: tell to the counterpart reviewer with no reviewer refuses plainly and sends nothing", async () => {
  const f = await verbFixture();
  try {
    const receipt = await f.tell({ to: "reviewer", text: "Look at the gate." });
    assert.equal(receipt.isError, true);
    assert.match(receipt.text, /has no reviewer/);
    assert.equal(f.notified.length, 0);
  } finally { await f.close(); }
});

test("MCP run: tell to planner reaches the task's live planner over the host channel", async () => {
  const f = await verbFixture();
  try {
    const receipt = await f.tell({ to: "planner", text: "The retry path is done; no ruling needed." });
    assert.equal(receipt.json?.status, "delivered");
    const planner = f.notified.filter(item => item.messageId.startsWith("ns-agent-message-"));
    assert.equal(planner.length, 1);
    assert.equal(planner[0]!.agentId, "origin");
    assert.match(planner[0]!.text, /Queue message from .*\(worker, project App\)/);
  } finally { await f.close(); }
});

test("a tell to a project with no live planner waits in its inbox, is never sent to an archived thread, and reaches the next live planner", async () => {
  const f = await verbFixture();
  try {
    f.archived.add("origin");
    f.archived.add("planner-1");
    const receipt = await f.tell({ to: { project: "app" }, text: "Need a ruling on the cache key." });
    assert.equal(receipt.json?.status, "queued");
    assert.match(String(receipt.json?.detail), /inbox/);
    await f.engine.resolution.deliverQueuedMessages();
    assert.equal(f.notified.length, 0, "the sweep does not revive an archived planner");
    const queued = f.store.queuedMessages().filter(record => record.toProjectKey === "app");
    assert.equal(queued.length, 1, "the message waits in the project inbox");
    f.archived.delete("planner-1");
    await f.engine.resolution.deliverQueuedMessages();
    assert.deepEqual(f.notified.map(item => item.agentId), ["planner-1"], "the next live planner receives it");
    assert.equal(f.store.queuedMessages().filter(record => record.toProjectKey === "app").length, 0);
  } finally { await f.close(); }
});

test("tell to a named project agent that is archived is refused with its state and never queued", async () => {
  const f = await verbFixture();
  try {
    f.store.registerProjectAgent({ key: "app", name: "lead", purpose: "Coordinates the release", agentId: "lead-1", hostId: "host", registeredBy: "test" });
    f.archived.add("lead-1");
    const receipt = await f.tell({ to: { project: "app", agent: "lead" }, text: "Heads up." });
    assert.equal(receipt.isError, true);
    assert.match(receipt.text, /archived/);
    assert.equal(f.store.queuedMessages().length, 0);
    assert.equal(f.notified.length, 0);
  } finally { await f.close(); }
});

test("a planner's ticket tells a task's worker through the CLI and the recipient sees the planner and its project", async () => {
  const f = await verbFixture();
  try {
    const participantId = randomUUID(), token = "planner-participant-token";
    const planner = f.store.projectByKey("app")!.planner!;
    f.store.setMeta(`plannerParticipantId:${participantId}`, "app");
    f.store.setMeta(plannerTicketKey("app"), { participantId, projectKey: "app", agentId: "planner-1", setAt: planner.setAt,
      hostId: "host", nativeAgentId: "planner-1", tokenHash: digest(token), path: "/unused", delivery: "self" });
    const plannerTicket = join(f.dir, "planner-ticket.json");
    writeFileSync(plannerTicket, JSON.stringify({ socketPath: join(f.dir, "callback.sock"), participantId, token }), { mode: 0o600 });
    const result = await f.cli("tell", { to: { task: f.sender.id, role: "worker" }, text: "Hold the release until I say." }, plannerTicket);
    assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout) as Json;
    assert.equal(receipt.status, "delivered");
    assert.equal(f.notified.length, 1);
    assert.match(f.notified[0]!.text, /Queue message from the app planner \(planner, project App\)/);
    // A planner answers questions with question.answer; its ticket never asks, and the refusal sends nothing.
    const asked = await f.cli("ask", { question: "Planner asking?", to: "planner" }, plannerTicket);
    assert.notEqual(asked.code, 0);
    assert.match(asked.stderr, /a planner answers a question with question\.answer/);
    assert.equal(f.eventsOf(f.sender.id, "agent_ask").length, 0);
  } finally { await f.close(); }
});

test("a run ticket asks and tells through the CLI with no MCP binding", async () => {
  const f = await verbFixture();
  try {
    const asked = await f.cli("ask", { question: "Which API should the retry use?", to: "planner" });
    assert.equal(asked.code, 0, asked.stderr);
    assert.equal((JSON.parse(asked.stdout) as Json).answeredBy, "planner origin");
    const told = await f.cli("tell", { to: f.sibling.id, text: "Bind it when ready." });
    assert.equal(told.code, 0, told.stderr);
    assert.equal((JSON.parse(told.stdout) as Json).status, "delivered");
    const tellDelivery = f.notified.filter(item => item.messageId.startsWith("ns-agent-message-"));
    assert.deepEqual(tellDelivery.map(item => item.agentId), ["peer"]);
  } finally { await f.close(); }
});

test("a Paseo planner's host identity resolves its participant ticket before nucleus tell", async () => {
  const f = await callerCliFixture();
  try {
    f.setHostParticipantTicket();
    const result = await f.invoke("host", "agent-verbs.mjs", ["tell", "-"], { to: { project: "Swallowtail" }, text: "The planner update is ready." });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true });
    assert.equal(f.hostResolutions.length, 1);
    assert.deepEqual(f.callbacks.map(call => call.path), ["/message"]);
    assert.equal(f.callbacks[0]!.input.participantId, "00000000-0000-4000-8000-000000000001");
    assert.equal(f.callbacks[0]!.input.taskId, undefined);
  } finally { await f.close(); }
});

test("an unregistered Paseo thread without a participant ticket cannot nucleus tell", async () => {
  const f = await callerCliFixture();
  try {
    const result = await f.invoke("host", "agent-verbs.mjs", ["tell", "-"], { to: { project: "Swallowtail" }, text: "Must not send." });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no participant role.*nothing was sent/);
    assert.deepEqual(f.callbacks, []);
  } finally { await f.close(); }
});

test("a caller whose run cannot be proven sends nothing, on the CLI or over MCP", async () => {
  const f = await verbFixture();
  try {
    const forged = join(f.dir, "forged.json");
    writeFileSync(forged, JSON.stringify({ socketPath: join(f.dir, "callback.sock"), taskId: f.sender.id, runId: "run-1", token: "forged-token" }), { mode: 0o600 });
    const cliResult = await f.cli("tell", { to: f.sibling.id, text: "Forged." }, forged);
    assert.notEqual(cliResult.code, 0);
    assert.equal(f.notified.length, 0);
    assert.equal(f.eventsOf(f.sender.id, "agent_message_sent").length, 0);
    const askResult = await f.cli("ask", { question: "Forged?", to: "planner" }, forged);
    assert.notEqual(askResult.code, 0);
    assert.equal(f.eventsOf(f.sender.id, "agent_ask").length, 0);
    const wrongBinding = join(f.dir, "wrong-binding.json");
    writeFileSync(wrongBinding, JSON.stringify({ socketPath: join(f.dir, "callback.sock"), taskId: f.sender.id, runId: "run-1", token: "forged-token" }), { mode: 0o600 });
    const bad = new Client({ name: "forged", version: "1" });
    await bad.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../mcp-report.mjs", import.meta.url)), wrongBinding], stderr: "pipe" }));
    const refused = await bad.callTool({ name: "tell", arguments: { to: f.sibling.id, text: "Forged over MCP." } });
    assert.equal(refused.isError, true);
    await bad.close();
    assert.equal(f.notified.length, 0);
  } finally { await f.close(); }
});

test("the old names stay as aliases with the same arguments and result", async () => {
  const f = await verbFixture();
  try {
    const ask = await f.callTool("nucleus_ask", { question: "Which API?", target: "planner" });
    assert.equal(ask.json?.answeredBy, "planner origin");
    const message = await f.callTool("nucleus_message", { to: f.sibling.id, role: "worker", text: "Alias delivery." });
    assert.equal(message.json?.status, "delivered");
  } finally { await f.close(); }
});
