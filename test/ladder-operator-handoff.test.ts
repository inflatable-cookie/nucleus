import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../core/engine";
import { Decisions } from "../core/planning/decisions";
import { escalationWaitDetail } from "../core/questions/ladder";
import { resolveExplicitly } from "../core/verbs/explicit-resolution";
import { OPERATOR_BOARD_CALLER } from "../shared/contracts";
import { fixture } from "./support/responsible-lifecycle-fixture";

const escalationId = "e".repeat(64);
const choices = [
  { label: "Widen the scope", consequence: "Allows changes beyond the current boundary." },
  { label: "Keep the boundary", consequence: "Leaves the broader changes out of this task." },
];
const context = "The import boundary needs an explicit scope ruling.";

function handoffFixture() {
  const f = fixture({ responsible: true });
  const task = f.store.update(f.current().id, { phase: "blocked" });
  f.store.event(task.id, "planner_escalation", `${escalationId}: cause ${"c".repeat(64)}; run worker; question pending`);
  f.engine.resolution.waiting(task, escalationWaitDetail.planner(escalationId), "escalated");
  const handoff = (decisionContext = context) => {
    f.engine.resolution.classifyEscalationToOperator(
      f.current(),
      escalationId,
      "Scope needs an operator ruling",
      "planner origin",
      { authority: "operator_choices", choices, context: decisionContext },
    );
  };
  const clear = async (kind: "stop" | "hold", id: string) => {
    const cleared = await resolveExplicitly(f.engine, {
      action: "record.clear", kind, id, taskId: task.id, version: f.current().version,
      caller: OPERATOR_BOARD_CALLER, reason: "This record has been disposed of",
      accept: kind === "hold" ? ["hold_owner"] : [],
    }, () => "next");
    assert.equal(cleared.explicitResolution?.status, "applied");
  };
  return { ...f, taskId: task.id, handoff, clear, decisions: new Decisions(f.store) };
}

for (const [write, prerequisite] of [
  ["planner_escalation_decision_linked", "SELECT 1 FROM decisions"],
  ["planner_escalation_wait", "SELECT 1 FROM events WHERE kind = 'planner_escalation_decision_linked'"],
] as const) {
  test(`an operator handoff rolls back when ${write} is interrupted`, async () => {
    const f = handoffFixture();
    try {
      const plannerStop = f.current().resolution.stop;
      f.store.db.exec(`
        CREATE TEMP TRIGGER interrupt_handoff BEFORE INSERT ON events
        WHEN NEW.kind = '${write}' AND EXISTS (${prerequisite})
        BEGIN
          SELECT RAISE(ABORT, 'operator handoff interrupted');
        END
      `);
      assert.throws(() => f.handoff(), /operator handoff interrupted/);
      assert.deepEqual(f.decisions.list({ task: f.taskId }), []);
      assert.equal(f.events("planner_escalation_decision_linked").length, 0);
      assert.equal(f.events("planner_escalation_wait").length, 0);
      assert.deepEqual(f.current().resolution.stop, plannerStop);

      f.store.db.exec("DROP TRIGGER interrupt_handoff");
      f.handoff();
      f.handoff("Reworded handoff context");
      const [decision] = f.decisions.list({ task: f.taskId });
      assert.ok(decision);
      assert.equal(decision.context, context);
      assert.equal(f.decisions.list({ task: f.taskId }).length, 1);
      assert.equal(f.events("planner_escalation_decision_linked").length, 1);
      assert.equal(f.events("planner_escalation_wait").length, 1);
      assert.equal(f.engine.resolution.ladder.operatorDecisionApplied(f.taskId, escalationId), true);
    } finally {
      await f.close();
    }
  });
}

test("an operator handoff reuses an unlinked decision by identity after its context changes", async () => {
  const f = handoffFixture();
  try {
    const plannerStop = f.current().resolution.stop;
    f.handoff();
    const [decision] = f.decisions.list({ task: f.taskId });
    assert.ok(decision);

    // Model a stored decision with no classification link or wait journal.
    f.store.db.prepare("DELETE FROM events WHERE taskId = ? AND kind IN ('planner_escalation_decision_linked', 'planner_escalation_wait')").run(f.taskId);
    f.engine.resolution.update(f.current(), { stop: plannerStop });
    f.handoff("The question is unchanged, with different operator context.");

    assert.deepEqual(f.decisions.list({ task: f.taskId }).map(item => item.id), [decision.id]);
    assert.equal(f.decisions.get({ id: decision.id }).context, context);
    assert.equal(f.events("planner_escalation_decision_linked")[0]?.detail, `${escalationId}: decision ${decision.id}`);
    assert.equal(f.engine.resolution.ladder.operatorDecisionApplied(f.taskId, escalationId), true);
  } finally {
    await f.close();
  }
});

test("an operator handoff adopts the pre-upgrade decision created before its link was written", async () => {
  const f = handoffFixture();
  try {
    f.store.event(f.taskId, "planner_escalation_decision", `${escalationId}: the planner origin said it cannot decide: Scope needs an operator ruling`);
    const decision = f.decisions.add({
      question: "Should the import boundary move?",
      choices,
      options: choices.map(choice => choice.label),
      context,
      askedBy: f.current().agentId ?? "nucleus",
      tasks: [f.taskId],
      by: "nucleus",
    });
    const unrelated = f.decisions.add({
      question: "An independent operator decision",
      choices,
      context,
      askedBy: "origin",
      tasks: [f.taskId],
    });
    f.handoff("Reworded context for the same occurrence");

    assert.deepEqual(new Set(f.decisions.list({ task: f.taskId }).map(item => item.id)), new Set([decision.id, unrelated.id]));
    assert.equal(f.events("planner_escalation_decision_linked")[0]?.detail, `${escalationId}: decision ${decision.id}`);
    assert.equal(f.engine.resolution.ladder.operatorDecisionApplied(f.taskId, escalationId), true);
  } finally {
    await f.close();
  }
});

for (const [control, name] of [
  ["none", "a roll repairs a linked operator decision whose wait journal is missing"],
  ["move", "a roll respects an owner control after a link with no operator wait journal"],
  ["hold", "clearing an independent merge hold leaves the linked operator wait recoverable"],
  ["clear", "a roll keeps an explicitly cleared stop cleared after an interrupted operator handoff"],
] as const) {
  test(name, async () => {
    const f = handoffFixture();
    let replacement: Engine | undefined;
    try {
      if (control === "hold") {
        const task = f.current();
        await f.engine.performTaskControl({
          taskId: task.id, version: task.version, action: "hold", kind: "merge",
          caller: OPERATOR_BOARD_CALLER, reason: "Separate merge freeze",
        });
      }
      // Model the legacy handoff interrupted after its link committed.
      const decision = f.decisions.add({
        question: "Should the import boundary move?",
        choices,
        context,
        askedBy: "origin",
        tasks: [f.taskId],
      });
      f.store.event(f.taskId, "planner_escalation_decision_linked", `${escalationId}: decision ${decision.id}`);
      if (control === "move") f.store.event(f.taskId, "operator_control", "move");
      if (control === "clear" || control === "hold") {
        const task = f.current();
        const stopId = task.resolution.stop?.since;
        assert.ok(stopId);
        await (control === "clear" ? f.clear("stop", stopId) : f.clear("hold", "merge"));
        assert.equal(f.events("owner_resolution").length, 1);
        if (control === "clear") assert.equal(f.current().resolution.stop, null);
        else {
          assert.equal(f.current().holds.merge, undefined);
          assert.equal(f.current().resolution.stop?.since, stopId);
        }
      }
      await f.engine.stop();
      replacement = new Engine(f.store, f.engine.adapter, 0);
      assert.equal(replacement.resolution.ladder.operatorDecisionApplied(f.taskId, escalationId), false);
      await replacement.resolution.resumeAskQuestions();
      await replacement.resolution.resumeAskQuestions();

      assert.deepEqual(f.decisions.list({ task: f.taskId }).map(item => item.id), [decision.id]);
      assert.equal(f.events("planner_escalation_decision_linked").length, 1);
      const shouldRestore = control === "none" || control === "hold";
      assert.equal(f.events("planner_escalation_wait").length, shouldRestore ? 1 : 0);
      if (shouldRestore) {
        assert.deepEqual(f.current().resolution.stop?.fact?.escalationWait, { kind: "decision", target: decision.id });
        assert.equal(f.current().resolution.stop?.detail, escalationWaitDetail.operator(escalationId, decision.id));
      }
      if (control === "clear") {
        assert.equal(f.current().resolution.stop, null);
        await replacement.resolution.blockerLadderStep(f.current());
        assert.equal(f.current().resolution.stop, null);

        const answered = f.decisions.answer({
          id: decision.id, version: decision.version, answer: choices[0]!.label,
          answeredBy: OPERATOR_BOARD_CALLER, relayed: false, note: "",
        });
        let settlements = 0;
        replacement.resolution.settlePlannerEscalation = async () => { settlements++; return null; };
        replacement.resolution.operatorDecisionAnswered(answered);
        await replacement.resolution.resumeAskQuestions();
        assert.equal(settlements, 0, "a late answer cannot act on the cleared wait");
      }
      assert.equal(replacement.resolution.ladder.operatorDecisionApplied(f.taskId, escalationId), shouldRestore);
    } finally {
      await replacement?.stop();
      await f.close();
    }
  });
}

test("clearing an installed operator stop fences both live answer delivery and journal replay", async () => {
  const f = handoffFixture();
  try {
    f.handoff();
    const [decision] = f.decisions.list({ task: f.taskId });
    const stop = f.current().resolution.stop;
    assert.ok(decision && stop);
    assert.equal(stop.fact?.escalationWait?.target, decision.id);
    await f.clear("stop", stop.since);

    const answered = f.decisions.answer({
      id: decision.id, version: decision.version, answer: choices[0]!.label,
      answeredBy: OPERATOR_BOARD_CALLER, relayed: false, note: "",
    });
    let settlements = 0;
    f.engine.resolution.settlePlannerEscalation = async () => { settlements++; return null; };
    f.engine.resolution.operatorDecisionAnswered(answered);
    await f.engine.resolution.resumeAskQuestions();

    assert.equal(settlements, 0);
    assert.equal(f.current().resolution.stop, null);
    assert.equal(f.events("planner_escalation_wait_superseded").length, 1);
  } finally {
    await f.close();
  }
});
