import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../core/engine";
import { Decisions } from "../core/planning/decisions";
import { escalationWaitDetail } from "../core/questions/ladder";
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
  return { ...f, taskId: task.id, handoff, decisions: new Decisions(f.store) };
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

for (const interveningControl of [false, true]) {
  test(interveningControl
    ? "a roll respects an owner control after a link with no operator wait journal"
    : "a roll repairs a linked operator decision whose wait journal is missing", async () => {
    const f = handoffFixture();
    let replacement: Engine | undefined;
    try {
      // Model the legacy handoff interrupted after its link committed.
      const decision = f.decisions.add({
        question: "Should the import boundary move?",
        choices,
        context,
        askedBy: "origin",
        tasks: [f.taskId],
      });
      f.store.event(f.taskId, "planner_escalation_decision_linked", `${escalationId}: decision ${decision.id}`);
      if (interveningControl) f.store.event(f.taskId, "operator_control", "move");
      await f.engine.stop();
      replacement = new Engine(f.store, f.engine.adapter, 0);
      assert.equal(replacement.resolution.ladder.operatorDecisionApplied(f.taskId, escalationId), false);
      await replacement.resolution.resumeAskQuestions();
      await replacement.resolution.resumeAskQuestions();

      assert.deepEqual(f.decisions.list({ task: f.taskId }).map(item => item.id), [decision.id]);
      assert.equal(f.events("planner_escalation_decision_linked").length, 1);
      assert.equal(f.events("planner_escalation_wait").length, interveningControl ? 0 : 1);
      if (!interveningControl) {
        assert.deepEqual(f.current().resolution.stop?.fact?.escalationWait, { kind: "decision", target: decision.id });
        assert.equal(f.current().resolution.stop?.detail, escalationWaitDetail.operator(escalationId, decision.id));
      }
      assert.equal(replacement.resolution.ladder.operatorDecisionApplied(f.taskId, escalationId), !interveningControl);
    } finally {
      await replacement?.stop();
      await f.close();
    }
  });
}
