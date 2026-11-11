import { RuntimeQuestions, type QuestionsContext } from "../core/runtime/questions";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { questionAnswerInputSchema, questionAnswerRequestSchema, submissionSchema } from "../shared/contracts";
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { callCatalogueMethod } from "../service/transport/dispatch";
import { QueueRuntime } from "../service/runtime-owner";

const answer = {
  questionId: "ns-agent-ask-question",
  caller: "planner-thread",
  answer: "Continue",
  reason: "Within the brief",
};

test("question.answer routes the command to the owner with the calling thread", async () => {
  const calls: unknown[] = [];
  const receipt = { ...answer };
  const runtime = { questions: new RuntimeQuestions({
    engine: {
      resolution: {
        answerDelegatedQuestionFromHost: (...args: unknown[]) => {
          calls.push(args);
          return receipt;
        },
      },
    },
  } as unknown as QuestionsContext) };
  const result = await callCatalogueMethod(
    {
      answerDelegatedQuestion:
        QueueRuntime.prototype.answerDelegatedQuestion.bind(runtime as never),
    },
    "question.answer",
    answer,
  );
  assert.deepEqual(result, receipt);
  assert.deepEqual(calls, [[answer, "planner-thread"]]);
});

test("question.answer requires one answer shape and a one-line reason", () => {
  assert.equal(questionAnswerInputSchema.safeParse(answer).success, true);
  assert.equal(
    questionAnswerInputSchema.safeParse({
      ...answer,
      answer: undefined,
      choice: "Proceed",
    }).success,
    true,
  );
  assert.equal(
    questionAnswerInputSchema.safeParse({
      ...answer,
      answer: undefined,
      decision: "operator",
    }).success,
    true,
  );
  for (const invalid of [
    { ...answer, reason: "" },
    { ...answer, reason: "first\nsecond" },
    { ...answer, caller: undefined },
    { ...answer, answer: undefined },
    { ...answer, choice: "Proceed" },
    { ...answer, decision: "operator" },
    { ...answer, authority: "operator" },
  ])
    assert.equal(questionAnswerInputSchema.safeParse(invalid).success, false);
});

test('question.answer task references select only one live question for the authenticated recipient', async () => {
  const store=new Store(':memory:');
  const task=store.insert(submissionSchema.parse({submissionId:'question-target',title:'Task question',repoPath:'/fixture',planningCommit:'a'.repeat(40),handoffPath:'handoff.md',originAgentId:'planner'}),'host','handoff','a'.repeat(40));
  const engine=new Engine(store,{} as Adapter,0);
  engine.identifyOriginHost=async ()=>'host';engine.hostAvailable=()=>true;
  store.setMeta('hostRegistry',[{id:'host'}]);
  const questions=new RuntimeQuestions({store,engine} as unknown as QuestionsContext);
  try {
    engine.resolution.openDelegatedQuestion(task,'target-question','planner','Continue?',60_000,'planner','host');
    engine.resolution.openDelegatedQuestion(task,'other-recipient','someone-else','Continue?',60_000,'planner','host');
    const request=questionAnswerRequestSchema.parse({taskId:task.reference,caller:'planner',answer:'Continue',reason:'Within scope'});
    const receipt=await questions.answerDelegatedQuestion(request);
    assert.equal(receipt.questionId,'target-question');
    assert.equal(receipt.caller,'planner');
    assert.throws(()=>engine.resolution.delegatedQuestionForTask(task.reference!,'planner'),/No open question/);
    engine.resolution.openDelegatedQuestion(task,'second','planner','Continue?',60_000,'planner','host');
    engine.resolution.openDelegatedQuestion(task,'third','planner','Continue?',60_000,'planner','host');
    assert.throws(()=>engine.resolution.delegatedQuestionForTask(task.reference!,'planner'),/More than one open question.*questionId/);
    assert.equal(questionAnswerRequestSchema.safeParse({...request,questionId:'second'}).success,false);
    await assert.rejects(questions.answerDelegatedQuestion({...request,questionId:'second',taskId:undefined,caller:'unrelated'}),/Only the delegated recipient/);
  } finally {await engine.stop();store.close();}
});

test("CLI question.answer refuses a typed caller when no calling-thread environment exists", () => {
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  const result = spawnSync(
    process.execPath,
    [
      new URL("../bin/queue-cli.mjs", import.meta.url).pathname,
      "question.answer",
      "-",
    ],
    {
      env,
      input: JSON.stringify(answer),
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /question.answer records the calling thread; PASEO_AGENT_ID is required/,
  );
});
