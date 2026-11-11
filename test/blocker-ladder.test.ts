import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  blockerCauseId,
  escalationAnswerControl,
  escalationVerbChoices,
  escalationWaitDetail,
  findOpenPlannerEscalation,
  parseAnsweredText,
  parseEscalationReply,
  plannerEscalationChoicesFor,
  plannerEscalationQuestion,
  plannerEscalations,
  reviewerAskPrompt,
  reviewerConsultQuestion,
  reviewerConsults,
  revisionCapCauseId,
  PLANNER_ESCALATION_CHOICES,
} from "../core/questions/blocker-ladder";
import { nativeDelegationPrompt } from "../core/questions/question-delegation";
import { deriveTaskTelemetry } from "../core/telemetry/telemetry";
import {
  workerPrompt,
  runPrompt,
  RESPONSIBLE_BLOCKER_LADDER_RULE,
} from "../core/dispatch/prompts";
import { Decisions } from "../core/planning/decisions";
import { Store } from "../core/store/store";
import {
  REVISION_BUDGET,
  submissionSchema,
  taskControlInputSchema,
  type Completion,
  type Run,
  type Task,
} from "../shared/contracts";
import { fixture, head, tick } from "./support/responsible-lifecycle-fixture";

const until = async (pass: () => boolean, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!pass()) {
    if (Date.now() >= deadline) throw new Error("condition never settled");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

/**
 * Spec 058 slice 17 (task 584): the blocker ladder — worker, reviewer second
 * opinion, planner automatically, Tom last. A stuck responsible task never
 * reaches the operator through an operator-first stop: a blocked report gets one
 * reviewer consult per cause whose advice continues the same worker; a still-
 * blocked or external cause opens one planner escalation as a delegated
 * decision; a repeated identical block attaches to the open escalation; only an
 * operator-only kind or an explicit "cannot decide" reaches Tom; a provider
 * failure keeps the ordinary replacement.
 */

const blocked = (summary: string, extra: Partial<Completion> = {}) =>
  ({ status: "blocked", summary, head, ...extra }) as unknown as Completion;

test("a blocker cause is stable across wording whitespace and re-reports, and differs across tasks and text", () => {
  const cause = blockerCauseId(
    "task-1",
    blocked("Live-state inventory gate failed"),
  );
  assert.equal(
    cause,
    blockerCauseId("task-1", blocked("Live-state   inventory  gate failed\n")),
  );
  assert.notEqual(
    cause,
    blockerCauseId("task-2", blocked("Live-state inventory gate failed")),
  );
  assert.notEqual(
    cause,
    blockerCauseId("task-1", blocked("A different blocker")),
  );
  assert.notEqual(
    cause,
    blockerCauseId(
      "task-1",
      blocked("Live-state inventory gate failed", { sourceApproved: true }),
    ),
  );
  assert.equal(
    revisionCapCauseId("task-1", 6),
    revisionCapCauseId("task-1", 6),
  );
  assert.notEqual(
    revisionCapCauseId("task-1", 6),
    revisionCapCauseId("task-1", 7),
  );
});

test("an escalation prompt contains the question and choices without standing rules", () => {
  const prompt = nativeDelegationPrompt("planner", { question: "Which route?", choices: ["Continue", "Hold"], context: ["Large task context"] });
  assert.match(prompt, /Question for the project planner: Which route\?/);
  assert.match(prompt, /- Continue\n- Hold/);
  assert.match(prompt, /decision: "operator"/);
  assert.match(prompt, /Task context:\n {2}Large task context/, "bug 25: delegates read the task context");
  assert.doesNotMatch(prompt, /Ask:|Choice:|Reason:|approve by default/);
});

test("an escalation delegate reply parses in its three shapes and maps onto ordinary verbs", () => {
  const choices = PLANNER_ESCALATION_CHOICES;
  assert.deepEqual(
    parseEscalationReply(
      "Choice: Return to the worker with a new approach\nReason: Try the staging tenant",
      choices,
    ),
    {
      kind: "choice",
      choice: "Return to the worker with a new approach",
      reason: "Try the staging tenant",
    },
  );
  assert.deepEqual(
    parseEscalationReply(
      "Answer: Route around the gate with the replay fixture\nReason: it is isolated",
      choices,
    ),
    {
      kind: "answer",
      answer: "Route around the gate with the replay fixture",
      reason: "it is isolated",
    },
  );
  assert.deepEqual(
    parseEscalationReply(
      "Decision: operator\nReason: This abandons approved work.",
      choices,
    ),
    { kind: "operator", reason: "This abandons approved work." },
  );
  assert.equal(
    parseEscalationReply("Choice: Not one of the choices\nReason: no", choices),
    null,
  );
  assert.equal(
    parseEscalationReply("Choice: Stop and keep the work", choices),
    null,
    "a choice without a reason is no answer",
  );
  assert.equal(parseEscalationReply(null, choices), null);

  assert.deepEqual(escalationAnswerControl("Stop and keep the work"), {
    action: "stop",
  });
  assert.deepEqual(escalationAnswerControl("Leave it waiting"), {
    action: "wait",
  });
  const work = escalationAnswerControl(
    "Return to the worker with a new approach — try the staging tenant",
  );
  assert.equal(work.action, "work");
  assert.equal(
    work.action === "work" && work.instruction,
    "try the staging tenant",
  );
  const free = escalationAnswerControl(
    "Route around the gate with the replay fixture",
  );
  assert.equal(free.action, "work");
  assert.equal(
    free.action === "work" && free.instruction,
    "Route around the gate with the replay fixture",
  );
});

test("ladder event readers fence sends and find the open escalation for a repeated cause", () => {
  const cause = "c".repeat(64);
  const base = (id: number, kind: string, detail: string) => ({
    id,
    taskId: "t",
    at: "2026-11-02T00:00:00Z",
    kind,
    detail,
  });
  const events = [
    base(
      1,
      "reviewer_consult",
      `consult-1: cause ${cause}; run rev-1; question abc (100 chars)`,
    ),
    base(
      2,
      "reviewer_consult_payload",
      `consult-1: ${JSON.stringify({ id: "consult-1", cause, runId: "rev-1", reviewer: "agent-r", question: "What now?" })}`,
    ),
    base(3, "reviewer_consult_sent", "consult-1: sent to reviewer agent-r"),
    base(
      4,
      "reviewer_consult_answered",
      "consult-1: answered by reviewer agent-r: Try the clean fixture first.",
    ),
    base(
      5,
      "planner_escalation",
      `esc-1: cause ${cause}; run rev-2; question def (90 chars); options ${PLANNER_ESCALATION_CHOICES.join(" | ")}`,
    ),
    base(
      6,
      "planner_escalation_attached",
      "esc-1: attach run rev-3; other-cause",
    ),
  ];
  const consults = reviewerConsults(events);
  assert.equal(consults.length, 1);
  assert.equal(consults[0]!.id, "consult-1");
  assert.equal(consults[0]!.cause, cause);
  assert.equal(consults[0]!.reviewer, "agent-r");
  assert.equal(consults[0]!.answered, true);
  assert.equal(consults[0]!.advice, "Try the clean fixture first.");
  const escalations = plannerEscalations(events);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0]!.id, "esc-1");
  assert.equal(escalations[0]!.answered, false);
  assert.equal(
    findOpenPlannerEscalation(events, cause)?.id,
    "esc-1",
    "the open escalation for the same cause is found",
  );
  assert.equal(findOpenPlannerEscalation(events, `${cause}x`), null);
  assert.equal(
    parseAnsweredText("esc-1: answered by planner p1: yes — because"),
    "yes — because",
  );
});

test("worker and revision prompts name the ladder and the reviewer ask target", () => {
  const store = new Store(":memory:");
  try {
    const responsible = store.update(store.insert(
      submissionSchema.parse({ submissionId: randomUUID(), title: "Ladder prompt", repoPath: "/repo",
        planningCommit: "a".repeat(40), brief: { text: "Ladder brief\n" }, originAgentId: "origin" }),
      "host", "brief", "a".repeat(40)).id, {
      runId: "initial",
      workspaceId: "ws",
      directory: "/wt",
      profile: {
        id: "p",
        name: "P",
        provider: "codex",
        model: "m",
        notes: "",
        available: true,
        problem: "",
        supportedThinking: [],
      },
    }) as Task;
    const runOf = (task: Task, role: Run["role"]): Run =>
      ({
        id: `run-${role}`,
        taskId: task.id,
        role,
        head,
        status: "running",
        createdAt: "2026-11-02T00:00:00Z",
        instruction: "Continue",
      }) as unknown as Run;
    const worker = workerPrompt(responsible, true);
    assert.ok(
      worker.includes(RESPONSIBLE_BLOCKER_LADDER_RULE),
      "the worker prompt names the ladder",
    );
    assert.match(worker, /Blocker ladder \(Spec 058\)/);
    assert.match(worker, /target: "reviewer"/);
    const revision = runPrompt(
      responsible,
      runOf(responsible, "revision"),
      "/helper",
      "/ticket",
      true,
    );
    assert.ok(
      revision.includes(RESPONSIBLE_BLOCKER_LADDER_RULE),
      "the revision prompt names the ladder",
    );
    const reviewer = runPrompt(
      responsible,
      runOf(responsible, "reviewer"),
      "/helper",
      "/ticket",
      true,
    );
    assert.ok(
      !reviewer.includes(RESPONSIBLE_BLOCKER_LADDER_RULE),
      "the reviewer prompt carries the ladder through the ask rule only",
    );
  } finally {
    store.close();
  }
});

test("late consult advice cannot override a control or revive a cancelled task", async () => {
  for (const phase of ["changes_requested", "cancelled"] as const) {
    const f = fixture({ responsible: true });
    f.engine.resolution.delegatedAnswerWaitMs = 30_000;
    let release!: (value: string) => void;
    const gate = new Promise<string>(resolve => { release = resolve; });
    let sent = false;
    (f.adapter as unknown as Record<string, unknown>).askReviewer = async () => { sent = true; return gate; };
    try {
      await f.reviews(1);
      await f.engine.wake();
      await f.report("blocked");
      await until(() => sent);
      const current = f.current();
      f.store.update(current.id, { phase }, "operator_control", "move", current.version);
      const controlled = f.current();
      release("Late advice");
      await tick();
      await tick();
      assert.deepEqual(f.current(), controlled);
      assert.equal(f.events("reviewer_consult_continued").length, 0);
    } finally { await f.close(); }
  }
});

test("a blocked revision consults the retained reviewer once and continues the same worker with the advice", async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 30_000;
  const consults: { reviewer: string; prompt: string }[] = [];
  let releaseConsult: (advice: string) => void = () => {};
  const gate = new Promise<string>((resolve) => {
    releaseConsult = resolve;
  });
  (f.adapter as unknown as Record<string, unknown>).askReviewer = async (
    reviewer: string,
    input: { prompt: string },
  ) => {
    consults.push({ reviewer, prompt: input.prompt });
    return gate;
  };
  try {
    await f.reviews(1);
    await f.engine.wake();
    assert.equal(f.run().role, "revision");
    await f.report("blocked");
    await until(() => consults.length > 0);
    assert.equal(consults.length, 1, "exactly one consult turn");
    assert.equal(
      consults[0]!.reviewer,
      f.current().resolution.reviewerAgentId,
      "the consult reaches the retained reviewer",
    );
    assert.match(
      consults[0]!.prompt,
      /Second opinion \(consult, not a review round\)/,
    );
    assert.match(consults[0]!.prompt, /revision reported blocked/);
    assert.equal(f.events("reviewer_consult").length, 1);
    assert.equal(f.events("reviewer_consult_sent").length, 1);
    assert.equal(f.events("reviewer_consult_answered").length, 0);
    assert.equal(
      f.current().resolution.stop?.reason,
      "escalated",
      "the task waits inside the ladder while the consult is out",
    );
    assert.match(
      f.current().resolution.stop!.detail,
      /Waiting with the retained reviewer/,
    );
    assert.equal(
      f.current().resolution.currentRunId,
      null,
      "the ladder ends the completed run's lease",
    );
    releaseConsult!(
      "Set TMPDIR to a fresh scratch directory and rerun the isolation gate; the gate failure is environmental, not source.",
    );
    await until(() => f.events("reviewer_consult_answered").length > 0);
    assert.match(
      f.events("reviewer_consult_answered")[0]!.detail,
      /answered by reviewer/,
    );
    assert.equal(f.events("reviewer_consult_continued").length, 1);
    // The advice returns into the same worker thread, which continues.
    await f.settle(2);
    assert.equal(
      f.run().role,
      "revision",
      "the same retained worker continues",
    );
    assert.match(f.run().instruction ?? "", /reviewer's advice/i);
    assert.match(f.run().instruction ?? "", /fresh scratch directory/);
    assert.equal(
      f.run().revisionCause,
      "consult",
      "a consult continuation consumes no semantic review round",
    );
    assert.equal(
      f.events("planner_escalation").length,
      0,
      "the consult alone does not escalate",
    );
    assert.equal(f.delegated.planner.length, 0);
    assert.equal(
      f.coordinatorRuns().length,
      0,
      "no coordinator anywhere in the ladder",
    );
    // A later consult continuation does not consume a review round: the next
    // ready_for_review re-review stays the retained reviewer's ordinary turn.
    await f.report("ready_for_review");
    await f.settle(2);
    assert.equal(f.run().role, "reviewer");
    assert.equal(
      f.current().resolution.revisionRuns,
      1,
      "the consult continuation added no revision round",
    );
  } finally {
    await f.close();
  }
});

test("a still-blocked run after the consult opens one planner escalation and its delegated answer applies through the ordinary verbs", async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 30_000;
  const consults: unknown[] = [];
  (f.adapter as unknown as Record<string, unknown>).askReviewer = async () => {
    consults.push(1);
    return "Rerun the gate with a clean TMPDIR.";
  };
  let releasePlanner: (reply: string) => void = () => {};
  const plannerGate = new Promise<string>((resolve) => {
    releasePlanner = resolve;
  });
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async (
    _planner: string,
    input: { prompt: string },
  ) => {
    f.delegated.planner.push(input);
    return plannerGate;
  };
  try {
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
    await f.reviews(1);
    await f.engine.wake();
    await f.report("blocked");
    await until(() => f.events("reviewer_consult_answered").length > 0);
    await f.settle(2);
    assert.equal(f.run().role, "revision");
    // Rewording the blocker after a consult must not start another consult.
    const reportingAgent = f.run().agentId;
    await f.report("blocked", {
      summary: "A reworded blocker remains unresolved",
    });
    assert.equal(consults.length, 1);
    await until(() => f.delegated.planner.length > 0);
    assert.equal(
      f.events("planner_escalation").length,
      1,
      "one planner escalation",
    );
    assert.equal(f.delegated.planner.length, 1, "the planner was asked once");
    assert.equal(f.delegated.planner[0]!.sourceAgentId, reportingAgent);
    assert.match(
      f.delegated.planner[0]!.prompt,
      /clean TMPDIR/i,
      "the escalation carries the reviewer's view",
    );
    assert.match(
      f.delegated.planner[0]!.prompt,
      /Return to the worker with a new approach/,
    );
    assert.equal(f.current().resolution.stop?.reason, "escalated");
    assert.match(
      f.current().resolution.stop!.detail,
      /Waiting with the planner/,
    );
    releasePlanner!(
      "Choice: Return to the worker with a new approach\nReason: Try the staging tenant for the isolation gate.",
    );
    await until(() => f.events("planner_escalation_answered").length > 0);
    assert.match(
      f.events("planner_escalation_answered")[0]!.detail,
      /answered by planner planner-1/,
    );
    // The delegated answer applies through the ordinary verbs: move to work, delegated authority.
    await until(() => f.events("planner_escalation_applied").length > 0);
    assert.match(
      f.events("planner_escalation_applied")[0]!.detail,
      /returned to the worker/,
    );
    await f.settle(3);
    assert.equal(
      f.run().role,
      "revision",
      "the planner's direction continues the same retained worker",
    );
    assert.match(f.run().instruction ?? "", /staging tenant/);
    assert.equal(
      f.run().revisionCause,
      "consult",
      "the delegated continuation consumes no semantic round",
    );
    const ownerControl = f.events("owner_control").at(-1);
    assert.ok(ownerControl, "the applied verb records its control");
    assert.match(
      ownerControl!.detail,
      /"caller":"planner-1"/,
      "the delegated answer records its answering agent",
    );
  } finally {
    await f.close();
  }
});

test("a repeated identical block joins the open escalation instead of another turn or another ask", async () => {
  const f = fixture({ responsible: true });
  f.engine.identifyOriginHost = async () => 'host';
  (f.adapter as unknown as Record<string, unknown>).askReviewer = async () =>
    "Try the clean fixture.";
  let plannerAsks = 0;
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async (
    _planner: string,
    input: { prompt: string },
  ) => {
    plannerAsks += 1;
    f.delegated.planner.push(input);
    // No answer in time: the escalation stays open, so the repeated block can attach.
    await new Promise(() => {});
  };
  try {
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
    const task = f.current();
    const completion = blocked("Private admission isolation remains unproved");
    const first = await f.engine.resolution.responsibleBlockerLadder(task, {
      source: "revision",
      runId: "rev-1",
      completion,
    });
    assert.equal(first, true, "the ladder owns the park");
    await until(() => f.events("planner_escalation").length > 0 && plannerAsks > 0);
    const escalations = plannerEscalations(f.store.eventsAll(task.id));
    assert.equal(escalations.length, 1);
    assert.equal(plannerAsks, 1, "the planner was asked once");
    assert.match(
      f.current().resolution.stop!.detail,
      /Waiting with the planner/,
    );
    // A second run ends blocked on the same cause while the escalation is open.
    const second = await f.engine.resolution.responsibleBlockerLadder(
      f.store.task(task.id),
      { source: "revision", runId: "rev-2", completion },
    );
    assert.equal(second, true);
    const events = f.store.eventsAll(task.id);
    assert.equal(plannerEscalations(events).length, 1, "no second escalation");
    assert.equal(plannerAsks, 1, "no second ask");
    assert.match(
      events.findLast((event) => event.kind === "planner_escalation_attached")!
        .detail,
      /attach run rev-2/,
    );
    assert.match(f.current().resolution.stop!.detail, /joined escalation/);
    // A different cause is its own episode, not an attachment.
    await f.engine.resolution.responsibleBlockerLadder(f.store.task(task.id), {
      source: "revision",
      runId: "rev-3",
      completion: blocked("Live-state inventory gate failed"),
    });
    assert.equal(
      plannerEscalations(f.store.eventsAll(task.id)).length,
      2,
      "a different cause opens its own escalation",
    );
  } finally {
    await f.close();
  }
});

test("ordinary move settles an open escalation and ignores a late planner reply", async () => {
  const f = fixture({ responsible: true });
  let reply: (text: string) => void = () => {};
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async () =>
    new Promise<string>((resolve) => {
      reply = resolve;
    });
  try {
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
    await f.reviews(1);
    await f.engine.wake();
    await f.report("blocked", {
      summary: "An external environment gate failed",
    });
    await until(() => f.events("planner_escalation_sent").length > 0);
    assert.equal(f.events("planner_escalation").length, 1);
    assert.match(f.events("planner_escalation_question")[0]!.detail, /external environment gate failed/i);
    const task = f.current();
    await f.engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: task.version,
        action: "move",
        to: "work",
        reason: "The gate has been repaired",
        instruction: "Continue with the repaired gate",
      }),
    );
    assert.equal(
      plannerEscalations(f.store.eventsAll(task.id))[0]!.answered,
      true,
    );
    reply("Decision: operator\nReason: Too late to decide.");
    await tick();
    assert.equal(f.events("planner_escalation_decision").length, 0);
  } finally {
    await f.close();
  }
});

test("a planner verb closes an open question after its stop changed", async () => {
  const f = fixture({ responsible: true });
  let reply: (text: string) => void = () => {};
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async () => new Promise<string>(resolve => { reply = resolve; });
  try {
    f.store.upsertProject({ key: "app", name: "App", repositories: [{ origin: null, path: join(f.dir, "repo") }] });
    f.store.setProjectPlanner({ key: "app", agentId: "planner-1", setBy: "operator" });
    await f.reviews(1); await f.engine.wake();
    await f.report("blocked", { summary: "An external gate failed" });
    await until(() => f.events("planner_escalation_sent").length > 0);
    const prior = f.current();
    f.store.update(prior.id, { resolution: { ...prior.resolution, stop: null } });
    const current = f.current();
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: current.id, version: current.version,
      action: "move", to: "work", reason: "The gate was repaired", instruction: "Continue" }));
    assert.equal(plannerEscalations(f.store.eventsAll(current.id))[0]!.answered, true);
    reply("Decision: operator\nReason: Too late.");
    await tick();
    assert.equal(f.events("planner_escalation_decision").length, 0);
  } finally { await f.close(); }
});

test("a missing reviewer is selected and retained for the consult", async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 30_000;
  const selected: string[] = [];
  Object.assign(f.adapter, {
    createConsultReviewer: async (
      _task: Task,
      input: { profile: { id: string } },
    ) => {
      selected.push(input.profile.id);
      return { id: "new-reviewer", workspaceId: "workspace" };
    },
    askReviewer: async (_reviewer: string, input: { prompt: string }) => {
      assert.match(input.prompt, /Second opinion/);
      return "Try the smaller fixture.";
    },
  });
  try {
    const task = f.current();
    await f.engine.resolution.responsibleBlockerLadder(task, {
      source: "worker",
      runId: null,
      completion: blocked("I cannot reconcile these two approaches"),
    });
    await until(() => f.events("reviewer_consult_answered").length > 0);
    assert.equal(selected.length, 1);
    assert.equal(f.current().resolution.reviewerProfile?.id, selected[0]);
    assert.equal(f.current().resolution.reviewerAgentId, "new-reviewer");
    assert.equal(f.events("reviewer_consult_answered").length, 1);
    assert.equal(f.events("planner_escalation").length, 0);
  } finally {
    await f.close();
  }
});

test('a new reviewer consult records the task host and accepts its answer with multiple hosts', async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 30_000;
  f.store.setMeta('hostRegistry', [{ id: 'host', endpoint: 'a' }, { id: 'other', endpoint: 'b' }]);
  let online = false;
  const calls: string[] = [];
  f.engine.hostAvailable = id => id !== 'host' || online;
  f.engine.identifyOriginHost = async id => id === 'new-reviewer' ? 'host' : undefined;
  Object.assign(f.adapter, {
    createConsultReviewer: async () => { calls.push(`create:${f.engine.activeHostId}`); online = false; return { id: 'new-reviewer', workspaceId: 'workspace' }; },
    askReviewer: async (reviewer: string, input: { messageId: string }) => {
      calls.push(`ask:${f.engine.activeHostId}`);
      await f.engine.resolution.answerDelegatedQuestionFromHost({ questionId: input.messageId, answer: 'Try the fixture', reason: 'Within scope' }, reviewer);
      return null;
    },
  });
  try {
    await f.engine.resolution.responsibleBlockerLadder(f.current(), { source: 'worker', runId: null, completion: blocked('Need a second opinion') });
    await tick(); await tick();
    assert.deepEqual(calls, []);
    assert.equal(f.events('reviewer_consult_unknown').length, 0);
    online = true;
    await f.engine.resolution.resumeAskQuestions();
    await until(() => calls.length === 1 && f.engine.resolution.routingConsults.size === 0);
    assert.equal(f.current().resolution.reviewerAgentId, 'new-reviewer');
    assert.equal(f.events('reviewer_consult_unknown').length, 0);
    online = true;
    await f.engine.resolution.resumeAskQuestions();
    await until(() => f.events('reviewer_consult_answered').length > 0);
    assert.deepEqual(calls, ['create:host', 'ask:host']);
    const consult = reviewerConsults(f.store.eventsAll(f.submitted.id))[0]!;
    const delivery = f.store.eventsAll(`delegation:ns-reviewer-consult-${consult.id}`).find(event => event.kind === 'delegated_delivery')!;
    assert.equal(JSON.parse(delivery.detail).hostId, 'host');
  } finally { await f.close(); }
});

test("a missing retained reviewer records the fallback before asking the planner", async () => {
  const f = fixture({ responsible: true });
  try {
    const task = f.current();
    assert.equal(task.resolution.reviewerAgentId, null);
    await f.engine.resolution.responsibleBlockerLadder(task, {
      source: "worker",
      runId: null,
      completion: blocked("I cannot reconcile these two approaches"),
    });
    assert.match(
      f.events("reviewer_consult_unavailable")[0]!.detail,
      /adapter unavailable/,
    );
    assert.equal(f.events("reviewer_consult").length, 0);
    assert.equal(f.events("planner_escalation").length, 1);
  } finally {
    await f.close();
  }
});

test("a cause genuinely outside the task escalates straight to the planner without a consult", async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 10;
  let reviewerAsks = 0;
  (f.adapter as unknown as Record<string, unknown>).askReviewer = async () => {
    reviewerAsks += 1;
    return "advice";
  };
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async (
    _planner: string,
    input: { prompt: string },
  ) => {
    f.delegated.planner.push(input);
    return "Choice: Leave it waiting\nReason: The shared gate belongs to another task.";
  };
  try {
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
    await f.reviews(1);
    await f.engine.wake();
    await f.report("blocked", {
      summary: "No external blocker; a guard refused before target observation",
      cause: { kind: 'external', name: 'guard refusal before target observation' },
    });
    await until(() => f.events("planner_escalation").length > 0);
    assert.equal(
      reviewerAsks,
      0,
      "an external cause never needs a second opinion",
    );
    assert.equal(f.events("reviewer_consult").length, 0);
    assert.equal(f.events("planner_escalation").length, 1);
    assert.equal(f.events("non_delivery").length, 0, "a structured external refusal cannot arm push-back or replacement");
    await until(() => f.events("planner_escalation_unknown").length > 0);
    assert.equal(f.events("planner_escalation_answered").length, 0);
    assert.equal(plannerEscalations(f.store.eventsAll(f.current().id))[0]!.answered, false);
    assert.match(f.current().resolution.stop!.detail, /planner/i);
    assert.equal(
      f.current().resolution.currentRunId,
      null,
      "a wait decision starts no worker turn",
    );
  } finally {
    await f.close();
  }
});

test("a planner that explicitly cannot decide reaches Tom, and the board answer settles the escalation", async () => {
  const f = fixture({ responsible: true });
  // The fixture's default window is 10 ms, which can close before this immediate answer on a busy host.
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async (
    _planner: string,
    input: { prompt: string },
  ) => {
    f.delegated.planner.push(input);
    return "Decision: operator\nReason: This changes the task's product scope.";
  };
  try {
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
    await f.reviews(1);
    await f.engine.wake();
    await f.report("blocked");
    await until(() => f.events("planner_escalation_decision_linked").length > 0);
    assert.match(
      f.events("planner_escalation_decision")[0]!.detail,
      /cannot decide/,
    );
    assert.match(
      f.current().resolution.stop!.detail,
      /Waiting with the operator/,
    );
    const decisionId = f
      .events("planner_escalation_decision_linked")[0]!
      .detail.match(/decision (\S+)/)![1]!;
    const decision = new Decisions(f.store).get({ id: decisionId });
    assert.equal(
      decision.status,
      "open",
      "one Spec 032 decision carries the escalation to the operator",
    );
    assert.match(decision.question, /is stuck/);
    // The operator answers on the board; the recovery sweep settles the escalation.
    new Decisions(f.store).answer({
      id: decisionId,
      version: decision.version,
      answer:
        "Return to the worker with a new approach — treat the admission premise as out of scope",
      answeredBy: "operator (board)",
      relayed: false,
      note: "",
    });
    await f.engine.resolution.resumeAskQuestions();
    await until(() => f.events("planner_escalation_answered").length > 0);
    assert.match(
      f.events("planner_escalation_answered")[0]!.detail,
      /answered by operator \(board\)/,
    );
    await until(() => f.events("planner_escalation_applied").length > 0);
    assert.match(
      f.events("planner_escalation_applied")[0]!.detail,
      /returned to the worker/,
    );
    await f.settle(3);
    assert.equal(f.run().role, "revision");
    assert.match(f.run().instruction ?? "", /out of scope/);
  } finally {
    await f.close();
  }
});

test("a provider failure never enters the ladder and keeps its replacement path", async () => {
  const f = fixture({ responsible: true });
  let consults = 0;
  (f.adapter as unknown as Record<string, unknown>).askReviewer = async () => {
    consults += 1;
    return "advice";
  };
  try {
    await f.reviews(1);
    await f.engine.wake();
    await f.report("blocked", {
      providerUnavailable: true,
      summary: "Subscription group author is exhausted",
    });
    await f.settle(2);
    assert.equal(consults, 0, "a provider failure is not a ladder blocker");
    assert.equal(f.events("reviewer_consult").length, 0);
    assert.equal(f.events("planner_escalation").length, 0);
    assert.equal(
      f.current().phase,
      "blocked",
      "the ordinary provider path parks the lane",
    );
  } finally {
    await f.close();
  }
});

test("the revision cap escalates to the planner instead of the owner, and the delegated answer returns the worker", async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 30_000;
  let releasePlanner: (reply: string) => void = () => {};
  const plannerGate = new Promise<string>((resolve) => {
    releasePlanner = resolve;
  });
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async (
    _planner: string,
    input: { prompt: string },
  ) => {
    f.delegated.planner.push(input);
    return plannerGate;
  };
  try {
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
    // Jump to the cap: the allowance is consumed up to the budget, then one live round parks.
    f.store.update(f.submitted.id, {
      resolution: { ...f.current().resolution, revisionRuns: REVISION_BUDGET },
    });
    await f.engine.wake();
    assert.equal(f.run().role, "reviewer");
    await f.report("changes_required");
    await f.settle(2);
    assert.doesNotMatch(f.current().reason, /project owner disposition/);
    assert.equal(f.events("revision_budget_exhausted").length, 1);
    assert.match(
      f.current().resolution.stop!.detail,
      /Waiting with the planner/,
    );
    assert.equal(
      f.events("planner_escalation").length,
      1,
      "the cap escalates once",
    );
    await until(() => f.delegated.planner.length > 0);
    assert.match(
      f.delegated.planner[0]!.prompt,
      /exhausted its revision budget after 6 review rounds/,
    );
    assert.match(
      f.delegated.planner[0]!.prompt,
      /Latest review findings: reviewer reported changes_required/i,
    );
    releasePlanner!(
      "Choice: Return to the worker with a new approach\nReason: Rebuild the isolation proof on the replay fixture.",
    );
    await until(() => f.events("planner_escalation_answered").length > 0);
    await until(() => f.events("planner_escalation_applied").length > 0);
    await f.settle(3);
    assert.equal(
      f.run().role,
      "revision",
      "the planner's cap answer continues the same retained worker",
    );
    assert.match(f.run().instruction ?? "", /replay fixture/);
    assert.equal(f.run().revisionCause, "consult");
  } finally {
    await f.close();
  }
});

test("the joint question on the third non-converging round is answered by the planner first", async () => {
  const f = fixture({
    responsible: true,
    delegates: {
      planner:
        "Choice: Continue the current approach\nReason: The findings are incremental.",
    },
  });
  try {
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
    await f.reviews(3);
    await f.settle(2);
    assert.equal(
      f.asks.length,
      1,
      "one joint question on the task's own thread",
    );
    await until(() => f.events("responsible_question_answered").length > 0);
    assert.equal(
      f.delegated.planner.length,
      1,
      "the planner answered before any operator",
    );
    assert.equal(f.delegated.deciders.length, 0);
    assert.match(
      f.events("responsible_question_answered")[0]!.detail,
      /delegated planner planner-1/,
    );
    await f.settle(3);
    assert.equal(
      f.sends.filter((item) => item.role === "revision").length,
      3,
      "the answered question releases the next round",
    );
    assert.equal(f.coordinatorRuns().length, 0);
  } finally {
    await f.close();
  }
});

test("nucleus_ask with a reviewer target consults the retained reviewer mid-turn and records the advice", async () => {
  const f = fixture({ responsible: true });
  const consults: { reviewer: string; prompt: string }[] = [];
  (f.adapter as unknown as Record<string, unknown>).askReviewer = async (
    reviewer: string,
    input: { prompt: string },
  ) => {
    consults.push({ reviewer, prompt: input.prompt });
    return "Keep the module boundary; patch the gate in place.";
  };
  try {
    await f.reviews(1);
    await f.engine.wake();
    const run = f.run();
    assert.equal(run.role, "revision");
    const receipt = await f.engine.resolution.agentAsk(
      {
        eventId: randomUUID(),
        taskId: f.submitted.id,
        runId: run.id,
        question: "Should I restructure the module or patch the gate in place?",
        choices: [],
        target: "reviewer",
      },
      f.tokens.get(run.id)!,
    );
    assert.equal(receipt.status, "answered");
    assert.equal(
      receipt.status === "answered" && receipt.answeredBy,
      `reviewer ${f.current().resolution.reviewerAgentId}`,
    );
    assert.match(
      receipt.status === "answered" ? receipt.answer : "",
      /patch the gate in place/,
    );
    assert.equal(consults.length, 1);
    assert.match(
      consults[0]!.prompt,
      /second opinion — a consult, not a review round/,
    );
    const events = f.store.eventsAll(f.submitted.id);
    const askId = events
      .find((event) => event.kind === "agent_ask")!
      .detail.split(":")[0]!;
    assert.ok(
      events.some(
        (event) =>
          event.kind === "agent_ask_delegated" &&
          event.detail.startsWith(`${askId}:`) &&
          event.detail.includes("consult"),
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.kind === "agent_ask_answered" &&
          event.detail.startsWith(`${askId}:`) &&
          event.detail.includes("reviewer"),
      ),
    );
    // An identical re-ask collects the recorded answer without consulting again.
    const again = await f.engine.resolution.agentAsk(
      {
        eventId: randomUUID(),
        taskId: f.submitted.id,
        runId: run.id,
        question: "Should I restructure the module or patch the gate in place?",
        choices: [],
        target: "reviewer",
      },
      f.tokens.get(run.id)!,
    );
    assert.equal(again.status, "answered");
    assert.equal(
      consults.length,
      1,
      "the identical re-ask never consults twice",
    );
  } finally {
    await f.close();
  }
});

test("task telemetry shows blocked reports per model and where each ladder escalation sits", () => {
  const dir = "/repo";
  const store = new Store(":memory:");
  try {
    const inserted = store.insert(
      submissionSchema.parse({
        submissionId: "ladder-telemetry",
        title: "Task",
        repoPath: dir,
        planningCommit: "a".repeat(40),
        handoffPath: "",
        originAgentId: "origin",
      }),
      "host",
      "brief",
      "a".repeat(40),
    );
    const cause = blockerCauseId(
      inserted.id,
      blocked("Private admission isolation remains unproved"),
    );
    store.event(
      inserted.id,
      "non_delivery",
      JSON.stringify({
        runId: "r1",
        role: "revision",
        status: "blocked",
        provider: "openai",
        model: "terra",
        baselineHead: "a",
        observedHead: "a",
      }),
    );
    store.event(
      inserted.id,
      "reviewer_consult",
      `consult-1: cause ${cause}; run r2; question q (10 chars)`,
    );
    store.event(
      inserted.id,
      "planner_escalation",
      `esc-1: cause ${cause}; run r3; question q (10 chars); options a | b | c`,
    );
    store.event(
      inserted.id,
      "planner_escalation_decision_linked",
      "esc-1: decision 01234567-89ab-cdef-0123-456789abcdef",
    );
    const revisionBlocked: Run = {
      id: "r2",
      taskId: inserted.id,
      role: "revision",
      head,
      status: "finished",
      released: true,
      createdAt: "2026-11-02T00:00:00Z",
      profile: {
        id: "terra",
        name: "Terra",
        provider: "openai",
        model: "gpt-6.1-terra",
        notes: "",
        available: true,
        problem: "",
        supportedThinking: [],
      },
      completion: {
        eventId: "e1",
        taskId: inserted.id,
        runId: "r2",
        status: "blocked",
        summary: "Private admission isolation remains unproved",
      },
    } as unknown as Run;
    const task = store.task(inserted.id);
    const telemetry = deriveTaskTelemetry(
      task,
      store.eventsAll(task.id),
      [revisionBlocked],
      [],
      [],
      new Date(task.createdAt),
    );
    assert.equal(telemetry.blockers.count, 1);
    assert.deepEqual(telemetry.blockers.byModel, [
      { provider: "openai", model: "gpt-6.1-terra", count: 1 },
    ]);
    assert.deepEqual(telemetry.blockers.escalations, {
      worker: 1,
      reviewer: 1,
      planner: 1,
      tom: 1,
    });
    assert.deepEqual(telemetry.nonDelivery.count, 1);
  } finally {
    store.close();
  }
});

test("consult and escalation questions carry the task, the blocker, the reviewer's view and the concrete options", () => {
  const question = plannerEscalationQuestion(
    { title: "Isolation gate" },
    blocked("Live-state inventory gate failed"),
    "Try the replay fixture.",
  );
  assert.match(question, /Isolation gate/);
  assert.match(question, /Live-state inventory gate failed/);
  assert.match(
    question,
    /The retained reviewer was already consulted; its advice was: Try the replay fixture\./,
  );
  for (const choice of PLANNER_ESCALATION_CHOICES)
    assert.ok(question.includes(choice), `the question offers ${choice}`);
  const unreviewed = plannerEscalationQuestion(
    { title: "Isolation gate" },
    blocked("gate failed"),
    null,
  );
  assert.match(
    unreviewed,
    /The retained reviewer was not consulted for this cause\./,
  );
  const proofOnly = plannerEscalationQuestion(
    { title: "Merged qualification", entrypoint: "proof" },
    blocked("Receipt review could not be recorded"),
    null,
  );
  assert.match(proofOnly, /Its receipt review reported/);
  assert.match(proofOnly, /including a receipt review/);
  assert.doesNotMatch(proofOnly, /Return to the worker with a new approach/);
  assert.deepEqual(
    plannerEscalationChoicesFor({ entrypoint: "proof" }),
    PLANNER_ESCALATION_CHOICES.filter((choice) => choice !== "Return to the worker with a new approach"),
  );
  assert.deepEqual(plannerEscalationChoicesFor({ entrypoint: "worker" }), PLANNER_ESCALATION_CHOICES);
  const consult = reviewerConsultQuestion(
    { title: "Isolation gate" },
    blocked("gate failed", { head }),
  );
  assert.match(consult, /consult, not a review round/);
  assert.match(consult, /gate failed/);
  assert.match(consult, new RegExp(head));
  assert.match(
    reviewerAskPrompt("Which gate?", "Isolation gate"),
    /Which gate?/,
  );
  assert.equal(
    escalationWaitDetail.reviewer("c1"),
    "Waiting with the retained reviewer: consult c1 is out for a second opinion; the same worker continues with the advice",
  );
  assert.match(
    escalationWaitDetail.planner("e1"),
    /Waiting with the planner: blocker escalation e1/,
  );
  assert.match(
    escalationWaitDetail.operator("e1", "d1"),
    /Waiting with the operator/,
  );
});

test('a named task wait wakes the parked escalation when its prerequisite settles', async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  const prerequisite = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Upstream', repoPath: join(f.dir, 'upstream'), planningCommit: 'b'.repeat(40), brief: { text: 'Upstream' }, originAgentId: 'origin' }), 'host', 'brief', 'b'.repeat(40));
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async () => `Choice: Wait for a task (put its reference in Reason)\nReason: ${prerequisite.id}`;
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    await f.reviews(1); await f.engine.wake();
    await f.report('blocked', { summary: 'Waiting for upstream', cause: { kind: 'external', name: 'upstream' } });
    await until(() => f.events('planner_escalation_applied').some(event => event.detail.includes('waiting for task')));
    assert.deepEqual(f.current().prerequisiteWait?.waitsFor, [prerequisite.id]);
    assert.match(f.current().resolution.stop?.detail ?? '', /waiting for task/i);
    f.store.update(prerequisite.id, { phase: 'done' });
    await f.engine.resolution.resumeAskQuestions();
    assert.equal(f.events('planner_escalation_woke').length, 1, JSON.stringify(f.events('planner_escalation_wake_refused')));
    await f.engine.resolution.resumeAskQuestions();
    assert.equal(f.events('planner_escalation_woke').length, 1);
  } finally { await f.close(); }
});

test('a refused escalation choice returns the refusal to its planner once', async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  const prompts: string[] = [];
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async (_: string, input: { prompt: string }) => {
    prompts.push(input.prompt);
    return 'Choice: Return to the worker with a new approach\nReason: Retry the isolated approach';
  };
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    const apply = f.engine.resolution.applyOperatorControl!;
    let calls = 0;
    f.engine.resolution.applyOperatorControl = async input => {
      if (++calls === 1) throw Error('The isolated gate is still held');
      return apply(input);
    };
    await f.reviews(1); await f.engine.wake();
    await f.report('blocked', { summary: 'The gate is held', cause: { kind: 'external', name: 'held gate' } });
    await until(() => f.events('planner_escalation_applied').length > 0);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /The isolated gate is still held/);
    assert.equal(f.events('planner_escalation_refusal_sent').length, 1);
    assert.equal(calls, 2);
  } finally { await f.close(); }
});

test('a bare escalation wait is not accepted', () => {
  assert.equal(parseEscalationReply('Answer: Leave it waiting\nReason: later', PLANNER_ESCALATION_CHOICES), null);
  assert.equal(parseEscalationReply('Answer: wait\nReason: later', PLANNER_ESCALATION_CHOICES), null);
  assert.equal(parseEscalationReply('Choice: Leave it waiting\nReason: later', PLANNER_ESCALATION_CHOICES), null);
});

test('a planner retry choice invokes the ordinary recorded effect', async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  const calls: string[] = [];
  let asks = 0;
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async (_: string, input: { prompt: string }) => {
    asks++;
    const label = input.prompt.split('\n').find(line => line.startsWith('- Retry workspace_archive.ghost:'));
    if (asks === 1) { assert.ok(label, input.prompt); return `Choice: ${label!.slice(2)}\nReason: Observe the recorded archive`; }
    return 'Choice: Return to the worker with a new approach\nReason: Continue after the refusal';
  };
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    await f.reviews(1); await f.engine.wake();
    const task = f.current();
    const directory = join(f.dir, 'absent-ghost');
    const branch = `ns-${task.id}`;
    f.store.setMeta(`displacedDispatchWorkspace:${task.id}:ghost`, { id: 'ghost', directory, branch });
    f.store.setMeta(`unusedWorkspaceArchive:${task.id}:ghost`, { workspaceId: 'ghost', directory, head, branch, status: 'intent' });
    f.store.event(task.id, 'unused_workspace_archive_intent', JSON.stringify({ workspaceId: 'ghost' }));
    (f.adapter as unknown as Record<string, unknown>).archiveTaskWorkspace = async () => true;
    const apply = f.engine.resolution.applyOperatorControl!;
    f.engine.resolution.applyOperatorControl = async input => { calls.push(`${input.action}:${input.effect ?? ''}`); return apply(input); };
    await f.report('blocked', { summary: 'Archive result unobserved', cause: { kind: 'external', name: 'archive' } });
    await until(() => f.events('planner_escalation_applied').length > 0);
    assert.ok(calls.includes('retry_effect:workspace_archive.ghost'));
    assert.equal(f.store.getMeta<{status: string}>(`unusedWorkspaceArchive:${task.id}:ghost`)?.status, 'archived');
  } finally { await f.close(); }
});


test('delegated choices exclude force, discard and operator source acceptance', () => {
  const views = [
    { verb: 'move', action: 'move', available: true, args: { taskId: 't', version: 1, to: 'merge' }, fill: ['reason', 'qualification'] },
    { verb: 'retry_effect', action: 'retry_effect', available: true, args: { taskId: 't', version: 1, effect: 'workspace_creation' }, fill: ['reason', 'discard'] },
    { verb: 'move', action: 'move', available: true, args: { taskId: 't', version: 1, to: 'review' }, fill: ['reason'], forceArgs: { force: true } },
  ];
  const offered = escalationVerbChoices(views);
  assert.equal(offered.length, 1);
  assert.equal(offered[0]!.args.to, 'review');
  assert.equal(offered[0]!.args.force, undefined);
});

test('a time wait wakes once when the named time arrives', async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  let when = '';
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async () => { when = new Date(Date.now() + 1000).toISOString(); return `Choice: Wait until a time (put an ISO timestamp in Reason)\nReason: ${when}`; };
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    await f.reviews(1); await f.engine.wake();
    await f.report('blocked', { summary: 'Try after the window', cause: { kind: 'external', name: 'window' } });
    await until(() => f.events('planner_escalation_applied').some(event => event.detail.includes('waiting until')));
    assert.match(f.current().resolution.stop?.detail ?? '', /waiting until/i);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(when) - Date.now()) + 10));
    await f.engine.resolution.resumeAskQuestions();
    assert.equal(f.events('planner_escalation_woke').length, 1, JSON.stringify(f.events('planner_escalation_wake_refused')));
  } finally { await f.close(); }
});

test('an operator decision wait applies its answer on wake', async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  const decisions = new Decisions(f.store);
  const decision = decisions.add({ question: 'What should happen next?', askedBy: 'origin' });
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async () => `Choice: Wait for an operator decision (put its ID in Reason)\nReason: ${decision.id}`;
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    await f.reviews(1); await f.engine.wake();
    await f.report('blocked', { summary: 'A ruling is pending', cause: { kind: 'external', name: 'ruling' } });
    await until(() => f.events('planner_escalation_applied').some(event => event.detail.includes('operator decision')));
    decisions.answer({ id: decision.id, version: decision.version, answer: 'Continue with the approved approach', answeredBy: 'operator', relayed: false, note: '' });
    await f.engine.resolution.resumeAskQuestions();
    assert.equal(f.events('planner_escalation_woke').length, 1, JSON.stringify(f.events('planner_escalation_wake_refused')));
    assert.ok(f.events('planner_escalation_answered').some(event => /Continue with the approved approach/.test(event.detail)));
  } finally { await f.close(); }
});

test('a ready author without a reader continues review without asking the planner', async () => {
  const f = fixture({ responsible: true });
  try {
    const before = f.current();
    const handled = await f.engine.resolution.responsibleBlockerLadder(before, {
      source: 'recovery', runId: null, completion: blocked('The reviewer slot is all that remains'),
    });
    assert.equal(handled, true);
    assert.equal(f.events('planner_escalation').length, 0);
    assert.equal(f.events('planner_escalation_avoided').length, 1, JSON.stringify(f.events('planner_escalation_automatic_refused')));
    assert.ok(['awaiting_review', 'reviewing'].includes(f.current().phase));
  } finally { await f.close(); }
});

test('a current accepted review resumes the ordinary merge gate without a planner', async () => {
  const f = fixture({ responsible: true });
  try {
    const before = f.current();
    const review: Completion = { taskId: before.id, runId: 'accepted-review', eventId: 'accepted-result', status: 'ready_to_merge', summary: 'Accepted', head };
    f.store.update(before.id, { phase: 'verifying', resolution: { ...before.resolution, review, currentRunId: null } });
    const controls: string[] = [];
    f.engine.resolution.applyOperatorControl = async input => { controls.push(`${input.action}:${input.to}`); return f.current(); };
    const handled = await f.engine.resolution.responsibleBlockerLadder(f.current(), {
      source: 'recovery', runId: null, completion: blocked('The reviewed head is ready for its merge gate'),
    });
    assert.equal(handled, true);
    assert.deepEqual(controls, ['move:merge']);
    assert.equal(f.events('planner_escalation').length, 0);
  } finally { await f.close(); }
});

test('an offered verb selected by its name alone is that verb, never a direction to the worker', () => {
  const choices = [...PLANNER_ESCALATION_CHOICES, 'Move to merge: Nucleus checks the accepted head', 'Move to review: continues the retained reviewer', 'Retry a: first', 'Retry a: second'];
  assert.deepEqual(parseEscalationReply('Answer: Move to merge\nChoice: Move to merge\nReason: approved', choices),
    { kind: 'choice', choice: 'Move to merge: Nucleus checks the accepted head', reason: 'approved' });
  assert.deepEqual(parseEscalationReply('Answer: Move to merge\nReason: approved', choices),
    { kind: 'choice', choice: 'Move to merge: Nucleus checks the accepted head', reason: 'approved' });
  assert.equal(parseEscalationReply('Answer: Retry a\nReason: which one', choices)?.kind, 'answer', 'an ambiguous name stays a direction');
});

const askedEscalation = (f: ReturnType<typeof fixture>, reply: (prompt: string) => string | null) => {
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async (_: string, input: { prompt: string }) => reply(input.prompt);
  f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
  f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
};

test('a delegated stop applies through the ordinary verb', async () => {
  const f = fixture({ responsible: true });
  askedEscalation(f, () => 'Choice: Stop and keep the work\nReason: Nothing further to do');
  try {
    await f.reviews(1); await f.engine.wake();
    await f.report('blocked', { summary: 'The gate is held', cause: { kind: 'external', name: 'held gate' } });
    await until(() => f.events('planner_escalation_applied').length + f.events('planner_escalation_refused').length > 0);
    assert.equal(f.events('planner_escalation_refused').length, 0, f.events('planner_escalation_refused')[0]?.detail);
    assert.match(f.events('planner_escalation_applied')[0]!.detail, /stop and keep the work/);
    assert.equal(f.current().holds.dispatch?.owner, 'planner-1');
  } finally { await f.close(); }
});

test('a long verb description leaves a label that can be repeated exactly', () => {
  const [choice] = escalationVerbChoices([{ verb: 'restart', action: 'restart', available: true, args: { taskId: 't', version: 1 }, fill: ['reason'], note: `${'word '.repeat(59)}word ${'more '.repeat(5)}` }]);
  assert.equal(choice!.label, choice!.label.trim());
});

test('every verb an escalation can offer accepts a delegated answer', () => {
  const base = { taskId: 't', version: 1, reason: 'why', caller: 'planner-1', delegated: true, note: 'Delegated answer' };
  for (const args of [{ action: 'restart' }, { action: 'move', to: 'review' }, { action: 'route', role: 'worker', profileId: 'p' }, { action: 'retry_effect', effect: 'workspace_creation' }])
    assert.doesNotThrow(() => taskControlInputSchema.parse({ ...base, ...args }), JSON.stringify(args));
});

test('an answer after the task merged settles the escalation and leaves the task alone', async () => {
  const f = fixture({ responsible: true });
  askedEscalation(f, () => {
    const task = f.current();
    f.store.update(task.id, { phase: 'done', resolution: { ...task.resolution, mergedCommit: head } });
    return 'Choice: Return to the worker with a new approach\nReason: Try again';
  });
  try {
    await f.reviews(1); await f.engine.wake();
    await f.report('blocked', { summary: 'The gate is held', cause: { kind: 'external', name: 'held gate' } });
    await until(() => f.events('planner_escalation_applied').length + f.events('planner_escalation_refused').length > 0);
    assert.equal(f.events('planner_escalation_refused').length, 0);
    assert.match(f.events('planner_escalation_applied')[0]!.detail, /merged or ended first/);
    assert.doesNotMatch(f.current().reason, /is unresolved/);
    assert.equal(f.current().phase, 'done');
  } finally { await f.close(); }
});

test('a merged task starts no decider when its planner gives no answer', async () => {
  const f = fixture({ responsible: true });
  askedEscalation(f, () => {
    const task = f.current();
    f.store.update(task.id, { phase: 'done', resolution: { ...task.resolution, mergedCommit: head } });
    return null;
  });
  let deciders = 0;
  (f.adapter as unknown as Record<string, unknown>).runDecider = async () => { deciders++; return { agentId: 'decider-1', text: null }; };
  try {
    await f.reviews(1); await f.engine.wake();
    await f.report('blocked', { summary: 'The gate is held', cause: { kind: 'external', name: 'held gate' } });
    await until(() => f.events('planner_escalation_answered').length > 0);
    assert.equal(deciders, 0);
  } finally { await f.close(); }
});

test('a delegated restart choice applies through the ordinary verb', async () => {
  const f = fixture({ responsible: true });
  let asks = 0;
  askedEscalation(f, prompt => {
    asks++;
    const label = prompt.split('\n').find(line => line.startsWith('- Restart'));
    assert.ok(label, prompt);
    return `Choice: ${label!.slice(2)}\nReason: The gate cleared`;
  });
  try {
    await f.reviews(1); await f.engine.wake();
    await f.report('blocked', { summary: 'The gate is held', cause: { kind: 'external', name: 'held gate' } });
    await until(() => f.events('planner_escalation_applied').length + f.events('planner_escalation_refused').length > 0);
    assert.equal(f.events('planner_escalation_refused').length, 0, f.events('planner_escalation_refused')[0]?.detail);
    assert.match(f.events('planner_escalation_applied')[0]!.detail, /^[^:]+: Restart/);
    assert.equal(asks, 1);
  } finally { await f.close(); }
});
