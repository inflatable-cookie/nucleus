import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { questionAnswerInputSchema } from "../shared/contracts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ANSWERING_WINDOW_MS } from "./support/budgets";
import { fixture } from "./support/responsible-lifecycle-fixture";

function registerPlanner(f: ReturnType<typeof fixture>) {
  f.engine.resolution.agentAskWaitMs = 2000;
  f.engine.resolution.agentAskPollMs = 10;
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
}

test('worker process ask without target reaches the retained reviewer, never the planner', async () => {
  const f = fixture({
    delegates: { planner: "Answer: planner should not receive this" },
  });
  registerPlanner(f);
  let consults = 0;
  (f.adapter as any).askReviewer = async () => {
    consults++;
    return "Run the bounded diagnostic yourself.";
  };
  try {
    await f.reviews(1);
    await f.engine.wake();
    const run = f.run();
    const input = {
      eventId: randomUUID(),
      taskId: f.submitted.id,
      runId: run.id,
      question: "How can I diagnose this gate?",
      choices: [],
    };
    const receipt = await f.engine.resolution.agentAsk(
      input,
      f.tokens.get(run.id)!,
    );
    assert.equal(receipt.status, "answered");
    assert.match(
      receipt.status === "answered" ? receipt.answeredBy : "",
      /^reviewer /,
    );
    assert.equal(consults, 1);
    assert.equal(f.delegated.planner.length, 0);
    await f.engine.resolution.agentAsk(input, f.tokens.get(run.id)!);
    assert.equal(consults, 1);
  } finally {
    await f.close();
  }
});

// Task 1108 named recipients address their own rung: `ask to: "planner"` starts
// on this task's planner ladder without the reviewer rung. The unnamed ask above
// keeps the reviewer-first rung (Spec 058 Slice 17).
test('worker process ask to the planner takes the planner ladder; the retained reviewer is not consulted', async () => {
  const f = fixture({
    delegates: { planner: "Answer: the planner answers a named planner ask" },
  });
  registerPlanner(f);
  let consults = 0;
  (f.adapter as any).askReviewer = async () => {
    consults++;
    return "Run the bounded diagnostic yourself.";
  };
  try {
    await f.reviews(1);
    await f.engine.wake();
    const run = f.run();
    const input = {
      eventId: randomUUID(),
      taskId: f.submitted.id,
      runId: run.id,
      question: "How can I diagnose this gate?",
      choices: [],
      target: "planner" as const,
    };
    const receipt = await f.engine.resolution.agentAsk(
      input,
      f.tokens.get(run.id)!,
    );
    assert.equal(receipt.status, "answered");
    assert.match(
      receipt.status === "answered" ? receipt.answeredBy : "",
      /^planner /,
    );
    assert.equal(consults, 0, "the named planner ask skips the reviewer rung");
    assert.equal(f.delegated.planner.length, 1);
    assert.equal(
      f.store
        .eventsAll(f.submitted.id)
        .filter((event) => event.kind === "agent_ask_answered").length,
      1,
      "the planner answer is recorded once",
    );
    // An identical re-ask collects the recorded answer without delegating again.
    await f.engine.resolution.agentAsk(input, f.tokens.get(run.id)!);
    assert.equal(consults, 0);
    assert.equal(f.delegated.planner.length, 1);
  } finally {
    await f.close();
  }
});

test("the skill question.answer command reaches the planner once, and the worker joins the recorded answer", async () => {
  const f = fixture({
    delegates: {
      planner:
        "Answer: Keep the approved scope.\nReason: the brief already decides this",
    },
  });
  registerPlanner(f);
  let consults = 0;
  const skill = readFileSync(
    new URL("../skills/nucleus/SKILL.md", import.meta.url),
    "utf8",
  );
  const section = skill
    .split("## Settle questions within the task")[1]
    .split("## When to contact")[0];
  const example = JSON.parse(
    section.match(/nucleus question\.answer - <<'JSON'\n([^\n]+)\nJSON/)![1],
  );
  (f.adapter as any).askReviewer = async (
    recipient: string,
    request: { prompt: string },
  ) => {
    consults++;
    const questionId = request.prompt.match(/^Question id: (.+)$/m)![1];
    const command = questionAnswerInputSchema.parse({
      ...example,
      questionId,
      caller: recipient,
    });
    assert.equal(
      questionAnswerInputSchema.safeParse({
        questionId,
        caller: recipient,
        decision: "planner",
        reason: example.reason,
      }).success,
      false,
    );
    f.engine.resolution.answerDelegatedQuestion(command, command.caller);
    return null;
  };
  try {
    await f.reviews(1);
    await f.engine.wake();
    const run = f.run();
    const input = {
      eventId: randomUUID(),
      taskId: f.submitted.id,
      runId: run.id,
      question: "Which outcome applies?",
      choices: [],
    };
    const first = await f.engine.resolution.agentAsk(
      input,
      f.tokens.get(run.id)!,
    );
    assert.equal(first.status, "answered");
    assert.match(
      first.status === "answered" ? first.answeredBy : "",
      /^planner /,
    );
    await f.engine.resolution.agentAsk(input, f.tokens.get(run.id)!);
    await f.engine.resolution.resumeAskQuestions();
    assert.equal(consults, 1);
    assert.equal(f.delegated.planner.length, 1);
    assert.equal(
      f.store
        .eventsAll(f.submitted.id)
        .filter((event) => event.kind === "agent_ask_planning_ruling").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("a worker without a retained reviewer still gets its answer from the planner", async () => {
  const f = fixture({
    delegates: {
      planner: "Answer: Use the existing control.\nReason: already in scope",
    },
  });
  registerPlanner(f);
  try {
    await f.reviews(1);
    await f.engine.wake();
    const run = f.run();
    f.store.update(f.submitted.id, {
      resolution: { ...f.current().resolution, reviewerAgentId: null },
    });
    const receipt = await f.engine.resolution.agentAsk(
      {
        eventId: randomUUID(),
        taskId: f.submitted.id,
        runId: run.id,
        question: "Which existing control?",
        choices: [],
      },
      f.tokens.get(run.id)!,
    );
    assert.equal(receipt.status, "answered");
    assert.match(
      receipt.status === "answered" ? receipt.answeredBy : "",
      /^planner /,
    );
  } finally {
    await f.close();
  }
});

test("a silent retained reviewer advances to the planner", async () => {
  const f = fixture({
    delegates: { planner: "Answer: Use the existing control." },
  });
  registerPlanner(f);
  f.engine.resolution.delegatedAnswerWaitMs = 10;
  f.engine.resolution.agentAskWaitMs = ANSWERING_WINDOW_MS;
  (f.adapter as any).askReviewer = async () => null;
  try {
    await f.reviews(1);
    await f.engine.wake();
    const run = f.run();
    const input = {
      eventId: randomUUID(),
      taskId: f.submitted.id,
      runId: run.id,
      question: "Can this be settled here?",
      choices: [],
    };
    const receipt = await f.engine.resolution.agentAsk(
      input,
      f.tokens.get(run.id)!,
    );
    assert.equal(receipt.status, "answered");
    await f.engine.resolution.resumeAskQuestions();
    assert.equal(f.delegated.planner.length, 1);
  } finally {
    await f.close();
  }
});

test("a closed retained reviewer advances without a consult", async () => {
  const f = fixture({ delegates: { planner: "Answer: Use the existing control." } });
  registerPlanner(f);
  f.engine.resolution.agentAskWaitMs = ANSWERING_WINDOW_MS;
  try {
    await f.reviews(1);
    await f.engine.wake();
    const reviewer = f.current().resolution.reviewerAgentId!;
    const observe = f.adapter.observe.bind(f.adapter);
    (f.adapter as any).observe = async (id: string) => id === reviewer
      ? { ...(await observe(id)), status: "closed" } : observe(id);
    let consults = 0;
    (f.adapter as any).askReviewer = async () => { consults++; return null; };
    const run = f.run();
    const receipt = await f.engine.resolution.agentAsk({ eventId: randomUUID(), taskId: f.submitted.id,
      runId: run.id, question: "Which control?", choices: [] }, f.tokens.get(run.id)!);
    assert.equal(receipt.status, "answered");
    assert.equal(consults, 0);
    assert.equal(f.delegated.planner.length, 1);
  } finally { await f.close(); }
});
