import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { T3CompatibilityError } from "../hosts/t3code/contracts";
import { HOLD_MARKER } from "../hosts/t3code/nesting";
import { INBOX_UI_DEADLINE_MS, inboxTitle } from "../hosts/t3code/inbox";
import { T3DecisionCards } from "../hosts/t3code/decision-cards";
import { T3DecisionHold } from "../hosts/t3code/decision-hold";
import { T3StateFile } from "../hosts/t3code/state";
import type { T3IntentLedger } from "../hosts/t3code/intents";
import type { TestContext } from "node:test";
import type { AcpSessionSurface } from "../shared/acp/surface";
import {
  t3Fake,
  syntheticRun,
  syntheticRuntimeRequest,
  syntheticTurnItem,
} from "./support/t3code-fake";

test("one host inbox is launched once and pinned outside task retention", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "t3-inbox-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inboxDir = join(root, "inbox");
  mkdirSync(inboxDir);
  const fake = await t3Fake(t, root);
  fake.controls.providers = [
    {
      instanceId: "nucleus",
      displayName: "Nucleus",
      driver: "acpRegistry",
      enabled: true,
      status: "ready",
      models: [{ slug: "nucleus", name: "Nucleus" }],
    },
  ];
  let mints = 0;
  const acp: AcpSessionSurface = {
    bind: () => {
      throw Error("no task binding");
    },
    bindInbox: ({ hostId }) => {
      mints++;
      return {
        sessionId: "synthetic-session",
        hostId,
        directory: inboxDir,
        bindingPath: join(root, "binding"),
      };
    },
    decisionSettlement: (id) =>
      id.startsWith("1111")
        ? { state: "answered", answer: "Yes" }
        : { state: "cancelled" },
    turn: async () => {
      throw Error("not called");
    },
    message: async () => {
      throw Error("not called");
    },
    release: () => {},
  };
  let links = 0;
  const host = new T3CodeHost({
    endpoint: fake.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    probeThreadId: "synthetic-probe",
    acp: () => acp,
    boardLink: async () => {
      links++;
      return "http://127.0.0.1:1234/#token=synthetic";
    },
  });
  t.after(() => host.close());
  await host.connect();
  await host.reconcileThreadTitles([]);
  await host.reconcileThreadTitles([]);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  assert.equal(mints, 1);
  assert.equal(links, 1);
  const preview = fake.requests.filter(
    (request) => request.tag === "preview.open",
  );
  assert.equal(preview.length, 1);
  assert.deepEqual(preview[0].payload, {
    threadId: inbox.threadId,
    url: "http://127.0.0.1:1234/#token=synthetic",
    runtime: "server",
    reveal: true,
  });
  assert.equal(
    JSON.stringify(host.state.read()).includes("token=synthetic"),
    false,
  );
  assert.equal(
    fake.commands.filter(
      (command) =>
        command.method === "orchestration.launchThread" &&
        command.threadId === inbox.threadId,
    ).length,
    1,
  );
  assert.equal(
    fake.commands.filter(
      (command) =>
        command.type === "thread.pin" && command.threadId === inbox.threadId,
    ).length,
    1,
  );
  assert.ok(fake.threads.get(inbox.threadId)?.thread.pinnedAt);
  assert.equal(
    host.reads.workspaceFor(fake.threads.get(inbox.threadId)!.thread),
    inbox.workspaceId,
  );
  assert.equal(
    Object.values(host.state.read().agents).some(
      (agent) => agent.id === inbox.threadId,
    ),
    false,
  );
  const projection = fake.threads.get(inbox.threadId)!;
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  projection.runtimeRequests = ids.map((id, index) =>
    syntheticRuntimeRequest({
      id: `request-${index}`,
      nodeId: `node-${index}`,
    }),
  );
  projection.turnItems = ids.map((id, index) => ({
    id: `item-${index}`,
    nodeId: `node-${index}`,
    ordinal: index,
    type: "user_input_request",
    requestId: `request-${index}`,
    questions: [
      {
        id: `nucleus_${id}_1`,
        header: "Choice",
        question: "Choose?",
        options: [{ label: "Yes" }],
      },
    ],
  }));
  await host.decisionCards.reconcile(inbox.threadId, inbox.workspaceId, {
    hostId: host.hostId,
  });
  const responses = fake.commands.filter(
    (command) => command.type === "runtime-request.respond",
  );
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
  const inboxDir = join(root, "inbox");
  mkdirSync(inboxDir);
  const fake = await t3Fake(t, root);
  fake.controls.providers = [
    {
      instanceId: "nucleus",
      displayName: "Nucleus",
      driver: "acpRegistry",
      enabled: true,
      status: "ready",
      models: [{ slug: "nucleus", name: "Nucleus" }],
    },
  ];
  const offered: string[] = [];
  const settlement = new Map<string, "open" | "answered" | "cancelled">();
  const released: string[] = [];
  const observed: Array<{
    scope: unknown;
    cards: Array<{ id: string; version: number }> | null;
  }> = [];
  const acp: AcpSessionSurface = {
    bind: () => {
      throw Error("no task binding");
    },
    bindInbox: ({ hostId }) => ({
      sessionId: "synthetic-inbox-session",
      hostId,
      directory: inboxDir,
      bindingPath: join(root, "binding"),
    }),
    pendingInboxDecisionKey: () =>
      offered.length ? JSON.stringify(offered) : null,
    observedCards: (scope, cards) => {
      observed.push({ scope, cards });
    },
    decisionSettlement: (id) => ({
      state: settlement.get(id) ?? "open",
      answer: "Yes",
    }),
    turn: async () => {
      throw Error("not called");
    },
    message: async () => {
      throw Error("not called");
    },
    release: (sessionId, reason) => {
      released.push(`${sessionId}:${reason}`);
    },
  };
  const host = new T3CodeHost({
    endpoint: fake.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    probeThreadId: "synthetic-probe",
    acp: () => acp,
    boardLink: async () => "http://127.0.0.1:1234/#token=synthetic",
  });
  t.after(() => host.close());
  await host.connect();
  return { fake, host, offered, settlement, released, observed, root };
}

const holdPosts = (
  fake: Awaited<ReturnType<typeof t3Fake>>,
  threadId: string,
) =>
  fake.commands.filter(
    (command) =>
      command.type === "message.dispatch" &&
      command.threadId === threadId &&
      command.text === HOLD_MARKER,
  );

test("an empty inbox is released at once and is not re-entered until a decision is offered", async (t) => {
  const { fake, host, offered, released } = await idleInbox(t);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  // Nothing is offered: the sweep releases the inbox's turn and posts no re-entry.
  assert.deepEqual(released, [
    "synthetic-inbox-session:no operator decision is open for the inbox",
  ]);
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

test("the inbox is released only after its own cards are settled on T3", async (t) => {
  const { fake, host, offered, settlement, released } = await idleInbox(t);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  const id = "11111111-1111-4111-8111-111111111111";
  const projection = fake.threads.get(inbox.threadId)!;
  projection.runs = [syntheticRun(inbox.threadId, 1, { status: "running" })];
  projection.runtimeRequests = [
    syntheticRuntimeRequest({ id: "request-0", nodeId: "node-0" }),
  ];
  projection.turnItems = [
    {
      id: "item-0",
      nodeId: "node-0",
      ordinal: 0,
      type: "user_input_request",
      requestId: "request-0",
      questions: [
        {
          id: `nucleus_${id}_1`,
          header: "Choice",
          question: "Choose?",
          options: [{ label: "Yes" }],
        },
      ],
    },
  ];
  offered.push(id);
  released.length = 0;
  // The card is still open on T3 and offered: the turn stays held.
  await host.reconcileThreadTitles([]);
  assert.equal(released.length, 0);
  // Answered elsewhere: the card is settled on T3 first, then the turn is released.
  offered.length = 0;
  settlement.set(id, "answered");
  await host.reconcileThreadTitles([]);
  const responses = fake.commands.filter(
    (command) => command.type === "runtime-request.respond",
  );
  assert.deepEqual(responses.at(-1)?.answers, { [`nucleus_${id}_1`]: "Yes" });
  assert.equal(released.length, 1);
});

test("the inbox's project is named Nucleus Inbox and its registration is renamed, not replaced", async (t) => {
  const { fake, host } = await idleInbox(t);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  const projects = (await host.reads.inventory()).projects.filter(
    (project) => project.id === inbox.projectId,
  );
  assert.equal(projects.length, 1);
  assert.equal(projects[0].title, "Nucleus Inbox");
  assert.equal(
    fake.commands.filter((command) => command.type === "project.create").length,
    1,
  );
  assert.equal(
    fake.commands.filter(
      (command) =>
        command.type === "project.update" &&
        command.projectId === inbox.projectId &&
        command.title === "Nucleus Inbox",
    ).length,
    1,
  );
  // A later pass sees the readable name and sends no second rename.
  await host.reconcileThreadTitles([]);
  assert.equal(
    fake.commands.filter((command) => command.type === "project.update").length,
    1,
  );
});

test("the inbox title names decisions, then running tasks, then All quiet", () => {
  assert.equal(inboxTitle(1, 0), "1 decision to answer");
  assert.equal(inboxTitle(3, 2), "3 decisions to answer");
  assert.equal(inboxTitle(0, 1), "1 task running");
  assert.equal(inboxTitle(0, 4), "4 tasks running");
  assert.equal(inboxTitle(0, 0), "All quiet");
});

test("the inbox title follows the offered decisions, writes only on change, and returns to All quiet as a new write", async (t) => {
  const { fake, host, offered } = await idleInbox(t);
  const inbox = () => host.state.read().inbox!;
  const titleWrites = () =>
    fake.commands.filter(
      (command) =>
        command.type === "thread.metadata.update" &&
        command.threadId === inbox().threadId,
    );
  await host.reconcileThreadTitles([]);
  assert.equal(fake.threads.get(inbox().threadId)!.thread.title, "All quiet");
  assert.equal(titleWrites().length, 1);
  // An unchanged title sends nothing on the next sweep.
  await host.reconcileThreadTitles([]);
  assert.equal(titleWrites().length, 1);
  offered.push("decision-a");
  await host.reconcileThreadTitles([]);
  assert.equal(
    fake.threads.get(inbox().threadId)!.thread.title,
    "1 decision to answer",
  );
  offered.push("decision-b");
  await host.reconcileThreadTitles([]);
  assert.equal(
    fake.threads.get(inbox().threadId)!.thread.title,
    "2 decisions to answer",
  );
  offered.length = 0;
  await host.reconcileThreadTitles([]);
  // Returning to a title already written earlier is still a new write, not a replay.
  assert.equal(fake.threads.get(inbox().threadId)!.thread.title, "All quiet");
  assert.equal(titleWrites().length, 4);
});

test("a pending card older than the thread window is answered from the full transcript", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const field = `nucleus_${id}_1`;
  const pending = [
    {
      id: "request-old",
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
    },
  ];
  // The window keeps only the newest timeline suffix, so the old card's item is absent from it.
  const reads = {
    isObserved: async () => true,
    readProjection: async (_threadId: string, kind: string) =>
      kind === "transcript"
        ? {
            runs: [],
            runtimeRequests: pending,
            turnItems: [
              {
                type: "user_input_request",
                requestId: "request-old",
                runId: "run-old",
                questions: [{ id: field }],
              },
            ],
          }
        : { runs: [], runtimeRequests: pending, turnItems: [] },
  };
  const responses: unknown[] = [];
  const observed: Array<{ scope: unknown; cards: unknown }> = [];
  const cards = new T3DecisionCards({
    acp: () =>
      ({
        decisionSettlement: () => ({ state: "answered", answer: "Yes" }),
        observedCards: (scope: unknown, list: unknown) => {
          observed.push({ scope, cards: list });
        },
      }) as never,
    reads: reads as never,
    respond: async (threadId, workspaceId, requestId, response) => {
      responses.push({ threadId, workspaceId, requestId, response });
    },
  });
  const result = await cards.reconcile("thread-inbox", "workspace-inbox", {
    hostId: "t3code:synthetic",
  });
  assert.deepEqual(responses, [
    {
      threadId: "thread-inbox",
      workspaceId: "workspace-inbox",
      requestId: "request-old",
      response: { answers: { [field]: "Yes" } },
    },
  ]);
  assert.deepEqual(
    observed,
    [{ scope: { hostId: "t3code:synthetic" }, cards: [] }],
    "the settled card is recorded as absent",
  );
  assert.equal(result?.settled, true);
});

test("a card lost with its turn is settled on T3, recorded absent, and the open decision is held again", async (t) => {
  // nucleus#1395: an ended ACP turn leaves its card pending on a dead run. The sweep
  // settles it from T3's own pending requests, records that no card is present, and
  // re-enters the inbox, so the next held turn offers the still-open version again.
  const { fake, host, offered, observed, released } = await idleInbox(t);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  const id = "11111111-1111-4111-8111-111111111111";
  const field = `nucleus_${id}_1`;
  const projection = fake.threads.get(inbox.threadId)!;
  const run = syntheticRun(inbox.threadId, 1, { status: "completed" });
  projection.runs = [run];
  projection.runtimeRequests = [
    syntheticRuntimeRequest({ id: "request-0", nodeId: "node-0" }),
  ];
  projection.turnItems = [
    {
      id: "item-0",
      nodeId: "node-0",
      ordinal: 0,
      type: "user_input_request",
      requestId: "request-0",
      runId: run.id,
      questions: [
        {
          id: field,
          header: "Choice",
          question: "Choose?",
          options: [{ label: "Yes" }],
        },
      ],
    },
  ];
  offered.push(id);
  released.length = 0;
  // The first observation is unavailable. A second read in the hold path could
  // see the ended run, but re-entry must wait until the card has been reconciled.
  t.mock.method(host.reads, "isObserved", async () => false, { times: 1 });
  await host.reconcileThreadTitles([]);
  assert.deepEqual(observed.at(-1), {
    scope: { hostId: host.hostId },
    cards: null,
  });
  assert.equal(projection.runtimeRequests[0]!.status, "pending");
  assert.equal(holdPosts(fake, inbox.threadId).length, 0);
  assert.equal(released.length, 0);

  await host.reconcileThreadTitles([]);
  const responses = fake.commands.filter(
    (command) => command.type === "runtime-request.respond",
  );
  assert.equal(responses.at(-1)?.requestId, "request-0");
  assert.equal(
    responses.at(-1)?.decision,
    "cancel",
    "the card on the dead run is settled, not answered",
  );
  assert.equal(projection.runtimeRequests[0]!.status, "resolved");
  assert.deepEqual(
    observed.at(-1),
    { scope: { hostId: host.hostId }, cards: [] },
    "T3's own read shows no card for the version",
  );
  assert.equal(released.length, 0, "an open decision is never released away");
  // The decision is still open, so the sweep re-enters the inbox with its held turn.
  assert.equal(holdPosts(fake, inbox.threadId).length, 1);
});

test("the card T3 shows pending is the presence the sweep reports, and a live card blocks the re-entry", async (t) => {
  const { fake, host, offered, observed, released } = await idleInbox(t);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  const id = "22222222-2222-4222-8222-222222222222";
  const field = `nucleus_${id}_1`;
  const projection = fake.threads.get(inbox.threadId)!;
  const run = syntheticRun(inbox.threadId, 1, { status: "running" });
  projection.runs = [run];
  projection.runtimeRequests = [
    syntheticRuntimeRequest({ id: "request-live", nodeId: "node-live" }),
  ];
  projection.turnItems = [
    {
      id: "item-live",
      nodeId: "node-live",
      ordinal: 0,
      type: "user_input_request",
      requestId: "request-live",
      runId: run.id,
      questions: [
        {
          id: field,
          header: "Choice",
          question: "Choose?",
          options: [{ label: "Yes" }],
        },
      ],
    },
  ];
  offered.push(id);
  released.length = 0;
  await host.reconcileThreadTitles([]);
  assert.deepEqual(
    observed.at(-1),
    { scope: { hostId: host.hostId }, cards: [{ id, version: 1 }] },
    "the live card is the presence recorded",
  );
  assert.equal(
    fake.commands.filter(
      (command) => command.type === "runtime-request.respond",
    ).length,
    0,
    "a live card is never settled",
  );
  // A held turn is already live: no release, and no second re-entry.
  assert.equal(released.length, 0);
  assert.equal(holdPosts(fake, inbox.threadId).length, 0);
});

/**
 * Quiet completed turns after a wake: a bounded window of the default twenty rows
 * no longer holds the wake's own row, so only the transcript could show it (nucleus#1407).
 */
function quietTurns(
  projection: Record<string, any>,
  threadId: string,
  count: number,
) {
  const runId: string = projection.runs.at(-1)!.id;
  for (let i = 0; i < count; i++)
    projection.turnItems.push(
      syntheticTurnItem(threadId, projection.turnItems.length, {
        type: "assistant_message",
        runId,
      }),
    );
}

test("a settled wake outside the snapshot window does not suppress the next decision's wake (nucleus#1407)", async (t) => {
  const { fake, host, offered } = await idleInbox(t);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  const projection = fake.threads.get(inbox.threadId)!;
  // The launch turn has ended: an idle inbox is re-entered only by an offer.
  for (const run of projection.runs) run.status = "completed";
  offered.push("decision-a");
  await host.reconcileThreadTitles([]);
  assert.equal(holdPosts(fake, inbox.threadId).length, 1);
  const first = host.state.read().decisionHolds![inbox.threadId]!;
  // The first decision's turn ends, its wake is acknowledged, and quiet turns push it out of the window.
  for (const run of projection.runs) run.status = "completed";
  quietTurns(projection, inbox.threadId, 25);
  offered.length = 0;
  await host.reconcileThreadTitles([]);
  // A fresh decision is offered: the settled wake is re-entered once, with a new occurrence.
  offered.push("decision-b");
  await host.reconcileThreadTitles([]);
  const posts = holdPosts(fake, inbox.threadId);
  assert.equal(posts.length, 2, "one new wake for the offerable version");
  const second = host.state.read().decisionHolds![inbox.threadId]!;
  assert.equal(second.generation, 1);
  assert.notEqual(second.commandId, first.commandId);
  // The new occurrence is active: the next sweeps neither duplicate it nor replay the settled one.
  await host.reconcileThreadTitles([]);
  await host.reconcileThreadTitles([]);
  assert.equal(holdPosts(fake, inbox.threadId).length, 2);
});

test("an unsettled wake that landed inside the window is re-entered once, and an unknown one outside it is raised", async (t) => {
  const { fake, host, offered } = await idleInbox(t);
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  const projection = fake.threads.get(inbox.threadId)!;
  // The launch turn has ended: an idle inbox is re-entered only by an offer.
  for (const run of projection.runs) run.status = "completed";
  offered.push("decision-a");
  await host.reconcileThreadTitles([]);
  const first = host.state.read().decisionHolds![inbox.threadId]!;
  // The send timed out, but its own user message is still in the window: the outcome is exact.
  for (const run of projection.runs) run.status = "completed";
  host.state.update((state) => {
    state.intents[first.commandId]!.status = "unknown";
    state.intents[first.commandId]!.timedOut = true;
  });
  offered.length = 0;
  await host.reconcileThreadTitles([]);
  offered.push("decision-b");
  await host.reconcileThreadTitles([]);
  assert.equal(holdPosts(fake, inbox.threadId).length, 2);
  assert.equal(host.state.read().intents[first.commandId]!.status, "settled");
  // The same wake, unknown and pushed out of the window, is not resent: absence is unproven.
  const second = host.state.read().decisionHolds![inbox.threadId]!;
  for (const run of projection.runs) run.status = "completed";
  host.state.update((state) => {
    state.intents[second.commandId]!.status = "unknown";
    state.intents[second.commandId]!.timedOut = false;
  });
  quietTurns(projection, inbox.threadId, 25);
  offered.push("decision-c");
  await assert.rejects(
    host.reconcileThreadTitles([]),
    (error: unknown) =>
      error instanceof T3CompatibilityError &&
      /subscribeThread: incomplete projection/.test(error.message),
    "the unproven occurrence is raised as evidence, not silently skipped",
  );
  assert.equal(
    holdPosts(fake, inbox.threadId).length,
    2,
    "nothing is replayed",
  );
});

test("inbox ui shows the board once per operator message, replacing a retained tab and serving a queued one", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "t3-inbox-ui-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inboxDir = join(root, "inbox");
  mkdirSync(inboxDir);
  const fake = await t3Fake(t, root);
  fake.controls.providers = [
    {
      instanceId: "nucleus",
      displayName: "Nucleus",
      driver: "acpRegistry",
      enabled: true,
      status: "ready",
      models: [{ slug: "nucleus", name: "Nucleus" }],
    },
  ];
  let issuedLinks = 0;
  const acp: AcpSessionSurface = {
    bind: () => {
      throw Error("no task binding");
    },
    bindInbox: ({ hostId }) => ({
      sessionId: "synthetic-inbox-ui-session",
      hostId,
      directory: inboxDir,
      bindingPath: join(root, "binding"),
    }),
    turn: async () => {
      throw Error("not called");
    },
    message: async () => {
      throw Error("not called");
    },
    release: () => {},
  };
  const host = new T3CodeHost({
    endpoint: fake.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    probeThreadId: "synthetic-probe",
    acp: () => acp,
    boardLink: async () => {
      issuedLinks += 1;
      return `http://127.0.0.1:1234/#token=synthetic-${issuedLinks}`;
    },
  });
  t.after(() => host.close());
  await host.connect();
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  const previewOpens = () =>
    fake.requests.filter((request) => request.tag === "preview.open");
  const archiveReads = () =>
    fake.requests.filter(
      (request) => request.tag === "orchestration.getArchivedShellSnapshot",
    ).length;
  const archiveReadsBefore = archiveReads();
  fake.controls.beforeArchiveRead = () => {
    fake.controls.snapshotSequence++;
  };
  const boardTabs = () =>
    (fake.previews.get(inbox.threadId) ?? []).filter((session) =>
      String((session.navStatus as { url?: string }).url ?? "").startsWith(
        "http://127.0.0.1:1234/",
      ),
    );
  assert.equal(issuedLinks, 1);
  assert.equal(previewOpens().length, 1);

  // The operator's ui message, as the thread window carries it: its own user row and the
  // run that row started.
  const projection = fake.threads.get(inbox.threadId)!;
  const addUi = (messageId: string, status: string) => {
    const run = syntheticRun(inbox.threadId, projection.runs.length + 1, {
      status,
      userMessageId: messageId,
    });
    projection.runs.push(run);
    // The message is in the thread's messages as soon as the operator sends it: a queued
    // one is not a turn item yet, and the message is what a ui is served by.
    projection.messages.push({
      id: messageId,
      threadId: inbox.threadId,
      runId: run.id,
      role: "user",
      text: "ui",
    });
    projection.turnItems.push(
      syntheticTurnItem(inbox.threadId, projection.turnItems.length + 1, {
        type: "user_message",
        messageId,
        text: "ui",
        runId: run.id,
      }),
    );
    return run;
  };

  // A retained healthy board tab is replaced by one freshly revealed tab: the nightly
  // reveals only an open, so this is the supported way to bring the pane up again.
  const first = addUi("synthetic-ui-1", "completed");
  const retainedTab = boardTabs()[0]!.tabId;
  const opened = await host.openInboxUi();
  assert.deepEqual(opened, { status: "opened" });
  assert.equal(issuedLinks, 2);
  assert.equal(previewOpens().length, 2);
  assert.deepEqual(previewOpens()[1]!.payload, {
    threadId: inbox.threadId,
    url: "http://127.0.0.1:1234/#token=synthetic-2",
    runtime: "server",
    reveal: true,
  });
  const afterFirst = boardTabs();
  assert.equal(afterFirst.length, 1, "one board tab remains");
  assert.notEqual(afterFirst[0]!.tabId, retainedTab, "the pane is revealed");
  assert.equal(
    fake.requests.some(
      (request) =>
        request.tag === "preview.close" &&
        (request.payload as { tabId?: string }).tabId === retainedTab,
    ),
    true,
  );
  assert.deepEqual(host.state.read().inbox!.ui, {
    messageId: "synthetic-ui-1",
    at: host.state.read().inbox!.ui!.at,
    status: "opened",
  });

  // The same message is never served twice; nothing is reopened or re-minted.
  const servedAgain = await host.openInboxUi();
  assert.deepEqual(servedAgain, { status: "reused" });
  assert.equal(issuedLinks, 2);
  assert.equal(previewOpens().length, 2);

  // A new ui is a new attempt: it replaces the retained tab again.
  addUi("synthetic-ui-2", "completed");
  const second = await host.openInboxUi();
  assert.deepEqual(second, { status: "opened" });
  assert.equal(issuedLinks, 3);
  assert.equal(boardTabs().length, 1);

  // A LoadFailed board tab is closed and replaced on ui.
  const failedTab = boardTabs()[0]!;
  failedTab.navStatus = {
    _tag: "LoadFailed",
    url: "http://127.0.0.1:1234/",
    title: "",
    code: -1,
    description: "Connection refused",
  };
  addUi("synthetic-ui-3", "completed");
  const replaced = await host.openInboxUi();
  assert.deepEqual(replaced, { status: "opened" });
  assert.equal(issuedLinks, 4);
  assert.equal(
    fake.requests.some(
      (request) =>
        request.tag === "preview.close" &&
        (request.payload as { tabId?: string }).tabId === failedTab.tabId,
    ),
    true,
  );

  // While a decision holds the inbox's turn, T3 queues the operator's ui and the agent
  // never receives it: the pass serves it, from the same record, and the offer, its card
  // and the hold are untouched.
  const held = host.state.read().decisionHolds?.[inbox.threadId];
  const queuedRun = addUi("synthetic-ui-4", "queued");
  for (const run of projection.runs)
    if (run.id !== queuedRun.id) run.status = "completed";
  const linksBefore = issuedLinks;
  await host.reconcileThreadTitles([]);
  assert.equal(
    issuedLinks,
    linksBefore + 1,
    "the queued ui is served by the pass",
  );
  assert.equal(host.state.read().inbox!.ui!.messageId, "synthetic-ui-4");
  assert.equal(boardTabs().length, 1);
  // A second pass serves nothing: the message already has its attempt.
  await host.reconcileThreadTitles([]);
  assert.equal(issuedLinks, linksBefore + 1);
  // The turn that finally carries the queued prompt reports the recorded result.
  const late = await host.openInboxUi();
  assert.deepEqual(late, { status: "reused" });
  assert.equal(issuedLinks, linksBefore + 1);
  assert.equal(held, host.state.read().decisionHolds?.[inbox.threadId]);
  assert.equal(archiveReads(), archiveReadsBefore, "live ui uses the shell");

  await t.test(
    "ui refuses to open when the inbox is missing and inventory keeps moving",
    async () => {
      const opensBefore = previewOpens().length;
      projection.thread.deletedAt = new Date().toISOString();
      try {
        await assert.rejects(host.openInboxUi(), /inventory kept moving/);
        assert.ok(archiveReads() > archiveReadsBefore);
        assert.equal(previewOpens().length, opensBefore);
        assert.equal(issuedLinks, linksBefore + 1);
      } finally {
        projection.thread.deletedAt = null;
      }
    },
  );

  // Nothing about the pairing link is persisted.
  assert.equal(
    JSON.stringify(host.state.read()).includes("token=synthetic"),
    false,
  );
  await t.test(
    "preview.open gets only the budget left after closing the old tab",
    async (t) => {
      addUi("synthetic-ui-deadline", "completed");
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let elapsed = 0;
      t.mock.method(performance, "now", () => elapsed);
      const advance = (ms: number) => {
        elapsed += ms;
        t.mock.timers.tick(ms);
      };
      const call = host.rpc.call.bind(host.rpc);
      let markOpenStarted!: () => void;
      const openStarted = new Promise<void>((resolve) => {
        markOpenStarted = resolve;
      });
      let replyToOpen!: (value: unknown) => void;
      const openReply = new Promise<unknown>((resolve) => {
        replyToOpen = resolve;
      });
      let openRequests = 0;
      t.mock.method(
        host.rpc,
        "call",
        async (method: string, payload: unknown) => {
          if (method === "preview.open") {
            openRequests++;
            markOpenStarted();
            return await openReply;
          }
          const result = await call(method, payload);
          if (method === "preview.close") advance(INBOX_UI_DEADLINE_MS - 1_000);
          return result;
        },
      );
      const command = host.openInboxUi();
      await openStarted;
      advance(1_000);
      const result = await Promise.race([
        command,
        new Promise<null>((resolve) => setImmediate(() => resolve(null))),
      ]);
      assert.deepEqual(result, {
        status: "failed",
        detail: "the board did not open in time; type ui again to retry",
      });
      replyToOpen({});
      assert.deepEqual(await host.openInboxUi(), result);
      assert.equal(openRequests, 1, "the timed-out open is never replayed");
    },
  );
  void first;
});

test("decisionHold advances on a bounded long thread unless a previous hold is unknown outside the window", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "t3-hold-bounded-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = new T3StateFile(join(root, "t3code.json"));
  const threadId = "synthetic-inbox-thread";
  const sent: string[] = [];
  const intents = {
    effect: async (commandId: string) => {
      sent.push(commandId);
      state.update((draft) => {
        draft.intents[commandId] = {
          payload: "{}",
          status: "settled",
          kind: "message.dispatch",
          threadId,
        };
      });
    },
  } as unknown as T3IntentLedger;

  let windowItems: Array<{
    type: string;
    messageId?: string;
    runId?: string;
  }> = [];
  const reads = {
    isObserved: async () => true,
    readProjection: async (_id: string, kind: string) => {
      if (kind === "transcript")
        throw new T3CompatibilityError(
          "subscribeThread: incomplete projection",
        );
      return {
        thread: {
          id: threadId,
          deletedAt: null,
          archivedAt: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        runs: [syntheticRun(threadId, 1, { status: "completed" })],
        turnItems: kind === "observation" ? [] : (windowItems as unknown[]),
      };
    },
  };
  const hold = new T3DecisionHold({
    hostId: () => "synthetic-host",
    state,
    reads: reads as never,
    intents,
    wake: async () => undefined,
  });

  // Generation 0 sends cleanly on observation.
  await hold.reconcile(threadId);
  const first = state.read().decisionHolds![threadId]!;
  assert.equal(first.generation, 0);
  assert.equal(sent.length, 1);

  // Generation 1 advances when previous.messageId is visible in the bounded window.
  windowItems = [
    {
      type: "user_message",
      messageId: first.messageId,
      runId: syntheticRun(threadId, 1, { status: "completed" }).id,
    },
  ];
  await hold.reconcile(threadId);
  const second = state.read().decisionHolds![threadId]!;
  assert.equal(second.generation, 1);
  assert.equal(sent.length, 2);

  // Generation 2 advances when a settled previous hold has scrolled past a bounded window of newer turns.
  windowItems = [{ type: "user_message", messageId: "newer-ui-turn" }];
  await hold.reconcile(threadId);
  const third = state.read().decisionHolds![threadId]!;
  assert.equal(third.generation, 2);
  assert.equal(sent.length, 3);

  // If the prior send is unknown and absent from the bounded window, reconciliation refuses to guess.
  state.update((draft) => {
    draft.intents[third.commandId]!.status = "unknown";
  });
  await assert.rejects(
    hold.reconcile(threadId),
    /subscribeThread: incomplete projection/,
  );
  assert.equal(sent.length, 3);
});
