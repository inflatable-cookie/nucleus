/**
 * Step 8 of the UI lane: Planning carries a read-only legacy QA summary (the
 * QA runs tab and board QA cards are removed); decisions and native questions use
 * the shared controls. These tests pin the states the lane asks for (empty,
 * loading, error, long content, accessible labels), the touch and layout sizes,
 * and that every refusal and unknown-delivery case still reads as unconfirmed
 * rather than safe to retry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs } from "./support/render";
import { recentProjectActivity } from "./support/fakes";
import {
  type DecisionView,
  type Project,
  type ProjectQaRun,
} from "../shared/contracts";

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.ok(probe(), "the condition never settled");
}

const repository = { origin: "owner/consumer", path: "/consumer" };
const project = {
  key: "consumer-b-v2",
  name: "consumer-b-v2",
  repositories: [repository],
  primary: repository,
  visibility: "active",
  owner: {
    agentId: "thread",
    assignedBy: "operator",
    assignedAt: "2026-11-07T00:00:00.000Z",
    note: "",
  },
} as unknown as Project;
const at = new Date(Date.now() - 60_000).toISOString();

function qaRun(over: Partial<ProjectQaRun> = {}): ProjectQaRun {
  return {
    id: "qa-run",
    key: "owner/consumer",
    repository,
    state: "passed",
    baseBranch: "main",
    base: "a".repeat(40),
    argv: ["effigy", "qa"],
    digest: "b".repeat(64),
    exitCode: 0,
    durationMs: 1000,
    outputTail: "",
    startedAt: at,
    finishedAt: at,
    pid: null,
    admission: null,
    capacityWait: null,
    capacityUnavailable: false,
    steps: [],
    failedStep: null,
    interruptedStep: null,
    hostSettlement: null,
    escapedDescendants: [],
    cancelReason: null,
    logWriteErrors: [],
    ...over,
  } as ProjectQaRun;
}

// ---- Planning: the read-only latest legacy result ------------------------

const plan = {
  project: project.key,
  version: 1,
  entries: [
    {
      lane: "ui",
      note: "The lane note",
      horizon: "now",
      doneWhen: "The plan reads in one pass",
    },
  ],
  savedEntries: [
    {
      lane: "ui",
      note: "The lane note",
      horizon: "now",
      doneWhen: "The plan reads in one pass",
    },
  ],
  author: "operator",
  createdAt: at,
  done: [],
} as never;
const planSection = {
  project,
  latest: plan,
  saved: {
    ...(plan as object),
    entries: [
      {
        lane: "ui",
        note: "The lane note",
        horizon: "now",
        doneWhen: "The plan reads in one pass",
      },
    ],
  },
};

/** The plan column at either viewport, so the compact latest QA is proved at both. */
function renderPlan(props: Record<string, unknown>) {
  return import("../client/planning-panel").then(({ PlanningTab }) =>
    mount(
      h(PlanningTab, {
        // Recent activity keeps the project out of the Dormant group, so its plan is on screen.
        sections: [planSection],
        lanes: [],
        edits: {},
        selectedLane: "",
        step: "plan",
        busy: false,
        lanePanel: null,
        projectActivity: recentProjectActivity([project]),
        onStep() {},
        onOpenLane() {},
        onEdit() {},
        onSave() {},
        onCancel() {},
        ...props,
        c,
      } as never),
    ),
  );
}

test("Planning shows the latest legacy QA result in one line without board launch, cancel or Runs tab links", async () => {
  const { ProjectQaLatest } = await import("../client/planning-panel");
  const failed = qaRun({
    id: "qa-failed",
    state: "failed",
    failedStep: "teardown",
    outputTail: "teardown failed",
    steps: [{ name: "teardown", exitCode: 1 } as never],
  });
  const ui = mount(
    h(ProjectQaLatest, {
      project,
      runs: [failed],
      c,
    } as never),
  );
  assert.match(
    ui.text(),
    /teardown failed · consumer-b-v2/,
    "the concise failure leads with its project",
  );
  assert.match(
    ui.text(),
    /Failed · Finished/,
    "time and state follow the failure",
  );
  assert.doesNotMatch(
    ui.text(),
    /Commit a{12}/,
    "commit identity stays in project.qa.get rather than Planning",
  );
  assert.equal(
    ui.query("Retry teardown for consumer-b-v2"),
    undefined,
    "teardown retry stays off Planning",
  );
  assert.equal(
    ui.query("View the latest QA run for consumer-b-v2"),
    undefined,
    "no Runs tab link remains",
  );
});

test("a queued milestone run reads as waiting, never running, and Planning offers no launch, cancel or Runs link", async () => {
  const { ProjectQaLatest } = await import("../client/planning-panel");
  const queued = qaRun({
    id: "qa-queued",
    state: "queued",
    finishedAt: null,
    exitCode: null,
  });
  const ui = mount(h(ProjectQaLatest, { project, runs: [queued], c } as never));
  assert.match(ui.text(), /Queued · waiting, not running/);
  assert.doesNotMatch(
    ui.text(),
    /Running/,
    "a queued run is never described as running",
  );
  assert.equal(
    ui.query(/^Run full QA/),
    undefined,
    "milestone QA launching is retired",
  );
  assert.equal(
    ui.query(/^Cancel full QA/),
    undefined,
    "Planning offers no QA cancel",
  );
  assert.equal(
    ui.query("View the latest QA run for consumer-b-v2"),
    undefined,
    "no Runs tab link remains",
  );
});

test("Planning with no milestone run says so without telling people to launch from the board, and nothing links to a run that does not exist", async () => {
  const { ProjectQaLatest } = await import("../client/planning-panel");
  const ui = mount(h(ProjectQaLatest, { project, runs: [], c } as never));
  assert.match(
    ui.text(),
    /No legacy QA run recorded\. Milestone QA runs as a report-only task\./,
  );
  assert.doesNotMatch(ui.text(), /Run it from QA runs/);
  assert.equal(ui.query("View the latest QA run for consumer-b-v2"), undefined);
});

test("a first QA read is loading, not an empty result, and a failed read names itself with a retry", async () => {
  const { ProjectQaLatest } = await import("../client/planning-panel");
  const loading = mount(
    h(ProjectQaLatest, { project, loading: true, c } as never),
  );
  assert.match(loading.text(), /Loading the latest QA run…/);
  assert.doesNotMatch(
    loading.text(),
    /No legacy QA run recorded/,
    "an unread list is never presented as empty",
  );
  assert.equal(
    loading.query("View the latest QA run for consumer-b-v2"),
    undefined,
  );
  let retried = 0;
  const failedRead = mount(
    h(ProjectQaLatest, {
      project,
      error: "socket closed",
      onRetry: () => {
        retried++;
      },
      c,
    } as never),
  );
  assert.match(failedRead.text(), /Couldn’t load QA runs: socket closed/);
  assert.match(
    failedRead.text(),
    /Nothing here is an empty result until that read succeeds/,
  );
  assert.doesNotMatch(failedRead.text(), /No legacy QA run recorded/);
  failedRead.press("Retry the latest QA read for consumer-b-v2");
  assert.equal(retried, 1);
});

test("a refresh failure keeps the last QA result and says it may be out of date", async () => {
  const { ProjectQaLatest } = await import("../client/planning-panel");
  const passed = qaRun({ id: "qa-passed", state: "passed" });
  const ui = mount(
    h(ProjectQaLatest, {
      project,
      runs: [passed],
      error: "socket closed",
      c,
    } as never),
  );
  assert.match(ui.text(), /Passed/, "the last result read stays visible");
  assert.match(
    ui.text(),
    /Showing the last result read\. The QA runs could not be refreshed: socket closed\. It may be out of date\./,
  );
});

test("Planning names capacity waits, unavailable capacity and escaped descendants as alerts, not failures", async () => {
  const { ProjectQaLatest } = await import("../client/planning-panel");
  const waiting = qaRun({
    id: "qa-wait",
    state: "queued",
    finishedAt: null,
    capacityWait: { position: 3, since: at } as never,
  });
  const waitingUi = mount(
    h(ProjectQaLatest, {
      project,
      runs: [waiting],
      c,
    } as never),
  );
  assert.match(waitingUi.text(), /waiting for QA capacity \(position 3\)/);
  const unavailable = qaRun({
    id: "qa-cap",
    state: "failed",
    capacityUnavailable: true,
    failedStep: null,
  });
  const unavailableUi = mount(
    h(ProjectQaLatest, {
      project,
      runs: [unavailable],
      c,
    } as never),
  );
  assert.match(
    unavailableUi.text(),
    /QA capacity unavailable: .* This is not a QA failure\./,
  );
  const escaped = qaRun({
    id: "qa-escaped",
    state: "hold",
    escapedDescendants: [{ pid: 9, startIdentity: "x" }] as never,
  });
  const escapedUi = mount(
    h(ProjectQaLatest, {
      project,
      runs: [escaped],
      c,
    } as never),
  );
  assert.match(escapedUi.text(), /Escaped descendants not proven dead: 1/);
});

test("the latest QA sits in the project plan at the wide and the narrow size without launch or Runs tab controls", async () => {
  const failed = qaRun({ id: "qa-plan", state: "failed", failedStep: "qa" });
  for (const compact of [false, true]) {
    const ui = await renderPlan({
      compact,
      qaRuns: [failed],
    });
    const planBox = ui.get("Plan for consumer-b-v2");
    assert.ok(planBox, "the plan is on screen");
    const latest = ui.get("Latest QA for consumer-b-v2");
    assert.equal(
      latest.props.accessibilityLabel,
      "Latest QA for consumer-b-v2",
    );
    assert.match(
      ui.text(),
      /Latest QA[\s\S]*qa failed · consumer-b-v2/,
      "the concise failure and project sit inside the plan",
    );
    assert.equal(
      ui.query("View the latest QA run for consumer-b-v2"),
      undefined,
      "the retired Runs tab link is absent",
    );
    assert.equal(
      ui.query(/^Run full QA/),
      undefined,
      "the plan carries no QA launch control",
    );
  }
});

test("the plan reads a queued QA as waiting at both sizes, never as running", async () => {
  const queued = qaRun({
    id: "qa-plan-queued",
    state: "queued",
    finishedAt: null,
    exitCode: null,
  });
  for (const compact of [false, true]) {
    const ui = await renderPlan({ compact, qaRuns: [queued] });
    assert.match(ui.text(), /Queued · waiting, not running/);
    assert.doesNotMatch(
      ui.text(),
      /Running/,
      "a queued plan result never reads as running",
    );
  }
});

test("the plan keeps a loading QA read, a failed one and no run apart", async () => {
  const loading = await renderPlan({ qaLoading: true });
  assert.match(loading.text(), /Loading the latest QA run…/);
  assert.doesNotMatch(loading.text(), /No legacy QA run recorded/);
  const failedRead = await renderPlan({ qaError: "socket closed" });
  assert.match(failedRead.text(), /Couldn’t load QA runs: socket closed/);
  const empty = await renderPlan({ qaRuns: [] });
  assert.match(empty.text(), /No legacy QA run recorded/);
});

// ---- Decisions: the pill popover on the shared controls -------------------

const decision = (over: Partial<DecisionView> = {}): DecisionView => {
  const { askerLabel, ...rest } = over;
  return {
    id: "decision-1",
    version: 1,
    question: "Which branch do we cut?",
    headline: "Which branch do we cut?",
    choices: [
      { label: "main", consequence: "Use the stable branch." },
      { label: "branch", consequence: "Start from the feature branch." },
    ],
    recommended: "main",
    details: null,
    overtakenBy: [],
    context: null,
    options: ["main", "branch"],
    recommendation: "main",
    askedBy: {
      agentId: "agent-asker",
      project: { origin: "owner/decisions", path: "/fixture/decisions" },
    },
    links: { tasks: [], leads: [], papercuts: [] },
    askerLabel: askerLabel ?? "agent-asker",
    status: "open",
    answer: null,
    withdrawal: null,
    supersededBy: null,
    delivery: null,
    createdAt: "2026-09-29T10:00:00Z",
    updatedAt: "2026-09-29T10:00:00Z",
    versions: [],
    stale: false,
    projectKey: "decisions",
    ...rest,
  };
};
const popoverProps = () => ({
  theme: { colors: c },
  host: { id: "host", label: "Host" },
  layout: { compact: false, platform: "ios" as const },
  context: "agent" as const,
  workspaceId: "ws-1",
  agentId: "agent-asker",
  close: () => {},
});

/**
 * A client whose decision reads and answers are scripted, counting every read.
 * It serves no board snapshot, so every read here also proves a failed snapshot
 * falls back to a direct decision read (task 1030 keyed the read on it).
 */
function decisionClient(script: {
  reads: Array<DecisionView[] | Error | "pending">;
  answer?: Error;
}) {
  const state = { reads: 0, answers: [] as unknown[] };
  const client = {
    rpc: async (contract: { name: string }, input: Record<string, unknown>) => {
      if (contract.name === "decision.list") {
        state.reads++;
        const next =
          script.reads.length > 1 ? script.reads.shift()! : script.reads[0]!;
        if (next === "pending") return new Promise<DecisionView[]>(() => {});
        if (next instanceof Error) throw next;
        return next;
      }
      if (contract.name === "decision.answer") {
        if (script.answer) throw script.answer;
        state.answers.push(input);
        return decision({ status: "answered" });
      }
      throw new Error(`unexpected rpc ${contract.name}`);
    },
    openPanel() {},
  };
  return { client, state };
}

async function popover(client: unknown) {
  const { decisionPillPopover } = await import("../client/decision-pill");
  return decisionPillPopover({
    client: client as never,
    boardPanelId: "queue-board",
  });
}

test("a decision list that fails says so with a retry, and never reads as loading", async () => {
  const { client, state } = decisionClient({
    reads: [new Error("connection reset"), [decision()]],
  });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() =>
    ui.text().includes("Could not load decisions: connection reset"),
  );
  assert.doesNotMatch(
    ui.text(),
    /Loading decisions…/,
    "a failed read is not still loading",
  );
  ui.press("Retry loading open decisions");
  await settle(() => ui.text().includes("Which branch do we cut?"));
  assert.ok(state.reads >= 2, "the retry reads Queue again");
});

test("while the first read is in flight the popover says it is loading decisions", async () => {
  const { client } = decisionClient({ reads: ["pending"] });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  assert.match(ui.text(), /Loading decisions…/);
});

test("with no open decisions the popover says so, with no answer box to fill", async () => {
  const { client } = decisionClient({ reads: [[]] });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes("No open decisions."));
  assert.equal(ui.query(/Answer box:/), undefined);
});

test("the answer button names why it is unavailable, and the option rows meet the 44-point target", async () => {
  const { client } = decisionClient({ reads: [[decision()]] });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes("Which branch do we cut?"));
  assert.equal(
    ui.get(/Answer decision: Which branch do we cut\?/).props.accessibilityHint,
    "Write an answer or pick an option first",
  );
  assert.equal(ui.get(/^Use option: main/).props.style.minHeight, 44);
  ui.type(/Answer box: Which branch do we cut\?/, "Cut from main.");
  assert.equal(
    ui.get(/Answer decision: Which branch do we cut\?/).props.accessibilityHint,
    undefined,
    "an enabled button carries no reason",
  );
});

test("a refused answer is not confirmed, keeps the draft, and reloads the decision", async () => {
  const { client, state } = decisionClient({
    reads: [[decision()]],
    answer: new Error("Decision changed to version 2"),
  });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes("Which branch do we cut?"));
  ui.type(/Answer box: Which branch do we cut\?/, "Cut from main.");
  ui.press(/Answer decision: Which branch do we cut\?/);
  await settle(() =>
    ui.text().includes("Answer not confirmed: Decision changed to version 2"),
  );
  assert.match(
    ui.text(),
    /Check the decision before answering again; your draft is kept\./,
  );
  assert.equal(
    ui.query(/Answer box: Which branch do we cut\?/)?.props.value,
    "Cut from main.",
    "the draft survives the refusal",
  );
  assert.equal(state.answers.length, 0);
});

// ---- Native questions: the thread's own requests on the shared controls ---

test("a native question submit names why it is unavailable, and a failed answer is not confirmed", async () => {
  const { NativeQuestionAnswer, bindWebQuestions } = await import(
    "../client/native-questions"
  );
  const sent: unknown[] = [];
  const unbind = bindWebQuestions(async (agentId, requestId, answers) => {
    sent.push([agentId, requestId, answers]);
    throw new Error("Thread is no longer waiting");
  });
  try {
    const request = {
      id: "permission-1",
      questions: [
        {
          header: "Question 1",
          question: "Ship it?",
          options: ["release", "hold"],
        },
      ],
    };
    const ui = mount(
      h(NativeQuestionAnswer as never, {
        agentId: "worker",
        request,
        onAnswered() {},
        c,
      }),
    );
    assert.equal(
      ui.get("Submit answer").props.accessibilityState.disabled,
      true,
    );
    assert.equal(
      ui.get("Submit answer").props.accessibilityHint,
      "Answer every question first",
    );
    assert.equal(
      ui.get("Answer Question 1: release").props.accessibilityState.selected,
      false,
    );
    ui.press("Answer Question 1: release");
    assert.equal(
      ui.get("Answer Question 1: release").props.accessibilityState.selected,
      true,
    );
    ui.press("Submit answer");
    await settle(() =>
      ui.text().includes("Answer not confirmed: Thread is no longer waiting"),
    );
    assert.match(ui.text(), /Check the question before answering again\./);
    assert.deepEqual(sent, [
      ["worker", "permission-1", { "Question 1": "release" }],
    ]);
  } finally {
    unbind();
  }
});
