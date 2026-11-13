import { answerFixturePrompt } from "./support/delegated-reply";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, realpathSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { socketFixtureDirectory } from "./support/socket-fixture";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Engine } from "../core/engine";
import { Store, digest } from "../core/store/store";
import { Decisions } from "../core/planning/decisions";
import { startCallbacks } from "../service/callbacks/callback";
import { agentAskId, askQuestionRefusal, queueAskDeliveryId } from "../core/questions/agent-ask";
import { reviewerAskPrompt } from "../core/questions/blocker-ladder";
import { submissionSchema, type Profile, type Run } from "../shared/contracts";
import type { Adapter } from "../core/host";
import {
  fixture as lifecycleFixture,
  head,
  base,
  profile,
} from "./support/responsible-lifecycle-fixture";

/**
 * Spec 058 (task 550): `nucleus_ask` on the per-run MCP binding. A pi-shaped
 * fake agent asks through the real transport and gets an answer in turn — from
 * the project planner for delegated kinds, from a board decision for the
 * operator-only ones — with a clear bounded timeout result. Queue-raised
 * questions on providers without a native question surface travel the same path.
 */

/** A responsible task with one live revision run, its binding ticket, the real callback socket and a real MCP client. */
async function askFixture(
  options: {
    responsible?: boolean;
    planner?: string | null;
    decider?: string | null;
    waitMs?: number;
    initialRun?: boolean;
  } = {},
) {
  const dir = socketFixtureDirectory("callback.sock");
  const store = new Store(join(dir, "queue.sqlite"));
  const author = profile("author", "glm-4.7", "pi");
  const delegated = {
    planner: [] as string[],
    sources: [] as Array<string | undefined>,
    deciders: [] as { prompt: string; profile: string }[],
    archived: [] as string[],
  };
  const adapter = {
    profiles: async () => [author],
    observe: async () => ({
      id: "worker",
      workspaceId: "ws",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
      provider: "pi",
      model: author.model,
    }),
    archiveAgent: async (id: string) => {
      delegated.archived.push(id);
    },
    notify: async () => {},
    askPlanner: async (_planner: string, input: { prompt: string; sourceAgentId?: string }) => {
      if (_planner === 'decider-1') delegated.deciders.at(-1)!.prompt = input.prompt;
      if (_planner === 'decider-1') return answerFixturePrompt(engine.resolution, _planner, input.prompt, options.decider ?? null);
      delegated.planner.push(input.prompt);
      delegated.sources.push(input.sourceAgentId);
      return answerFixturePrompt(engine.resolution, _planner, input.prompt, options.planner ?? null);
    },
    runDecider: async (
      _task: unknown,
      input: { profile: Profile },
    ) => {
      delegated.deciders.push({
        prompt: "",
        profile: input.profile.id,
      });
      return { agentId: "decider-1", text: null };
    },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  store.setMeta('hostId', 'host');
  engine.profiles = [author];
  engine.resolution.delegatedAnswerWaitMs = options.planner ? 30_000 : 10;
  engine.resolution.worktreeValidationProbe = () => ({ state: "absent" });
  if (options.waitMs !== undefined) {
    engine.resolution.agentAskWaitMs = options.waitMs;
    engine.resolution.agentAskPollMs = 20;
  }
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Ask fixture",
      repoPath: join(dir, "repo"),
      planningCommit: base,
      brief: { text: "Ask fixture brief\n" },
      originAgentId: "origin",
      ...(options.responsible === undefined
        ? {}
        : { responsible: options.responsible }),
    }),
    "host",
    "brief",
    base,
  );
  // Task 561: the initial worker lives on the task row, never as a run, so the
  // fixture can bind the MCP session to that task-row run with no run row.
  const bindingRunId = options.initialRun ? "initial-run" : "run-1";
  store.update(task.id, {
    phase: "working",
    runId: bindingRunId,
    agentId: "worker",
    workspaceId: "ws",
    profile: author,
    workerModel: author.model,
    workerModels: [author.model],
  });
  if (!options.initialRun) {
    store.putRun({
      id: "run-1",
      taskId: task.id,
      role: "revision",
      generation: 1,
      head,
      agentId: "worker",
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
    // A dispatched run is the task's current run; the ask shares report's
    // current-run identity gate.
    store.update(task.id, {
      resolution: {
        ...store.task(task.id).resolution,
        currentRunId: "run-1",
      },
    });
  }
  store.setCredential(bindingRunId, "ask-token");
  const socket = join(dir, "callback.sock"),
    binding = join(dir, "binding.json");
  writeFileSync(
    binding,
    JSON.stringify({
      socketPath: socket,
      taskId: task.id,
      runId: bindingRunId,
      token: "ask-token",
    }),
    { mode: 0o600 },
  );
  const stop = await startCallbacks(socket, join(dir, "helper.mjs"), engine);
  const client = new Client({ name: "ask-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../mcp-report.mjs", import.meta.url)),
        binding,
      ],
      stderr: "pipe",
    }),
  );
  const events = (kind: string) =>
    store.eventsAll(task.id).filter((event) => event.kind === kind);
  const ask = async (args: Record<string, unknown>) =>
    await client.callTool({ name: "nucleus_ask", arguments: args });
  const receipt = async (args: Record<string, unknown>) => {
    const result = await ask(args);
    assert.ok(
      !result.isError,
      String((result.content as { text: string }[])?.[0]?.text),
    );
    return JSON.parse(
      String((result.content as { text: string }[])[0].text),
    ) as {
      status: string;
      answer?: string;
      answeredBy?: string;
      askId: string;
      detail?: string;
    };
  };
  return {
    dir,
    store,
    engine,
    client,
    task,
    events,
    ask,
    receipt,
    delegated,
    author,
    options,
    close: async () => {
      await client.close();
      await engine.stop();
      await stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A project whose planner thread answers delegated questions with the given reply. */
function registerPlanner(
  f: Awaited<ReturnType<typeof askFixture>> & {
    options: { planner?: string | null };
  },
  answer: string | null,
): void {
  f.store.upsertProject({
    key: "app",
    name: "App",
    repositories: [{ origin: null, path: join(f.dir, "repo") }],
  });
  f.store.setProjectPlanner({
    key: "app",
    agentId: "planner-1",
    setBy: "operator",
  });
  f.options.planner = answer;
}

function eligibleDecider(f: Awaited<ReturnType<typeof askFixture>>): void {
  const coordinator = profile("coordinator", "glm-4.7", "pi");
  f.engine.profiles = [f.author, coordinator];
  f.store.setMeta("pool", [{ profileId: coordinator.id, enabled: true, group: "coordinate", roles: ["coordinator"], scopes: ["general"], weight: 1, capability: "low", cost: "very_low" }]);
}

/** A second MCP client bound to its own binding file, for transport-classification proofs. */
async function boundAskClient(
  f: Awaited<ReturnType<typeof askFixture>>,
  binding: { socketPath: string; askTimeoutMs?: number },
): Promise<Client> {
  const bindingPath = join(f.dir, `binding-${randomUUID()}.json`);
  writeFileSync(
    bindingPath,
    JSON.stringify({
      socketPath: binding.socketPath,
      taskId: f.task.id,
      runId: "run-1",
      token: "ask-token",
      ...(binding.askTimeoutMs === undefined ? {} : { askTimeoutMs: binding.askTimeoutMs }),
    }),
    { mode: 0o600 },
  );
  const client = new Client({ name: "ask-transport-proof", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../mcp-report.mjs", import.meta.url)),
        bindingPath,
      ],
      stderr: "pipe",
    }),
  );
  return client;
}

const until = async (pass: () => boolean, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!pass()) {
    if (Date.now() > deadline) throw new Error("condition never settled");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("a pi-shaped worker asks through nucleus_ask and gets the planner answer in turn; an identical retry collects the recorded answer", async () => {
  const f = await askFixture();
  try {
    registerPlanner(
      f,
      "Answer: Keep the public API\nReason: The brief fixes the public shape",
    );
    const args = {
      question: "Which approach should the retry use?",
      choices: ["Keep the public API", "Re-read the whole diff"],
      kind: "process",
    };
    const receipt = await f.receipt(args);
    assert.equal(receipt.status, "answered");
    assert.equal(
      receipt.answer,
      "Keep the public API — The brief fixes the public shape",
    );
    // Task 1109: the task's own planner is the submitting thread, asked before the project's.
    assert.equal(receipt.answeredBy, "planner origin");
    assert.deepEqual(f.delegated.sources, ["worker"]);
    assert.equal(f.events("agent_ask").length, 1, "one durable ask intent");
    assert.match(
      f.events("agent_ask")[0]!.detail,
      new RegExp(
        `^${receipt.askId}: kind process; run run-1 \\(revision\\); agent worker; question ${digest(args.question as string)}`,
      ),
    );
    assert.deepEqual(
      f.events("agent_ask_delegated").map((event) => event.detail),
      [`${receipt.askId}: task planner origin; asked`],
      "the task planner is asked first",
    );
    assert.match(
      f.events("agent_ask_answered")[0]!.detail,
      /answered by planner origin: Keep the public API/,
    );
    assert.equal(
      f.delegated.deciders.length,
      0,
      "a planner that answers starts no decider",
    );
    assert.match(
      f.delegated.planner[0]!,
      /Which approach should the retry use\?/,
    );
    assert.match(f.delegated.planner[0]!, /Keep the public API/);

    // An identical re-ask is the same question: the recorded answer returns and nobody is asked again.
    const again = await f.receipt(args);
    assert.deepEqual(again, receipt);
    assert.equal(
      f.delegated.planner.length,
      1,
      "an answered question never asks again",
    );
    assert.equal(f.events("agent_ask").length, 1);
  } finally {
    await f.close();
  }
});

test("askQuestionRefusal refuses empty and literal placeholder text, and keeps short real questions", () => {
  assert.equal(askQuestionRefusal(""), "nucleus_ask requires a real question; empty text is refused");
  assert.equal(askQuestionRefusal("   "), "nucleus_ask requires a real question; empty text is refused");
  assert.equal(askQuestionRefusal("placeholder"), "nucleus_ask requires a real question; placeholder text is refused");
  assert.equal(askQuestionRefusal("Placeholder"), "nucleus_ask requires a real question; placeholder text is refused");
  assert.equal(askQuestionRefusal("Ship?"), null);
  assert.equal(askQuestionRefusal("Merge?"), null);
});

test("nucleus_ask refuses a placeholder question before it records or routes", async () => {
  const f = await askFixture();
  try {
    const refused = await f.ask({ question: "placeholder" });
    assert.equal(refused.isError, true);
    assert.match(String((refused.content as { text: string }[])[0].text), /placeholder text is refused/);
    assert.equal(f.events("agent_ask").length, 0, "a refused placeholder records nothing");
    assert.equal(f.delegated.planner.length, 0);
  } finally {
    await f.close();
  }
});

test("a reviewer process ask takes planner classification instead of an operator decision", async () => {
  const f = await askFixture({ waitMs: 5_000 });
  try {
    registerPlanner(f, "Answer: Keep the public API\nReason: The brief already settled it");
    f.store.putRun({
      id: "reviewer-run",
      taskId: f.task.id,
      role: "reviewer",
      generation: 1,
      head,
      agentId: "reviewer",
      workspaceId: "ws",
      profile: f.author,
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    } as unknown as Run);
    f.store.setCredential("reviewer-run", "reviewer-token");
    f.store.update(f.task.id, {
      resolution: {
        ...f.store.task(f.task.id).resolution,
        currentRunId: "reviewer-run",
        reviewerAgentId: "reviewer",
      },
    });
    const receipt = await f.engine.resolution.agentAsk({
      eventId: createHash("sha256").update("reviewer-ask").digest("hex"),
      taskId: f.task.id,
      runId: "reviewer-run",
      question: "Should the public API stay?",
      kind: "process",
      choices: [],
    }, "reviewer-token");
    assert.equal(receipt.status, "answered");
    // Task 1109: the task's own planner answers before the project rung.
    assert.equal(receipt.answeredBy, "planner origin");
    const askId = receipt.askId;
    assert.match(f.events("agent_ask")[0]!.detail, new RegExp(`^${askId}: kind process; run reviewer-run \\(reviewer\\)`));
    assert.deepEqual(
      f.events("agent_ask_delegated").map((event) => event.detail),
      [`${askId}: task planner origin; asked`],
    );
    assert.equal(f.events("agent_ask_decision").length, 0, "a reviewer process ask does not open an operator decision");
  } finally {
    await f.close();
  }
});

test("existing compact ask identities remain stable when targeting the planner", () => {
  const compact = { headline: "Choose", details: "Evidence" };
  const expected = digest(JSON.stringify(["agent-ask-v2", "task", "scope", "Question", ["Yes"], "Choose", null, null, "Evidence"]));
  assert.equal(agentAskId("task", "scope", "Question", ["Yes"], compact), expected);
  assert.equal(agentAskId("task", "scope", "Question", ["Yes"], { ...compact, target: "planner" }), expected);
  assert.notEqual(agentAskId("task", "scope", "Question", ["Yes"], { ...compact, target: "reviewer" }), expected);
});

test("the ask identity includes compact board-decision content", () => {
  const base = agentAskId("task", "scope", "Which route?", ["Keep", "Change"]);
  assert.notEqual(agentAskId("task", "scope", "Which route?", ["Keep", "Change"], { headline: "Which route?" }), base);
  assert.notEqual(agentAskId("task", "scope", "Which route?", ["Keep", "Change"], {
    choiceDetails: [{ label: "Keep", consequence: "No migration." }, { label: "Change", consequence: "Migrate now." }],
  }), base);
  assert.notEqual(agentAskId("task", "scope", "Which route?", ["Keep", "Change"], { recommended: "Change" }), base);
  assert.notEqual(agentAskId("task", "scope", "Which route?", ["Keep", "Change"], { details: "Full evidence." }), base);
});

test("a planner answer overtakes only the exact decisions it cites", async () => {
  const f = await askFixture();
  try {
    const decisions = new Decisions(f.store);
    const settled = decisions.add({ question: "Should the public API stay open?", askedBy: "planner" });
    const similar = decisions.add({ question: "Should the API remain available?", askedBy: "planner" });
    registerPlanner(f, `Answer: Make the API private\nReason: The planner ruling is explicit.\nOvertakes: ${settled.id}`);

    const receipt = await f.receipt({ question: "How should the API change?" });
    assert.equal(receipt.status, "answered");
    const overtaken = decisions.get({ id: settled.id });
    assert.equal(overtaken.overtakenBy?.[0]?.kind, "planner_answer");
    assert.equal(overtaken.overtakenBy?.[0]?.id, f.task.id);
    assert.equal(overtaken.overtakenBy?.[0]?.sourceId, receipt.askId);
    assert.match(overtaken.overtakenBy?.[0]?.label ?? "", /Make the API private/);
    assert.deepEqual(decisions.get({ id: similar.id }).overtakenBy, [], "similar wording is never inferred as a reference");
  } finally {
    await f.close();
  }
});

for (const [who, options] of [["planner", { planner: "Answer: Hold\nReason: Wait for the gate." }], ["decider", { decider: "Answer: Hold\nReason: Wait for the gate." }]] as const) {
  test(`bug 23: a ${who} hold on a binary ask stands as a hold`, async () => {
    const f = await askFixture({ waitMs: 5_000, ...options });
    // Task 1109: the decider follows the planner rungs, so a silent rung uses a short window.
    f.engine.resolution.delegatedAnswerWaitMs = who === "decider" ? 300 : 5_000;
    try {
      eligibleDecider(f);
      if (who === "planner") registerPlanner(f, options.planner!);
      const receipt = await f.receipt({ question: "Spend past twice the budget?", choices: [{ label: "Approve", consequence: "Extend." }, { label: "Hold", consequence: "Keep." }], kind: "budget" });
      assert.equal(receipt.status, "answered");
      assert.equal(receipt.answer, "Hold — Wait for the gate.");
      assert.doesNotMatch(f.events("agent_ask_answered")[0]!.detail, /approve by default/);
    } finally { await f.close(); }
  });
}

test("bug 23: a binary ask the planner forwards reaches the operator instead of approving itself", async () => {
  // The planner answers at once; a tight window would close first on a busy host.
  const f = await askFixture({ waitMs: 5_000 });
  try {
    registerPlanner(f, "Decision: operator\nReason: Only Tom can say.");
    await f.receipt({ question: "Spend past twice the budget?", choices: [{ label: "Approve", consequence: "Extend." }, { label: "Hold", consequence: "Keep." }], kind: "budget" });
    await until(() => f.events("agent_ask_decision").length > 0);
    assert.equal(f.events("agent_ask_answered").length, 0);
    assert.equal(new Decisions(f.store).list({ status: "open" }).length, 1);
  } finally { await f.close(); }
});

test("bug 8: an ask skips an archived project planner; bug 25: planner, decider and reviewer read the task context", async () => {
  const f = await askFixture({ waitMs: 5_000, decider: "Answer: Use the fixture\nReason: Isolated." });
  f.engine.resolution.delegatedAnswerWaitMs = 5_000;
  try {
    eligibleDecider(f);
    registerPlanner(f, "Answer: Never\nReason: Archived.");
    // Task 1109: the task names the same thread, so its gone thread is skipped on both rungs.
    f.store.update(f.task.id, { plannerAgentId: "planner-1" });
    Object.assign(f.engine.adapter as object, { originAgent: async (id: string) => ({ id, workspaceId: "ws", title: id, archived: id === "planner-1" }) });
    const receipt = await f.receipt({ question: "Which fixture?" });
    assert.equal(receipt.answer, "Use the fixture — Isolated.");
    assert.deepEqual(f.delegated.planner, []);
    assert.equal(f.store.projectByKey("app")?.planner, null);
    assert.match(f.delegated.deciders[0]!.prompt, /Task context:\n {2}Task: /);
  } finally { await f.close(); }
  const live = await askFixture({ waitMs: 300, planner: "Answer: Use the fixture\nReason: Isolated." });
  try {
    registerPlanner(live, live.options.planner ?? null);
    await live.receipt({ question: "Which fixture?" });
    assert.match(live.delegated.planner[0]!, /Task context:\n {2}Task: [\s\S]*^ {2}Brief: /m);
  } finally { await live.close(); }
  assert.match(reviewerAskPrompt("Which gate?", "Isolation gate", ["Brief: the gate"]), /Question: Which gate\?\nTask context:\n {2}Brief: the gate/);
});

test("a delegated binary budget approval stays with the planner and uses Tom's default rule", async () => {
  const f = await askFixture({ waitMs: 300, planner: "Answer: Approve\nReason: The extra budget is justified." });
  try {
    registerPlanner(f, f.options.planner ?? null);
    const args = {
      question: "Spend past twice the budget to keep chasing this?",
      headline: "Approve this budget extension?",
      choices: [
        { label: "Approve", consequence: "Extend the approved budget." },
        { label: "Hold", consequence: "Keep the current budget." },
      ],
      recommended: "Hold",
      details: "The current investigation has reached its approved budget.",
      kind: "budget",
    };
    const receipt = await f.receipt(args);
    assert.equal(receipt.status, "answered");
    assert.equal(receipt.answer, "Approve — approve by default, Tom 2026-11-03");
    await until(() => f.events("agent_ask_answered").length > 0);
    assert.match(f.events("agent_ask")[0]!.detail, /kind budget/, "the requested hint survives the MCP schema");
    assert.match(f.events("agent_ask_answered")[0]!.detail, /approve by default, Tom 2026-11-03/);
    assert.match(f.delegated.planner[0]!, /nucleus question.answer/);
    assert.doesNotMatch(f.delegated.planner[0]!, /approve by default, Tom 2026-11-03/, 'standing rules live in the skill');
    assert.equal(new Decisions(f.store).list({ status: "open" }).length, 0, "the binary approval never becomes a board decision");
  } finally {
    await f.close();
  }
});

test("a scope hint is answered by the planner before any operator decision", async () => {
  const f = await askFixture({ planner: "Answer: Keep the existing boundary\nReason: The brief already defines it." });
  try {
    registerPlanner(f, f.options.planner ?? null);
    const receipt = await f.receipt({ question: "How should I interpret the account-read boundary?", kind: "scope" });
    assert.equal(receipt.status, "answered");
    assert.equal(receipt.answer, "Keep the existing boundary — The brief already defines it.");
    assert.equal(f.delegated.planner.length, 1);
    assert.equal(f.events("agent_ask_decision").length, 0);
  } finally { await f.close(); }
});

test("a decider timeout after a scope hint leaves it pending without an operator decision", async () => {
  const f = await askFixture({ waitMs: 100 });
  try {
    registerPlanner(f, null);
    const coordinator = profile("coordinator", "glm-4.7", "pi");
    f.engine.profiles = [f.author, coordinator];
    f.store.setMeta("pool", [{ profileId: coordinator.id, enabled: true, group: "coordinate", roles: ["coordinator"], scopes: ["general"], weight: 1, capability: "low", cost: "very_low" }]);
    const adapter = f.engine.adapter as unknown as { runDecider: (task: unknown, input: { profile: Profile }) => Promise<never> };
    adapter.runDecider = async (_task, input) => { f.delegated.deciders.push({ prompt: "", profile: input.profile.id }); throw Error("decider timed out"); };
    const receipt = await f.receipt({ question: "Should the task change what it delivers?", kind: "scope" });
    assert.equal(receipt.status, "pending");
    await until(() => f.events("agent_ask_delegation_unknown").some(event => event.detail.includes("decider timed out")));
    assert.equal(f.delegated.planner.length, 2, 'the task planner and then the project planner were asked before the decider');
    assert.equal(f.delegated.deciders.length, 1, "the decider was reached before timing out");
    assert.equal(f.events("agent_ask_decision").length, 0);
  } finally { await f.close(); }
});

test("a product change is surfaced once as a contextual discussion decision", async () => {
  const f = await askFixture({ waitMs: 300, planner: "Decision: operator\nReason: This would change the approved deliverable." });
  try {
    registerPlanner(f, f.options.planner ?? null);
    const receipt = await f.receipt({
      question: "How should the product expose audit history?",
      headline: "Choose how audit history appears in the public API",
      choices: [
        { label: "Add an audit endpoint", consequence: "Expose history through a dedicated read-only endpoint." },
        { label: "Include history in the existing response", consequence: "Extend the current response shape." },
      ],
      recommended: "Add an audit endpoint",
      details: "The product change affects API shape and client migration. Existing clients must continue to work.",
      kind: "scope",
    });
    assert.equal(receipt.status, "pending");
    assert.match(f.events("agent_ask")[0]!.detail, /kind scope/, "scope remains operator-only through MCP");
    assert.match(
      receipt.detail!,
      /Recorded as question [a-f0-9]{64}; pending with Tom as Nucleus operator decision \S+/,
    );
    assert.match(receipt.detail!, /You'll be resumed with the answer/);
    assert.ok(receipt.detail!.includes(receipt.askId), "the pending names its question id");
    assert.match(
      receipt.detail!,
      /call your session's question tool again with the same question/,
    );
    const decisions = new Decisions(f.store);
    const open = decisions.list({ status: "open" });
    assert.equal(open.length, 1);
    assert.equal(open[0]!.headline, "Choose how audit history appears in the public API");
    assert.deepEqual(open[0]!.choices?.map(choice => choice.label), ["Add an audit endpoint", "Include history in the existing response"]);
    assert.equal(open[0]!.recommended, "Add an audit endpoint");
    assert.match(open[0]!.details ?? "", /product change affects API shape and client migration/);
    assert.ok(
      receipt.detail!.includes(open[0]!.id),
      "the pending names the decision",
    );
    assert.equal(f.events("agent_ask").length, 1, "the routed ask is visible in activity even after pending");
    assert.equal(f.events("agent_ask_decision").length, 1);

    // The board answers late; the recorded answer reaches the next re-ask.
    const view = decisions.answer({
      id: open[0]!.id,
      version: open[0]!.version,
      answer: "Add an audit endpoint",
      answeredBy: "operator (board)",
      relayed: false,
      note: "",
    });
    f.engine.resolution.operatorDecisionAnswered(view);
    const later = await f.receipt({
      question: "How should the product expose audit history?",
      headline: "Choose how audit history appears in the public API",
      choices: [
        { label: "Add an audit endpoint", consequence: "Expose history through a dedicated read-only endpoint." },
        { label: "Include history in the existing response", consequence: "Extend the current response shape." },
      ],
      recommended: "Add an audit endpoint",
      details: "The product change affects API shape and client migration. Existing clients must continue to work.",
      kind: "scope",
    });
    assert.equal(later.status, "answered");
    assert.equal(later.answer, "Add an audit endpoint");
  } finally {
    await f.close();
  }
});

test("a release approval classified as operator-only still reaches the board", async () => {
  const f = await askFixture({ waitMs: 300, planner: "Decision: operator\nReason: Publishing the release is an outward action." });
  try {
    registerPlanner(f, f.options.planner ?? null);
    const receipt = await f.receipt({
      question: "Should Queue publish this release?",
      headline: "Publish the reviewed release",
      choices: [
        { label: "Approve release", consequence: "Publish the release to users." },
        { label: "Hold release", consequence: "Keep it unpublished." },
      ],
      recommended: "Hold release",
      details: "The release is ready, but publication is an outward action.",
      kind: "release",
    });
    assert.equal(receipt.status, "pending");
    await until(() => f.events("agent_ask_decision").length > 0);
    const open = new Decisions(f.store).list({ status: "open" });
    assert.equal(open.length, 1);
    assert.equal(open[0]!.headline, "Publish the reviewed release");
    assert.deepEqual(open[0]!.choices?.map(choice => choice.label), ["Hold release", "Approve release"], "the recommendation leads the list");
    assert.equal(open[0]!.recommended, "Hold release");
    assert.match(open[0]!.details ?? "", /release is an outward action/);
    assert.equal(f.events("agent_ask_decision").length, 1);
  } finally { await f.close(); }
});

test("an ask joins a question Queue itself raised and collects its answer instead of asking anyone twice", async () => {
  const f = await askFixture({ waitMs: 300 });
  try {
    const question =
      "Three review rounds have not converged. How should the next round proceed?";
    const options = ["Continue the current approach", "Change the approach"];
    const queueQuestionId = "queue-question-1";
    // Queue raised this question on this task through the ask path.
    f.store.event(
      f.task.id,
      "queue_ask_delivery",
      `${queueAskDeliveryId(f.task.id, question, options)}: queue question ${queueQuestionId}`,
    );
    const receipt = await f.receipt({ question, choices: options });
    assert.equal(
      receipt.status,
      "pending",
      "the joined question is still being answered",
    );
    assert.match(receipt.detail!, /Recorded as question [a-f0-9]{64}; pending with/);
    assert.equal(
      f.delegated.planner.length,
      0,
      "a joined ask routes nowhere on its own",
    );
    assert.deepEqual(
      f.events("agent_ask_joined").map((event) => event.detail),
      [`${receipt.askId}: queue question ${queueQuestionId}`],
    );

    // The Queue-raised question settles; the recorded answer reaches the join.
    f.store.event(
      f.task.id,
      "operator_question_answered",
      `${queueQuestionId}: I refuse — answered by the planner earlier — answered by operator (board)`,
    );
    const again = await f.receipt({ question, choices: options });
    assert.equal(again.status, "answered");
    assert.equal(again.answer, "I refuse — answered by the planner earlier");
    assert.equal(again.answeredBy, "operator (board)");
    assert.equal(
      f.events("agent_ask_answered")[0]!.detail,
      `${again.askId}: answered by operator (board): I refuse — answered by the planner earlier`,
    );
    assert.equal(
      f.delegated.planner.length,
      0,
      "the answer comes from the joined question, never a second delegate",
    );
  } finally {
    await f.close();
  }
});

test("the joint review question on a provider without native questions goes through the nucleus_ask path", async () => {
  const delegated: { planner: string | null; decider: string | null } = { planner: null, decider: null };
  const f = lifecycleFixture({
    responsible: true,
    provider: "pi",
    delegates: delegated,
  });
  f.engine.resolution.delegatedAnswerWaitMs = 30_000;
  try {
    const settled = new Decisions(f.store).add({ question: "Should this review stay on the current branch?", askedBy: "planner" });
    delegated.planner = `Choice: Continue the current approach\nReason: The disagreement is mechanical\nOvertakes: ${settled.id}`;
    f.store.upsertProject({
      key: "app",
      name: "App",
      repositories: [{ origin: null, path: join(f.dir, "repo") }],
    });
    f.store.setProjectPlanner({
      key: "app",
      agentId: "planner-1",
      setBy: "operator",
    });
    let resumedReason: string | undefined;
    const update = f.store.update.bind(f.store);
    f.store.update = (...args) => {
      const task = update(...args);
      if (args[2] === 'responsible_question_resumed') resumedReason = task.reason;
      return task;
    };
    await f.reviews(3);
    await f.engine.wake();
    await until(() => f.events("responsible_question").length > 0);
    await until(() => f.prompts.length > 0);
    assert.equal(
      f.asks.length,
      0,
      "a provider without native questions is never prompted to raise one",
    );
    assert.equal(
      f.events("queue_ask_delivery").length,
      1,
      "the join key is recorded durably",
    );
    assert.match(f.prompts[0]!.text, /question MCP tool named in your session's launch instructions/);
    assert.doesNotMatch(f.prompts[0]!.text, /nucleus_ask/);
    assert.match(f.prompts[0]!.text, /Three review rounds have not converged/);
    assert.equal(
      f.delegated.answers.length,
      0,
      "there is no native permission to answer",
    );
    assert.equal(
      f.delegated.planner.length,
      1,
      "the planner answers the delegated question",
    );

    // The settle path records the answer with who answered it and resumes the task.
    await until(() => f.events("responsible_question_answered").length > 0);
    assert.match(
      f.events("responsible_question_answered")[0]!.detail,
      /Continue the current approach — answered by delegated planner origin/,
    );
    const marked = new Decisions(f.store).get({ id: settled.id }).overtakenBy?.[0];
    assert.equal(marked?.kind, "planner_answer");
    assert.equal(marked?.id, f.current().id);
    assert.equal(marked?.sourceId, f.events("responsible_question")[0]!.detail.split(":")[0]);
    await until(() => f.events("responsible_question_resumed").length > 0);
    assert.equal(
      f.current().resolution.stop,
      null,
      "the answered question clears the wait",
    );
    assert.match(resumedReason ?? '', /A delegated planner answered the joint review question/,
      'the continuation names planner authority instead of presenting it as an operator instruction');

    // The thread's own nucleus_ask call, carrying the exact delivered content, joins and collects the answer.
    const prompt = f.prompts[0]!.text;
    const question = prompt.slice(
      prompt.indexOf("Question: ") + "Question: ".length,
      prompt.indexOf(" Choices: "),
    );
    const choices = prompt
      .slice(
        prompt.indexOf(" Choices: ") + " Choices: ".length,
        prompt.indexOf(". Do not answer"),
      )
      .split(" | ");
    await f.engine.wake();
    await until(() => Boolean(f.current().resolution.currentRunId));
    const run = f.run();
    const receipt = await f.engine.resolution.agentAsk(
      {
        eventId: createHash("sha256").update(randomUUID()).digest("hex"),
        taskId: f.submitted.id,
        runId: run.id,
        question,
        choices,
      },
      f.tokens.get(run.id)!,
    );
    assert.equal(receipt.status, "answered");
    assert.equal(receipt.answer, "Continue the current approach");
    assert.equal(receipt.answeredBy, "delegated planner origin");
    assert.equal(
      f.events("agent_ask_joined").length,
      1,
      "the ask joined the Queue-raised question",
    );
    assert.equal(
      f.delegated.planner.length,
      1,
      "a join never asks the planner twice",
    );
  } finally {
    await f.close();
  }
});

test('a T3-bound third-round review question goes to the task planner through question.answer', async () => {
  const delegated = { planner: null as string | null, decider: null as string | null };
  const f = lifecycleFixture({ responsible: true, provider: 'pi', hostId: 't3code:synthetic-environment', delegates: delegated });
  f.engine.resolution.delegatedAnswerWaitMs = 30_000;
  Object.assign(f.adapter, {
    capabilities: () => ({ nativeDecisions: false, reportingViaMcp: false }),
    reportingViaMcp: false,
  });
  const prior = new Decisions(f.store).add({ question: 'Earlier planner question?', askedBy: 'planner' });
  delegated.planner = `Choice: Continue the current approach\nReason: The current approach remains safe\nOvertakes: ${prior.id}`;
  f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
  f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
  f.store.update(f.submitted.id, { plannerAgentId: 'task-planner-1' });
  try {
    await f.reviews(3);
    await f.engine.wake();
    await until(() => f.events('responsible_question_answered').length > 0);
    assert.equal(f.delegated.planner.length, 1);
    assert.equal(f.delegated.planner[0]!.agentId, 'task-planner-1', 'the task planner is the first rung');
    assert.match(f.delegated.planner[0]!.prompt, /question\.answer/);
    assert.match(f.delegated.planner[0]!.prompt, /Three review rounds have not converged/);
    assert.equal(new Decisions(f.store).list({ task: f.submitted.id, status: 'open' }).length, 0,
      'planner-ladder questions do not become board decisions when the task host lacks native questions');
    assert.match(f.events('responsible_question_answered')[0]!.detail, /Continue the current approach — answered by delegated planner/);
    assert.ok(f.events('responsible_question_resumed').length > 0, 'the review round continues after the planner answer');
  } finally { await f.close(); }
});

test('a T3 scope question remains a board decision', async () => {
  const f = lifecycleFixture({ responsible: true, provider: 'pi', delegates: { planner: null } });
  Object.assign(f.adapter, {
    capabilities: () => ({ nativeDecisions: false, reportingViaMcp: false }),
    reportingViaMcp: false,
  });
  const controller = new AbortController();
  const pending = f.engine.resolution.raiseDecision(f.store.task(f.submitted.id), {
    id: 'scope-question', kind: 'scope', question: 'Should the task change its scope?', options: ['Change scope', 'Keep scope'],
  }, controller.signal);
  void pending.catch(() => {});
  try {
    await until(() => new Decisions(f.store).list({ task: f.submitted.id, status: 'open' }).length === 1);
    assert.equal(f.delegated.planner.length, 0, 'operator-only scope questions skip the planner ladder');
    assert.match(f.store.eventsAll(f.submitted.id).find(event => event.kind === 'operator_question_decision')!.detail,
      /the task host cannot take a native question/);
  } finally { controller.abort(); await f.close(); }
});


test("a fresh engine routes durable agent asks and never repeats an uncertain delegate send", async () => {
  const f = await askFixture({ waitMs: 300 });
  try {
    registerPlanner(f, "Answer: Use the existing route\nReason: It fits");
    const question = "Which route survives a restart?";
    const id = agentAskId(f.task.id, "process", question, []);
    f.store.event(f.task.id, "agent_ask_payload", JSON.stringify({ id, kind: "process", question, choices: [] }));
    f.store.event(f.task.id, "agent_ask", `${id}: persisted intent`);
    f.store.setMeta("paused", false);
    const restarted = new Engine(f.store, f.engine.adapter, 0);
    await restarted.resolution.resumeAskQuestions();
    await until(() => f.events("agent_ask_answered").length === 1);
    assert.equal(f.delegated.planner.length, 1);
    const retry = await f.receipt({ question });
    assert.equal(retry.status, "answered");
    assert.equal(f.delegated.planner.length, 1);

    const lostQuestion = "Was the delegate reached?";
    const lost = agentAskId(f.task.id, "process", lostQuestion, []);
    f.store.event(f.task.id, "agent_ask_payload", JSON.stringify({ id: lost, kind: "process", question: lostQuestion, choices: [] }));
    f.store.event(f.task.id, "agent_ask", `${lost}: persisted intent`);
    f.store.event(f.task.id, "agent_ask_delegated", `${lost}: planner planner-1; asked`);
    await restarted.resolution.resumeAskQuestions();
    await until(() => f.events("agent_ask_delegation_unknown").some(event => event.detail.startsWith(lost)));
    const unknownCount = f.events("agent_ask_delegation_unknown").filter(event => event.detail.startsWith(lost)).length;
    await restarted.resolution.resumeAskQuestions();
    assert.equal(f.delegated.planner.length, 1);
    assert.equal(f.events("agent_ask_delegation_unknown").filter(event => event.detail.startsWith(lost)).length, unknownCount,
      "a recorded unknown ask is terminal and never emits another unknown event");
    assert.equal(f.events("agent_ask_decision").some(event => event.detail.startsWith(lost)), false);
    assert.equal(new Decisions(f.store).list({ task: f.task.id, status: "open" }).length, 0);

    const reviewerQuestion = 'Did the reviewer receive the consult?';
    const reviewerAsk = agentAskId(f.task.id, 'process', reviewerQuestion, [], { target: 'reviewer' });
    f.store.event(f.task.id, 'agent_ask_payload', JSON.stringify({ id: reviewerAsk, kind: 'process', question: reviewerQuestion, choices: [], target: 'reviewer' }));
    f.store.event(f.task.id, 'agent_ask', `${reviewerAsk}: persisted intent`);
    f.store.event(f.task.id, 'agent_ask_delegated', `${reviewerAsk}: reviewer reviewer-1; consult`);
    await restarted.resolution.resumeAskQuestions();
    await until(() => f.events('agent_ask_delegation_unknown').some(event => event.detail.startsWith(reviewerAsk)));
    await restarted.resolution.resumeAskQuestions();
    assert.equal(f.events('agent_ask_delegated').filter(event => event.detail.startsWith(reviewerAsk)).length, 1);

    const stale = agentAskId(f.task.id, "process", "Does the current stop still match this ask?", []);
    const origin = f.store.runs(f.task.id).find(run => !run.released && !run.completion)!;
    f.store.putRun({ ...origin, status: "finished", released: true,
      completion: { eventId: "origin-ended", taskId: f.task.id, runId: origin.id, status: "blocked", summary: "Run ended" } });
    f.store.event(f.task.id, "agent_ask_payload", JSON.stringify({ id: stale, kind: "process", question: "Does the current stop still match this ask?", choices: [] }));
    f.store.event(f.task.id, "agent_ask", `${stale}: kind process; run ${origin.id} (revision); delegated question`);
    f.store.event(f.task.id, "agent_ask_delegation_unknown", `${stale}: previous delivery was uncertain`);
    await restarted.resolution.resumeAskQuestions();
    assert.match(f.events("agent_ask_superseded").find(event => event.detail.startsWith(stale))!.detail,
      /originating run .* ended; the task's current stop no longer matches/);
  } finally { await f.close(); }
});

test("a fresh engine settles a previously answered board decision for a Queue-raised joint question", async () => {
  const f = await askFixture();
  try {
    const id = "restart-joint";
    f.store.event(f.task.id, "responsible_question", `${id}: persisted intent`);
    const decisions = new Decisions(f.store);
    const decision = decisions.add({ question: "How should the next review proceed?", options: ["Continue"], askedBy: "worker", tasks: [f.task.id] });
    f.store.event(f.task.id, "operator_question_decision", `${id}: decision ${decision.id}; awaiting operator`);
    decisions.answer({ id: decision.id, version: decision.version, answer: "Continue", answeredBy: "operator (board)", relayed: false, note: "" });
    f.store.setMeta("paused", false);
    const restarted = new Engine(f.store, f.engine.adapter, 0);
    await restarted.resolution.resumeAskQuestions();
    await restarted.resolution.resumeAskQuestions();
    assert.equal(f.events("responsible_question_answered").length, 1);
    assert.match(f.events("responsible_question_answered")[0]!.detail, /Continue — answered by operator \(board\)/);
    assert.equal(f.events("responsible_question_resumed").length, 1);
  } finally { await f.close(); }
});

test("a planner-forwarded Queue question survives restart, settles after its stop clears, and answers its joined ask", async () => {
  const f = await askFixture({ waitMs: 100, planner: "Decision: operator\nReason: This changes the delivered scope." });
  try {
    registerPlanner(f, f.options.planner ?? null);
    f.store.setMeta("paused", false);
    Object.assign(f.engine.adapter, { raiseTaskDecision: async () => { throw Error("unexpected native question"); } });
    const run = f.store.run("run-1")!;
    f.store.putRun({ ...run, released: true, active: false });
    f.store.update(f.task.id, { phase: "blocked", prerequisiteWait: { id: randomUUID(), waitsFor: ["dependency"], reason: "waiting", releasedAt: null } } as never);
    f.engine.resolution.recordStop(f.store.task(f.task.id), "operator_needed", "A ruling is needed", ["restart", "route", "move"]);
    await f.engine.resolution.raiseOperatorQuestions();
    assert.equal(f.events("operator_question").length, 1);
    const payload = JSON.parse(f.events("queue_ask_payload")[0]!.detail) as { id: string; kind: string; question: string; options: string[] };
    assert.equal(payload.kind, "process");
    await until(() => new Decisions(f.store).list({ task: f.task.id, status: "open" }).length > 0);
    const decisions = new Decisions(f.store);
    const decision = decisions.list({ task: f.task.id, status: "open" })[0]!;
    assert.ok(decision);
    f.store.putRun(run);
    const pending = await f.receipt({ question: payload.question, choices: payload.options });
    assert.equal(pending.status, "pending");
    assert.match(pending.detail!, /Recorded as question [a-f0-9]{64}; pending with/);
    assert.equal(f.events("agent_ask_joined").length, 1);
    f.engine.resolution.update(f.store.task(f.task.id), { stop: null });
    const answer = "A".repeat(6000);
    decisions.answer({ id: decision.id, version: decision.version, answer, answeredBy: "operator (board)", relayed: false, note: "" });
    const restarted = new Engine(f.store, f.engine.adapter, 0);
    await restarted.resolution.resumeAskQuestions();
    await restarted.resolution.resumeAskQuestions();
    const settled = f.events("operator_question_answered");
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.detail, `${payload.id}: ${answer} — answered by operator (board)`);
    assert.equal(f.events("operator_question_applied").length, 0);
    const receipt = await f.receipt({ question: payload.question, choices: payload.options });
    assert.equal(receipt.status, "answered");
    assert.equal(receipt.answer, answer);
    assert.equal(receipt.answeredBy, "operator (board)");
    const retry = await f.receipt({ question: payload.question, choices: payload.options });
    assert.deepEqual(retry, receipt);
    f.store.putRun({ ...run, released: true, active: false });
    restarted.resolution.recordStop(f.store.task(f.task.id), "operator_needed", "A later ruling is needed", ["restart", "route", "move"]);
    await restarted.resolution.raiseOperatorQuestions();
    assert.equal(f.events("operator_question").length, 2, "the settled question no longer blocks a later one");
  } finally { await f.close(); }
});

test("a long operator answer retains its attribution and full text on an agent ask retry", async () => {
  const f = await askFixture({ waitMs: 100, planner: "Decision: operator\nReason: This changes the approved deliverable." });
  try {
    registerPlanner(f, f.options.planner ?? null);
    const question = "Should we change scope?";
    await f.receipt({ question, kind: "scope" });
    const decisions = new Decisions(f.store);
    const decision = decisions.list({ task: f.task.id, status: "open" })[0]!;
    const answer = "Long ruling. ".repeat(500);
    const view = decisions.answer({ id: decision.id, version: decision.version, answer, answeredBy: "operator (board)", relayed: false, note: "" });
    f.engine.resolution.operatorDecisionAnswered(view);
    const result = await f.receipt({ question, kind: "scope" });
    assert.equal(result.answer, answer.trim());
    assert.equal(result.answeredBy, "operator (board)");
  } finally { await f.close(); }
});

test("an initial worker run on the task row asks through nucleus_ask and gets the planner answer in turn", async () => {
  const f = await askFixture({ initialRun: true });
  try {
    registerPlanner(
      f,
      "Answer: Keep the public API\nReason: The brief fixes the public shape",
    );
    assert.equal(
      f.store.runs(f.task.id).length,
      0,
      "the initial worker lives on the task row, never as a run",
    );
    const args = {
      question: "Which approach should the retry use?",
      choices: ["Keep the public API", "Re-read the whole diff"],
      kind: "process",
    };
    const receipt = await f.receipt(args);
    assert.equal(receipt.status, "answered");
    assert.equal(
      receipt.answer,
      "Keep the public API — The brief fixes the public shape",
    );
    assert.equal(receipt.answeredBy, "planner origin");
    assert.equal(f.events("agent_ask").length, 1, "one durable ask intent");
    assert.match(
      f.events("agent_ask")[0]!.detail,
      new RegExp(
        `^${receipt.askId}: kind process; run initial-run \\(revision\\); agent worker; question ${digest(args.question as string)}`,
      ),
    );

    // An identical re-ask is the same question: the recorded answer returns and nobody is asked again.
    const again = await f.receipt(args);
    assert.deepEqual(again, receipt);
    assert.equal(f.events("agent_ask").length, 1);
  } finally {
    await f.close();
  }
});

test("a superseded task-row binding is refused with the current owner named", async () => {
  const f = await askFixture({ initialRun: true, waitMs: 300 });
  try {
    // A live revision run takes over the worker role for another agent.
    f.store.putRun({
      id: "run-2",
      taskId: f.task.id,
      role: "revision",
      generation: 2,
      head,
      agentId: "worker-2",
      workspaceId: "ws-2",
      profile: f.author,
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    } as unknown as Run);
    f.store.update(f.task.id, {
      resolution: {
        ...f.store.task(f.task.id).resolution,
        currentRunId: "run-2",
      },
    });
    const refused = await f.ask({ question: "Which approach?" });
    assert.equal(refused.isError, true);
    const text = String((refused.content as { text: string }[])[0].text);
    assert.match(text, /Stale reporting run/);
    assert.match(
      text,
      /worker-2/,
      "the refusal names the agent that owns the role now",
    );
    assert.match(text, /run-2/, "the refusal names the current run");
    assert.equal(f.events("agent_ask").length, 0, "a refused ask records nothing");
  } finally {
    await f.close();
  }
});

test("a stored run a live current run superseded is refused with the current owner named", async () => {
  const f = await askFixture();
  try {
    // A live revision run takes over the worker role for another agent; the
    // stored binding is no longer the task's current run.
    f.store.putRun({
      id: "run-2",
      taskId: f.task.id,
      role: "revision",
      generation: 2,
      head,
      agentId: "worker-2",
      workspaceId: "ws-2",
      profile: f.author,
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    } as unknown as Run);
    f.store.update(f.task.id, {
      resolution: {
        ...f.store.task(f.task.id).resolution,
        currentRunId: "run-2",
      },
    });
    const refused = await f.ask({ question: "Which approach?" });
    assert.equal(refused.isError, true);
    const text = String((refused.content as { text: string }[])[0].text);
    assert.match(text, /Stale reporting run/);
    assert.match(
      text,
      /worker-2/,
      "the refusal names the agent that owns the role now",
    );
    assert.match(text, /run-2/, "the refusal names the current run");
    assert.equal(f.events("agent_ask").length, 0, "a refused ask records nothing");
  } finally {
    await f.close();
  }
});

test("a stored run whose current-run identity is gone is refused even when no live owner row can be named", async () => {
  // The task's current run id is absent: no row owns the role, so the stale
  // stored binding cannot ask and the refusal names no owner.
  const f = await askFixture();
  try {
    f.store.update(f.task.id, {
      resolution: {
        ...f.store.task(f.task.id).resolution,
        currentRunId: null,
      },
    });
    const refused = await f.ask({ question: "Which approach?" });
    assert.equal(refused.isError, true);
    const text = String((refused.content as { text: string }[])[0].text);
    assert.match(text, /Stale reporting run/);
    assert.doesNotMatch(text, /is superseded/, "no live owner row exists to name");
    assert.equal(f.events("agent_ask").length, 0, "a refused ask records nothing");
  } finally {
    await f.close();
  }

  // A settled run never asks again: its own report released the role, even
  // though its id is still the task's current run id.
  const g = await askFixture();
  try {
    g.store.putRun({
      ...g.store.run("run-1")!,
      completion: {
        eventId: "settled-1",
        taskId: g.task.id,
        runId: "run-1",
        status: "blocked",
        headline: "Blocked on a premise failure",
        summary: "Blocked on a premise failure",
      },
    } as unknown as Run);
    const refused = await g.ask({ question: "Which approach?" });
    assert.equal(refused.isError, true);
    const text = String((refused.content as { text: string }[])[0].text);
    assert.match(text, /Stale reporting run/);
    assert.doesNotMatch(text, /is superseded/, "no live owner row exists to name");
    assert.equal(g.events("agent_ask").length, 0, "a refused ask records nothing");
  } finally {
    await g.close();
  }
});

test("a planner ask waits with a plain reason when the planner host is offline", async () => {
  const f = await askFixture({ waitMs: 100, planner: "Answer: Continue\nReason: Within scope" });
  try {
    registerPlanner(f, f.options.planner ?? null);
    // Task 1109: the task's own planner is the thread on the offline host.
    f.store.update(f.task.id, { plannerAgentId: 'planner-1' });
    f.engine.identifyOriginHost = async id => id === 'planner-1' ? 'planner-host' : undefined;
    f.engine.hostAvailable = id => id === 'host';
    const pending = await f.receipt({ question: 'Where should this go?', kind: 'scope' });
    assert.equal(pending.status, 'pending');
    assert.match(pending.detail!, /waiting for the planner's proven host to be available/i);
    assert.equal(f.events('agent_ask_host_wait').length, 1);
    assert.match(f.events('agent_ask_host_wait')[0]!.detail, /Waiting for the planner's proven host to be available/);
    assert.deepEqual(f.delegated.planner, []);
    assert.equal(f.engine.resolution.delegatedDelivery(`ns-agent-ask-${pending.askId}`), null);
  } finally { await f.close(); }
});

test("a pending answer resumes the asking agent when the operator answers late", async () => {
  const f = await askFixture({ waitMs: 100, planner: "Decision: operator\nReason: This changes the approved deliverable." });
  const notified: Array<{ agentId: string; messageId: string; text: string }> = [];
  const adapter = f.engine.adapter as unknown as { notify?: (agentId: string, messageId: string, text: string) => Promise<void> };
  const originalNotify = adapter.notify;
  adapter.notify = async (agentId: string, messageId: string, text: string) => {
    notified.push({ agentId, messageId, text });
    return originalNotify?.(agentId, messageId, text);
  };
  try {
    registerPlanner(f, f.options.planner ?? null);
    const pending = await f.receipt({ question: "Should the task change scope?", kind: "scope" });
    assert.equal(pending.status, "pending");
    assert.match(f.events("agent_ask")[0]!.detail, /kind scope/, "scope reaches the authenticated callback");
    assert.equal(f.events("agent_ask_decision").length, 1, "an operator-only ask has a linked board decision before it returns pending");
    assert.match(pending.detail!, /Recorded as question [a-f0-9]{64}; pending with Tom/);
    assert.ok(pending.detail!.includes(pending.askId));
    // Routing is already visible in activity even though the tool returned pending.
    assert.equal(f.events("agent_ask").length, 1);
    assert.equal(f.events("agent_ask_decision").length, 1);
    const decisions = new Decisions(f.store);
    const open = decisions.list({ task: f.task.id, status: "open" })[0]!;
    assert.ok(open);
    const view = decisions.answer({ id: open.id, version: open.version, answer: "Keep the scope", answeredBy: "operator (board)", relayed: false, note: "" });
    f.engine.resolution.operatorDecisionAnswered(view);
    await until(() => f.events("agent_ask_resumed").some(event => event.detail.startsWith(pending.askId)));
    const resumed = f.events("agent_ask_resumed").find(event => event.detail.startsWith(pending.askId))!;
    assert.match(resumed.detail, /answered by operator \(board\)/);
    assert.ok(notified.some(item => item.messageId === `ns-agent-ask-answered-${pending.askId}` && item.agentId === "worker" && item.text.includes("Keep the scope")), "the asking agent is notified with the answer");
    const later = await f.receipt({ question: "Should the task change scope?", kind: "scope" });
    assert.equal(later.status, "answered");
    assert.equal(later.answer, "Keep the scope");
    assert.equal(later.answeredBy, "operator (board)");
  } finally {
    await f.close();
  }
});

test("late answers wait for the asking host and never repeat an uncertain notification", async () => {
  const f = await askFixture();
  let online = false, sends = 0;
  const adapter = f.engine.adapter as unknown as { notify: (agentId: string) => Promise<void> };
  adapter.notify = async agent => { assert.equal(agent, 'worker'); sends++; throw Error('delivery unknown'); };
  f.engine.hostAvailable = id => id === 'host' && online;
  try {
    f.store.event(f.task.id, 'agent_ask', 'late: kind process; run run-1 (revision); agent worker; question digest (1 chars); choices none');
    f.engine.resolution.notifyAskAnswered(f.task.id, 'late', 'Continue', 'planner');
    assert.equal(sends, 0);
    online = true;
    f.engine.resolution.notifyAskAnswered(f.task.id, 'late', 'Continue', 'planner');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sends, 1);
    assert.equal(f.events('agent_ask_resume_intent').length, 1);
    const restarted = new Engine(f.store, adapter as unknown as Adapter, 0);
    restarted.hostAvailable = () => true;
    restarted.resolution.notifyAskAnswered(f.task.id, 'late', 'Continue', 'planner');
    assert.equal(sends, 1);
    await restarted.stop();
  } finally { await f.close(); }
});

test("a roll that takes Queue's socket away returns a definite not-recorded retry and records nothing", async () => {
  const f = await askFixture();
  let client: Client | undefined;
  try {
    // The daemon rolled between sessions: this session's binding names a socket
    // path that no longer exists, so the request can never reach Queue.
    const rolledAway = join(f.dir, "rolled-away.sock");
    client = await boundAskClient(f, { socketPath: rolledAway });
    const result = await client.callTool({
      name: "nucleus_ask",
      arguments: { question: "Which route survives the roll?" },
    });
    assert.equal(result.isError, true);
    const text = String((result.content as { text: string }[])[0].text);
    assert.match(text, /Question not recorded/, "a connect failure is a definite not-recorded result");
    assert.match(text, /could not be reached to store it/);
    assert.match(text, /Retry the same nucleus_ask arguments/);
    assert.doesNotMatch(text, /unknown/i, "a pre-record transport failure is never unknown delivery");
    assert.equal(
      f.events("agent_ask").length,
      0,
      "nothing reached Queue, so no durable ask intent exists",
    );
  } finally {
    await client?.close();
    await f.close();
  }
});

test("a socket file whose listener died in a restart window is also a definite not-recorded retry", async () => {
  const f = await askFixture();
  let client: Client | undefined;
  try {
    // The daemon died without removing its socket file: the path exists and
    // connects fail (ENOTSOCK on macOS, ECONNREFUSED on Linux) before anything
    // is sent.
    const stalePath = join(f.dir, "stale-listener.sock");
    closeSync(openSync(stalePath, "w"));
    client = await boundAskClient(f, { socketPath: stalePath });
    const result = await client.callTool({
      name: "nucleus_ask",
      arguments: { question: "Which route survives the restart window?" },
    });
    assert.equal(result.isError, true);
    const text = String((result.content as { text: string }[])[0].text);
    assert.match(text, /Question not recorded/, "a dead-listener connect failure is definite, never unknown");
    assert.match(text, /Retry the same nucleus_ask arguments/);
    assert.doesNotMatch(text, /unknown/i);
    assert.equal(f.events("agent_ask").length, 0);
  } finally {
    await client?.close();
    await f.close();
  }
});

test("a response lost in flight never claims the question went unrecorded and sends the agent back to the identical ask", async () => {
  const f = await askFixture();
  let client: Client | undefined;
  let adversarial: Server | undefined;
  try {
    // An adversarial socket reads the ask, starts a 200 response, then dies
    // mid-body: the request was delivered and processed, and only the response
    // was lost — exactly a response-phase drop during a roll.
    const midDropPath = join(f.dir, "mid-drop.sock");
    adversarial = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial"');
      setTimeout(() => res.socket?.destroy(), 50);
    });
    await new Promise<void>((resolve) => adversarial!.listen(midDropPath, () => resolve()));
    client = await boundAskClient(f, { socketPath: midDropPath });
    const result = await client.callTool({
      name: "nucleus_ask",
      arguments: { question: "Which route survives a lost response?" },
    });
    assert.equal(result.isError, true);
    const text = String((result.content as { text: string }[])[0].text);
    assert.doesNotMatch(
      text,
      /not recorded/i,
      "the response died after delivery, so the ask cannot be claimed unrecorded",
    );
    assert.doesNotMatch(text, /unknown/i);
    assert.match(text, /response was lost/, "the classification names the lost response, not a delivery verdict");
    assert.match(text, /exactly the same arguments/, "the safe identical re-ask is the definite instruction");
  } finally {
    await client?.close();
    adversarial?.closeAllConnections();
    if (adversarial) await new Promise<void>((resolve) => adversarial!.close(() => resolve()));
    await f.close();
  }
});

test("a call silent past the in-turn budget states no delivery verdict and sends the agent back to the identical ask", async () => {
  const f = await askFixture();
  let client: Client | undefined;
  let silent: Server | undefined;
  try {
    // A socket that accepts the ask, reads it, and never answers: the client's
    // in-turn budget ends the call while the transport itself never fails, so
    // nothing observed can prove what Queue recorded — the socket is not Queue.
    const silentPath = join(f.dir, "silent.sock");
    silent = createServer((req) => {
      req.resume();
    });
    await new Promise<void>((resolve) => silent!.listen(silentPath, () => resolve()));
    client = await boundAskClient(f, { socketPath: silentPath, askTimeoutMs: 400 });
    const started = Date.now();
    const result = await client.callTool({
      name: "nucleus_ask",
      arguments: { question: "Which route survives a silent budget?" },
    });
    const elapsed = Date.now() - started;
    assert.equal(result.isError, true);
    const text = String((result.content as { text: string }[])[0].text);
    assert.ok(elapsed >= 350, `the client budget ended the call, not the transport (took ${elapsed} ms)`);
    assert.doesNotMatch(
      text,
      /Queue recorded/i,
      "a silent budget proves nothing about what Queue recorded",
    );
    assert.match(text, /unobserved/, "the budget says the ask's state is unobserved, not known");
    assert.doesNotMatch(text, /unknown/i);
    assert.match(text, /exactly the same arguments/, "the identical re-ask is the definite instruction");
    assert.match(text, /joins the same question when Nucleus holds it and records it when not/);
    assert.equal(f.events("agent_ask").length, 0, "nothing was recorded anywhere");
  } finally {
    await client?.close();
    silent?.closeAllConnections();
    if (silent) await new Promise<void>((resolve) => silent!.close(() => resolve()));
    await f.close();
  }
});

test("interleaved chat replies resolve neither ask and are never re-presented", async (t) => {
  const f = await askFixture();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.engine.resolution.delegatedAnswerWaitMs = 30_000;
  try {
    const calls: string[] = [];
    const adapter = f.engine.adapter as unknown as { askPlanner: (agent: string, input: { prompt: string; messageId: string }) => Promise<string> };
    adapter.askPlanner = async (_agent, input) => {
      calls.push(input.messageId);
      now += 30_001; // Close this delivery's window without racing a real timer.
      // Both interrupted sends see the other task's final message.
      const other = input.messageId.startsWith('ask-a') ? 'ask-b' : 'ask-a';
      return `Ask: ${other}\nAnswer: Stop\nReason: Another task.`;
    };
    const resolution = f.engine.resolution as unknown as {
      askBound: (task: typeof f.task, recipient: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string }, role: 'planner' | 'reviewer') => Promise<string | null>;
    };
    const otherTask = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Other task', originAgentId: 'origin', repoPath: join(f.dir, 'repo'), planningCommit: base, brief: { text: 'Other task brief' } }), 'host', 'brief', base);
    const send = (messageId: string) => resolution.askBound(messageId === 'ask-a' ? f.task : otherTask, 'planner', {
      prompt: 'Question: What next?', signal: new AbortController().signal, timeoutMs: 30_000, messageId,
    }, 'planner');
    const outcomes = await Promise.allSettled([send('ask-a'), send('ask-b')]);
    assert.deepEqual(outcomes.map(item => item.status), ['fulfilled', 'fulfilled']);
    assert.deepEqual(outcomes.map(item => item.status === 'fulfilled' ? item.value : undefined), [null, null]);
    assert.deepEqual(calls.sort(), ['ask-a', 'ask-b']);
    assert.equal(f.events('agent_ask_answered').length, 0);
    assert.equal(f.events('delegated_question_represented').length, 0);
  } finally { await f.close(); }
});

test('a matching delegated reply is applied once and task and reference lead the prompt', async () => {
  const f = await askFixture({ planner: 'Answer: Continue\nReason: It fits.' });
  try {
    registerPlanner(f, f.options.planner ?? null);
    const args = { question: 'What should the worker do?', choices: [] };
    const first = await f.receipt(args);
    const second = await f.receipt(args);
    assert.equal(first.answer, 'Continue — It fits.');
    assert.equal(second.answer, 'Continue — It fits.');
    assert.equal(f.events('agent_ask_answered').length, 1);
    assert.equal(f.delegated.planner.length, 1);
    assert.match(f.delegated.planner[0]!, /^Task: .*Ask fixture\nQuestion id: ns-agent-ask-/);
  } finally { await f.close(); }
});


test('chat output without a command leaves the ask pending without re-presentation', async () => {
  const f = await askFixture({ waitMs: 50 });
  try {
    registerPlanner(f, null);
    let calls = 0;
    const adapter = f.engine.adapter as unknown as { askPlanner: () => Promise<string> };
    adapter.askPlanner = async () => { calls++; return 'Ask: another-task\nAnswer: Stop\nReason: Wrong question.'; };
    const result = await f.receipt({ question: 'How should this task proceed?' });
    assert.equal(result.status, 'pending');
    assert.equal(calls, 2, 'the task planner and the project planner were both asked');
    assert.equal(f.events('agent_ask_answered').length, 0);
    await f.engine.resolution.resumeAskQuestions();
    assert.equal(calls, 2, 'a completed rung is a known miss, never re-asked');
  } finally { await f.close(); }
});


test('a reviewer answers with a command once and its chat output is ignored', async () => {
  const f = await askFixture();
  try {
    f.engine.resolution.delegatedAnswerWaitMs = 30_000;
    let count = 0;
    const adapter = f.engine.adapter as unknown as { askReviewer: (agent: string, input: { prompt: string }) => Promise<string> };
    adapter.askReviewer = async (agent, input) => {
      count++;
      answerFixturePrompt(f.engine.resolution, agent, input.prompt, 'Advice for this task');
      return 'Unrelated conversation output';
    };
    const resolution = f.engine.resolution as unknown as {
      askBound: (task: typeof f.task, recipient: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string }, role: 'reviewer') => Promise<string | null>;
    };
    const answer = await resolution.askBound(f.task, 'reviewer', { prompt: 'What next?', signal: new AbortController().signal, timeoutMs: 30_000, messageId: 'consult-a' }, 'reviewer');
    assert.equal(answer, 'Advice for this task');
    assert.equal(count, 1);
    assert.equal(f.events('delegated_question_represented').length, 0);
  } finally { await f.close(); }
});
