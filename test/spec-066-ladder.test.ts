import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ANSWERING_WINDOW_MS, waitFor } from "./support/budgets";
import { fixture } from "./support/responsible-lifecycle-fixture";
import { plannerEscalations } from "../core/questions/ladder";
import { RuntimeRepositories, type RepositoriesContext } from "../core/runtime/repositories";
import { runSchema } from "../shared/contracts";
import { formatAgentId } from "../shared/agent-identity";

test("an unresolved T3 planner stays assigned and visible until the escalation can reach a planner", async () => {
  const hostId = "t3code:synthetic";
  const missing = formatAgentId(hostId, "mcp:bare-session");
  const planner = formatAgentId(hostId, "mcp:launch:planner");
  const f = fixture({ hostId, responsible: true, delegates: {
    planner: "Choice: Stop and keep the work\nReason: The dependency was retired.",
  } });
  try {
    const resolution = f.engine.resolution;
    const originAgent = f.adapter.originAgent!;
    f.adapter.originAgent = async id => id === "mcp:bare-session" ? null : originAgent(id);
    f.engine.identifyOriginHost = async () => hostId;
    const repositories = new RuntimeRepositories({
      store: f.store, engine: f.engine, markStoreAccess() {},
    } as unknown as RepositoriesContext);
    f.store.upsertProject({
      key: "example", name: "Example", repositories: [{ origin: null, path: join(f.dir, "repo") }],
    });
    await repositories.setProjectPlanner({ key: "example", agentId: missing, setBy: "operator" });
    f.store.update(f.submitted.id, { plannerAgentId: "operator" });
    resolution.openPlannerEscalation(f.current(), {
      cause: "dependency-retired", runId: null, question: "How should the task proceed?", payload: {},
    });
    await waitFor(() => Boolean(f.current().resolution.stop?.detail.includes("Planner unroutable:")));
    const detail = f.current().resolution.stop!.detail;
    assert.ok(detail.includes(missing));
    assert.match(detail, /no matching thread on its T3 host.*Re-run project.set-planner/);
    await resolution.blockerLadderStep(f.current());
    assert.equal(f.current().resolution.stop?.detail, detail, "the lifecycle pass preserves the routing cause");
    assert.equal(f.store.projectByKey("example")?.planner?.agentId, missing);
    const project = await repositories.getProject({ key: "example" });
    assert.match(project?.plannerRoutingIssue ?? "", /Planner unroutable:/);
    const settings = (await f.engine.projectSettings()).projects.find(row => row.project.key === "example");
    assert.ok(settings?.problems.includes(project!.plannerRoutingIssue!));
    assert.equal(settings?.plannerLive, null);
    assert.equal(f.events("planner_escalation_sent").length, 0);
    assert.equal(f.delegated.deciders.length, 0);

    await repositories.setProjectPlanner({ key: "example", agentId: planner, setBy: planner });
    const escalation = plannerEscalations(f.store.eventsAll(f.submitted.id))[0]!;
    await resolution.ladder.routePlannerEscalation(f.current(), escalation.id, escalation.question!);
    assert.equal(f.delegated.planner[0]?.agentId, "mcp:launch:planner");
    assert.equal(f.delegated.deciders.length, 0);
    assert.equal((await repositories.getProject({ key: "example" }))?.plannerRoutingIssue, undefined);
  } finally { await f.close(); }
});

test("a high-demand decider refuses probes and validates a draft without recording it", async () => {
  const f = fixture({ delegates: { decider: null } });
  try {
    await f.reviews(1);
    await f.engine.wake();
    const worker = f.run();
    const resolution = f.engine.resolution;
    f.store.update(f.submitted.id, { plannerAgentId: "operator", complexity: "high" });
    const pool = f.store.pool().filter(entry => entry.profileId !== f.higher.id);
    f.store.setMeta("pool", pool);
    assert.equal(resolution.deciderProfile(f.current()), null, "a cheaper profile cannot fill the shortfall");
    f.store.setMeta("pool", [...pool, { ...pool[0], profileId: f.higher.id, capability: "high", group: "high" }]);
    resolution.delegatedAnswerWaitMs = ANSWERING_WINDOW_MS;
    resolution.agentAskWaitMs = 5_000;
    resolution.agentAskPollMs = 20;
    let validated = false;
    f.adapter.askPlanner = async (recipient, { messageId }) => {
      assert.equal(recipient, "decider-1");
      const logs = () => [f.store.eventsAll(`delegation:${messageId}`), f.store.eventsAll(f.submitted.id)];
      const before = logs();
      await assert.rejects(resolution.answerDelegatedQuestionFromHost({
        questionId: messageId, answer: "test", reason: "test",
      }, recipient), /substantive.*--dry-run/);
      await assert.rejects(resolution.answerDelegatedQuestionFromHost({
        questionId: messageId, choice: "Unlisted choice", reason: "A separate choice is required",
      }, recipient), /Choice must match an offered choice/);
      assert.deepEqual(logs(), before, "refusals leave the question open");
      const answer = { questionId: messageId, answer: "Use the focused selector", reason: "It covers the changed behavior" };
      const preview = await resolution.answerDelegatedQuestionFromHost({ ...answer, dryRun: true }, recipient);
      assert.equal("status" in preview && preview.status, "validated");
      assert.deepEqual(logs(), before, "dry run leaves the task and delegation events unchanged");
      await resolution.answerDelegatedQuestionFromHost(answer, recipient);
      validated = true;
      return null;
    };
    const receipt = await resolution.agentAsk({
      eventId: randomUUID(), taskId: f.submitted.id, runId: worker.id, to: "planner",
      question: "Which selector covers this change?", choices: [],
    }, f.tokens.get(worker.id)!);
    assert.equal(receipt.status, "answered");
    assert.ok(validated);
    assert.equal(f.delegated.deciders[0]?.profile, f.higher.id);
    assert.match(receipt.status === "answered" ? receipt.answer : "", /Use the focused selector/);
  } finally { await f.close(); }
});

test("a review ask reaches the idle retained reviewer and accepts their late advice", async () => {
  const f = fixture({ delegates: { planner: null, decider: null } });
  try {
    await f.reviews(1);
    await f.engine.wake();
    const worker = f.run();
    const reviewer = f.current().resolution.reviewerAgentId!;
    assert.ok(reviewer);
    f.idle(reviewer);
    const resolution = f.engine.resolution;
    resolution.delegatedAnswerWaitMs = 10;
    resolution.agentAskWaitMs = 100;
    resolution.agentAskPollMs = 10;
    let deliveryId: string | undefined;
    f.adapter.askReviewer = async (recipient, input) => {
      assert.equal(recipient, reviewer);
      deliveryId = input.messageId;
      return null;
    };
    const input = {
      eventId: randomUUID(), taskId: f.submitted.id, runId: worker.id,
      to: "planner" as const, kind: "review" as const, choices: [],
      question: "Could you give a second opinion on the review finding?",
    };
    const first = await resolution.agentAsk(input, f.tokens.get(worker.id)!);
    assert.equal(first.status, "pending");
    assert.ok(deliveryId);
    assert.equal(f.delegated.planner.length, 0);
    assert.equal(f.delegated.deciders.length, 0);
    await resolution.answerDelegatedQuestionFromHost({
      questionId: deliveryId, answer: "Keep the focused regression test", reason: "It exercises the failing route",
    }, reviewer);
    const answered = await resolution.agentAsk(input, f.tokens.get(worker.id)!);
    assert.match(answered.status === "answered" ? answered.answeredBy : "", /^reviewer /);
    assert.equal(f.delegated.planner.length, 0);
  } finally { await f.close(); }
});

test("pending recovery leaves a progressing BB reviewer alone and escalates once that turn stops", async () => {
  const f = fixture({ hostId: "bb:synthetic" });
  try {
    const current = f.current();
    const at = new Date().toISOString();
    const run = runSchema.parse({
      id: "synthetic-bb-review", taskId: current.id, role: "reviewer", generation: 1,
      status: "running", active: true, released: false, agentId: "bb-reviewer",
      lastObservedAt: null, completion: null, idleSince: null,
      hostId: current.hostId, workspaceId: current.workspaceId, createdAt: at,
      head: current.prHead, base: current.planningBase, profile: f.reviewer,
    });
    f.store.putRun(run);
    f.states.set(run.agentId!, {
      id: run.agentId!, workspaceId: run.workspaceId, status: "running", active: true,
      updatedAt: at, permissions: false, error: "",
    });
    f.store.update(current.id, {
      phase: "reviewing", reason: "Reviewer thread running",
      resolution: { ...current.resolution, reviewerAgentId: run.agentId, currentRunId: run.id, recovery: {
        id: "pending-review-recovery", key: "review", generation: current.coordinatorGeneration,
        runId: null, agentId: null, status: "pending", summary: "", idleSince: null,
        incidentId: null, progress: null,
      } },
    });
    f.store.event(current.id, "recovery_pending", "Review recovery requested");
    const recovery = f.engine.resolution.recovery;
    (recovery as unknown as { pendingBoundMs: number }).pendingBoundMs = 0;
    await recovery.pass(current.id);
    assert.equal(f.current().resolution.recovery?.status, "pending");
    assert.equal(f.events("recovery_escalated").length, 0);
    assert.equal(f.events("planner_escalation").length, 0);
    f.idle(run.agentId!);
    await recovery.pass(current.id);
    assert.equal(f.events("recovery_escalated").length, 1);
    assert.equal(f.events("planner_escalation").length, 1);
  } finally { await f.close(); }
});
