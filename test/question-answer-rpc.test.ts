import { RuntimeQuestions, type QuestionsContext } from "../core/runtime/questions";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { questionAnswerInputSchema, questionAnswerRequestSchema, submissionSchema } from "../shared/contracts";
import { hostCallerIdentity } from "../hosts/paseo/cli/index.mjs";
import { resolveQuestionAnswerCaller } from "../shared/question-caller.mjs";
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
  delete env.NUCLEUS_TICKET;
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
    /no caller identity found.*Nucleus run or participant ticket.*host-supplied identity/,
  );
});

test("question.answer caller resolver prefers an existing run ticket over PASEO_AGENT_ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "question-caller-"));
  const ticket = join(dir, "run.json");
  writeFileSync(ticket, "{}");
  try {
    assert.deepEqual(resolveQuestionAnswerCaller({ NUCLEUS_TICKET: ticket, PASEO_AGENT_ID: "paseo-thread" }, hostCallerIdentity),
      { source: "ticket", path: ticket });
    assert.deepEqual(resolveQuestionAnswerCaller({ NUCLEUS_TICKET: join(dir, "gone.json"), PASEO_AGENT_ID: "paseo-thread" }, hostCallerIdentity),
      { source: "host", hostKind: "paseo", nativeAgentId: "paseo-thread" });
    assert.deepEqual(resolveQuestionAnswerCaller({ PASEO_AGENT_ID: "paseo-thread" }, hostCallerIdentity),
      { source: "host", hostKind: "paseo", nativeAgentId: "paseo-thread" });
    assert.throws(() => resolveQuestionAnswerCaller({ NUCLEUS_TICKET: join(dir, "gone.json") }),
      /Nucleus run or participant ticket.*host-supplied identity/);
    assert.throws(() => resolveQuestionAnswerCaller({}), /Nucleus run or participant ticket.*host-supplied identity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI question.answer with a missing run ticket does not fail as ENOENT", () => {
  const env = { ...process.env };
  env.NUCLEUS_TICKET = join(tmpdir(), "missing-nucleus-ticket.json");
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
    /no caller identity found.*Nucleus run or participant ticket.*host-supplied identity/,
  );
  assert.doesNotMatch(result.stderr, /ENOENT|no such file/i);
});

test("CLI question.answer with a run ticket posts to the ticket-bound answer route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "question-answer-ticket-"));
  const requests: { path: string | undefined; body: { taskId?: string; runId?: string; caller?: string; questionId?: string } }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push({ path: req.url, body: JSON.parse(body) });
      res.end('{"ok":true}');
    });
  });
  const socketPath = join(dir, "s");
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const ticket = join(dir, "ticket.json");
  writeFileSync(ticket, JSON.stringify({ socketPath, token: "fixture-secret", taskId: "task-1", runId: "run-1" }));
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, [new URL("../bin/queue-cli.mjs", import.meta.url).pathname, "question.answer", "-"], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(), NUCLEUS_TICKET: ticket },
      });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      child.on("close", code => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ ...answer, caller: "typed-imposter" }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.path, "/answer");
    assert.equal(requests[0]!.body.taskId, "task-1");
    assert.equal(requests[0]!.body.runId, "run-1");
    assert.equal(requests[0]!.body.questionId, answer.questionId);
    assert.equal(requests[0]!.body.caller, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
