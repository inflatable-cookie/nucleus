import { RuntimeQuestions, type QuestionsContext } from "../core/runtime/questions";
import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueRuntime } from "../service/runtime-owner";
import { callCatalogueMethod } from "../service/transport/dispatch";
import { formatAgentId } from "../shared/agent-identity";
import { digest } from "../core/store/store";

test("native question calls bind answers to a task's current thread and complete request", async () => {
  let answered = 0;
  let workspace = "workspace";
  let hostId = "host", online = true;
  const events: Array<{kind: string; detail: string}> = [];
  const owner = Object.create(QueueRuntime.prototype) as QueueRuntime;
  const adapter = {
    pendingQuestions: async () => [{ requestId: "request", questions: [{ header: "Choice", question: "Choose", options: ["Yes"] }] }],
    answerNativeQuestion: async (agent: string, ws: string, request: string, answers: Record<string, string>) => {
      assert.deepEqual([agent, ws, request, answers], ["agent", "workspace", "request", { Choice: "Yes" }]); answered++;
    },
  };
  Object.assign(owner, { questions: new RuntimeQuestions({
    store: { task: () => ({ agentId: "agent", workspaceId: workspace, hostId, removedAt: null }), runs: () => [],
      transaction: (fn: () => unknown) => fn(), eventsAll: () => events, event: (_id: string, kind: string, detail: string) => events.push({ kind, detail }) },
    engine: { adapter, withHost: (_id: string, fn: () => unknown) => fn(), taskHostAvailable: () => online },
  } as unknown as QuestionsContext) });
  const id = { taskId: "task", agentId: "agent" };
  assert.equal((await callCatalogueMethod(owner, "question.native-list", id, { via: "web" }) as unknown[]).length, 1);
  hostId = "";
  await assert.rejects(callCatalogueMethod(owner, "question.native-list", id, { via: "web" }), /proven task host/);
  hostId = "host"; online = false;
  await assert.rejects(callCatalogueMethod(owner, "question.native-answer", { ...id, requestId: "request", answers: { Choice: "Yes" } }, { via: "web" }), /Waiting for host/);
  assert.equal(events.length, 0); online = true;
  await assert.rejects(callCatalogueMethod(owner, "question.native-list", { ...id, agentId: "other" }, { via: "web" }), /no longer uniquely owned/);
  assert.equal((await callCatalogueMethod(owner, "question.native-list", { taskId: 'task', agentRef: formatAgentId('host', 'agent') }, { via: "web" }) as unknown[]).length, 1);
  await assert.rejects(callCatalogueMethod(owner, "question.native-list", { taskId: 'task', agentRef: formatAgentId('other', 'agent') }, { via: "web" }), /different host/);
  await assert.rejects(callCatalogueMethod(owner, "question.native-answer", { ...id, requestId: "request", answers: {} }, { via: "web" }), /incomplete/);
  assert.equal(answered, 0);
  const legacy = digest(JSON.stringify(['task', 'agent', 'request']));
  events.push({ kind: 'native_manual_answer_intent', detail: `${legacy}: old intent` });
  await assert.rejects(callCatalogueMethod(owner, "question.native-answer", { taskId: 'task', agentRef: formatAgentId('host', 'agent'), requestId: "request", answers: { Choice: "Yes" } }, { via: "web" }), /already recorded/);
  events.pop();
  await callCatalogueMethod(owner, "question.native-answer", { ...id, requestId: "request", answers: { Choice: "Yes" } }, { via: "web" });
  assert.equal(answered, 1);
  workspace = "";
  await assert.rejects(callCatalogueMethod(owner, "question.native-answer", { ...id, requestId: "request", answers: { Choice: "Yes" } }, { via: "web" }), /no longer uniquely owned/);
});
