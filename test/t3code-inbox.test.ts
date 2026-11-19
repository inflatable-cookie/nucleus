import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { HOLD_MARKER } from "../hosts/t3code/nesting";
import { inboxTitle } from "../hosts/t3code/inbox";
import { T3DecisionCards } from "../hosts/t3code/decision-cards";
import type { TestContext } from "node:test";
import type { AcpSessionSurface } from "../shared/acp/surface";
import { t3Fake, syntheticRun, syntheticRuntimeRequest } from "./support/t3code-fake";

test("one host inbox is launched once and pinned outside task retention", async t => {
  const root = mkdtempSync(join(tmpdir(), "t3-inbox-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inboxDir = join(root, "inbox"); mkdirSync(inboxDir);
  const fake = await t3Fake(t, root);
  fake.controls.providers = [{ instanceId: "nucleus", displayName: "Nucleus", driver: "acpRegistry", enabled: true, status: "ready", models: [{ slug: "nucleus", name: "Nucleus" }] }];
  let mints = 0;
  const acp: AcpSessionSurface = {
    bind: () => { throw Error("no task binding"); },
    bindInbox: ({ hostId }) => { mints++; return { sessionId: "synthetic-session", hostId, directory: inboxDir, bindingPath: join(root, "binding") }; },
    decisionSettlement: id => id.startsWith("1111") ? { state: "answered", answer: "Yes" } : { state: "cancelled" },
    turn: async () => { throw Error("not called"); }, message: async () => { throw Error("not called"); }, release: () => {},
  };
  let links = 0;
  const host = new T3CodeHost({ endpoint: fake.endpoint, bearer: "synthetic-bearer", statePath: join(root, "state.json"), probeThreadId: "synthetic-probe", acp: () => acp,
    boardLink: async () => { links++; return "http://127.0.0.1:1234/#token=synthetic"; } });
  t.after(() => host.close());
  await host.connect();
  await host.reconcileThreadTitles([]);
  await host.reconcileThreadTitles([]);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  assert.equal(mints, 1);
  assert.equal(links, 1);
  const preview = fake.requests.filter(request => request.tag === "preview.open");
  assert.equal(preview.length, 1);
  assert.deepEqual(preview[0].payload, { threadId: inbox.threadId, url: "http://127.0.0.1:1234/#token=synthetic", reveal: true });
  assert.equal(JSON.stringify(host.state.read()).includes("token=synthetic"), false);
  assert.equal(fake.commands.filter(command => command.method === "orchestration.launchThread" && command.threadId === inbox.threadId).length, 1);
  assert.equal(fake.commands.filter(command => command.type === "thread.pin" && command.threadId === inbox.threadId).length, 1);
  assert.ok(fake.threads.get(inbox.threadId)?.thread.pinnedAt);
  assert.equal(host.reads.workspaceFor(fake.threads.get(inbox.threadId)!.thread), inbox.workspaceId);
  assert.equal(Object.values(host.state.read().agents).some(agent => agent.id === inbox.threadId), false);
  const projection = fake.threads.get(inbox.threadId)!;
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  projection.runtimeRequests = ids.map((id, index) => syntheticRuntimeRequest({ id: `request-${index}`, nodeId: `node-${index}` }));
  projection.turnItems = ids.map((id, index) => ({ id: `item-${index}`, nodeId: `node-${index}`, ordinal: index, type: "user_input_request", requestId: `request-${index}`,
    questions: [{ id: `nucleus_${id}_1`, header: "Choice", question: "Choose?", options: [{ label: "Yes" }] }] }));
  await host.decisionCards.reconcile(inbox.threadId, inbox.workspaceId);
  const responses = fake.commands.filter(command => command.type === "runtime-request.respond");
  assert.deepEqual(responses[0].answers, { [`nucleus_${ids[0]}_1`]: "Yes" });
  assert.equal(responses[1].decision, "cancel");
  assert.equal(projection.runtimeRequests[1].status, "resolved");
  assert.equal(projection.turnItems[1].status, "cancelled");
  // A cancelled held run re-enters under a new occurrence after each observed restart.
  for (const run of projection.runs) run.status = "cancelled";
  host.reads.forget(inbox.threadId);
  await host.decisionHold.reconcile(inbox.threadId);
  const first = host.state.read().decisionHolds![inbox.threadId];
  assert.equal(first.generation, 0);
  for (const run of projection.runs) run.status = "cancelled";
  host.reads.forget(inbox.threadId);
  await host.decisionHold.reconcile(inbox.threadId);
  const second = host.state.read().decisionHolds![inbox.threadId];
  assert.equal(second.generation, 1);
  assert.notEqual(second.commandId, first.commandId);
});

/** An inbox fixture whose offered decisions and settlement the test controls (nucleus#1384). */
async function idleInbox(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "t3-inbox-idle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inboxDir = join(root, "inbox"); mkdirSync(inboxDir);
  const fake = await t3Fake(t, root);
  fake.controls.providers = [{ instanceId: "nucleus", displayName: "Nucleus", driver: "acpRegistry", enabled: true, status: "ready", models: [{ slug: "nucleus", name: "Nucleus" }] }];
  const offered: string[] = [];
  const settlement = new Map<string, "open" | "answered" | "cancelled">();
  const released: string[] = [];
  const acp: AcpSessionSurface = {
    bind: () => { throw Error("no task binding"); },
    bindInbox: ({ hostId }) => ({ sessionId: "synthetic-inbox-session", hostId, directory: inboxDir, bindingPath: join(root, "binding") }),
    pendingInboxDecisionKey: () => offered.length ? JSON.stringify(offered) : null,
    decisionSettlement: id => ({ state: settlement.get(id) ?? "open", answer: "Yes" }),
    turn: async () => { throw Error("not called"); }, message: async () => { throw Error("not called"); },
    release: (sessionId, reason) => { released.push(`${sessionId}:${reason}`); },
  };
  const host = new T3CodeHost({ endpoint: fake.endpoint, bearer: "synthetic-bearer", statePath: join(root, "state.json"), probeThreadId: "synthetic-probe", acp: () => acp,
    boardLink: async () => "http://127.0.0.1:1234/#token=synthetic" });
  t.after(() => host.close());
  await host.connect();
  return { fake, host, offered, settlement, released, root };
}

const holdPosts = (fake: Awaited<ReturnType<typeof t3Fake>>, threadId: string) =>
  fake.commands.filter(command => command.type === "message.dispatch" && command.threadId === threadId && command.text === HOLD_MARKER);

test("an empty inbox is released at once and is not re-entered until a decision is offered", async t => {
  const { fake, host, offered, released } = await idleInbox(t);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  // Nothing is offered: the sweep releases the inbox's turn and posts no re-entry.
  assert.deepEqual(released, ["synthetic-inbox-session:no operator decision is open for the inbox"]);
  await host.reconcileThreadTitles([]);
  assert.equal(holdPosts(fake, inbox.threadId).length, 0);
  // An open decision re-enters the idle inbox once: the run is still active on the next pass.
  const projection = fake.threads.get(inbox.threadId)!;
  projection.runs = [syntheticRun(inbox.threadId, 1, { status: "completed" })];
  const releasesBeforeOffer = released.length;
  offered.push("decision-1");
  await host.reconcileThreadTitles([]);
  assert.equal(holdPosts(fake, inbox.threadId).length, 1);
  projection.runs = [syntheticRun(inbox.threadId, 2, { status: "running" })];
  await host.reconcileThreadTitles([]);
  await host.reconcileThreadTitles([]);
  assert.equal(holdPosts(fake, inbox.threadId).length, 1);
  // An offer holds the inbox: no release directive is issued while it is open.
  assert.equal(released.length, releasesBeforeOffer);
});

test("the inbox is released only after its own cards are settled on T3", async t => {
  const { fake, host, offered, settlement, released } = await idleInbox(t);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  const id = "11111111-1111-4111-8111-111111111111";
  const projection = fake.threads.get(inbox.threadId)!;
  projection.runs = [syntheticRun(inbox.threadId, 1, { status: "running" })];
  projection.runtimeRequests = [syntheticRuntimeRequest({ id: "request-0", nodeId: "node-0" })];
  projection.turnItems = [{ id: "item-0", nodeId: "node-0", ordinal: 0, type: "user_input_request", requestId: "request-0",
    questions: [{ id: `nucleus_${id}_1`, header: "Choice", question: "Choose?", options: [{ label: "Yes" }] }] }];
  offered.push(id);
  released.length = 0;
  // The card is still open on T3 and offered: the turn stays held.
  await host.reconcileThreadTitles([]);
  assert.equal(released.length, 0);
  // Answered elsewhere: the card is settled on T3 first, then the turn is released.
  offered.length = 0;
  settlement.set(id, "answered");
  await host.reconcileThreadTitles([]);
  const responses = fake.commands.filter(command => command.type === "runtime-request.respond");
  assert.deepEqual(responses.at(-1)?.answers, { [`nucleus_${id}_1`]: "Yes" });
  assert.equal(released.length, 1);
});

test("the inbox's project is named Nucleus Inbox and its registration is renamed, not replaced", async t => {
  const { fake, host } = await idleInbox(t);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  const projects = (await host.reads.inventory()).projects.filter(project => project.id === inbox.projectId);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].title, "Nucleus Inbox");
  assert.equal(fake.commands.filter(command => command.type === "project.create").length, 1);
  assert.equal(fake.commands.filter(command => command.type === "project.update" && command.projectId === inbox.projectId && command.title === "Nucleus Inbox").length, 1);
  // A later pass sees the readable name and sends no second rename.
  await host.reconcileThreadTitles([]);
  assert.equal(fake.commands.filter(command => command.type === "project.update").length, 1);
});

test("the inbox title names decisions, then running tasks, then All quiet", () => {
  assert.equal(inboxTitle(1, 0), "1 decision to answer");
  assert.equal(inboxTitle(3, 2), "3 decisions to answer");
  assert.equal(inboxTitle(0, 1), "1 task running");
  assert.equal(inboxTitle(0, 4), "4 tasks running");
  assert.equal(inboxTitle(0, 0), "All quiet");
});

test("the inbox title follows the offered decisions, writes only on change, and returns to All quiet as a new write", async t => {
  const { fake, host, offered } = await idleInbox(t);
  const inbox = () => host.state.read().inbox!;
  const titleWrites = () => fake.commands.filter(command => command.type === "thread.metadata.update" && command.threadId === inbox().threadId);
  await host.reconcileThreadTitles([]);
  assert.equal(fake.threads.get(inbox().threadId)!.thread.title, "All quiet");
  assert.equal(titleWrites().length, 1);
  // An unchanged title sends nothing on the next sweep.
  await host.reconcileThreadTitles([]);
  assert.equal(titleWrites().length, 1);
  offered.push("decision-a");
  await host.reconcileThreadTitles([]);
  assert.equal(fake.threads.get(inbox().threadId)!.thread.title, "1 decision to answer");
  offered.push("decision-b");
  await host.reconcileThreadTitles([]);
  assert.equal(fake.threads.get(inbox().threadId)!.thread.title, "2 decisions to answer");
  offered.length = 0;
  await host.reconcileThreadTitles([]);
  // Returning to a title already written earlier is still a new write, not a replay.
  assert.equal(fake.threads.get(inbox().threadId)!.thread.title, "All quiet");
  assert.equal(titleWrites().length, 4);
});

test("a pending card older than the thread window is answered from the full transcript", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const field = `nucleus_${id}_1`;
  const pending = [{ id: "request-old", kind: "user_input", status: "pending", responseCapability: { type: "message" } }];
  // The window keeps only the newest timeline suffix, so the old card's item is absent from it.
  const reads = {
    isObserved: async () => true,
    readProjection: async (_threadId: string, kind: string) => kind === "transcript"
      ? { runs: [], runtimeRequests: pending, turnItems: [{ type: "user_input_request", requestId: "request-old", runId: "run-old", questions: [{ id: field }] }] }
      : { runs: [], runtimeRequests: pending, turnItems: [] },
  };
  const responses: unknown[] = [];
  const cards = new T3DecisionCards({
    acp: () => ({ decisionSettlement: () => ({ state: "answered", answer: "Yes" }) }) as never,
    reads: reads as never,
    respond: async (threadId, workspaceId, requestId, response) => { responses.push({ threadId, workspaceId, requestId, response }); },
  });
  const result = await cards.reconcile("thread-inbox", "workspace-inbox");
  assert.deepEqual(responses, [{ threadId: "thread-inbox", workspaceId: "workspace-inbox", requestId: "request-old", response: { answers: { [field]: "Yes" } } }]);
  assert.equal(result.settled, true);
});
