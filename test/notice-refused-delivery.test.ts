import { test } from "node:test";
import assert from "node:assert/strict";
import { Notices } from "../core/questions/notices";
import { ProvenPreSendRefusalError } from "../core/recovery/task-reasons";
import type { Resolution } from "../core/resolution";

/**
 * A notice's one durable send, as a refusal and as a lost effect (nucleus#1445).
 *
 * T3 clears a thread's snooze on an ordinary delivery, so the adapter refuses a
 * message to a thread the operator snoozed (Tom's ruling, 2026-11-20). That refusal
 * sent nothing: the notice must stay pending and be delivered when the thread
 * wakes, never be reported as unknown delivery. Any other send failure is still
 * unknown, and is never resent.
 */
type Record_ = {
  id: string;
  agentId: string;
  text: string;
  sourceAgentId?: string;
};

function harness(send: () => Promise<void>) {
  const notices = new Notices({
    store: {},
    adapter: {},
    paused: () => false,
    host: {
      observe: async (id: string) => ({
        id,
        workspaceId: "synthetic-workspace",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      }),
      sendMessage: send,
    },
    responsibleThreads: { cache: { invalidateMatching: () => {} } },
  } as unknown as Resolution);
  const marks: string[] = [];
  const waits: string[] = [];
  const run = () =>
    notices.sendDurably<Record_>({
      recipient: "synthetic-planner",
      lookupWait: (message) => `Waiting for the planner: ${message}`,
      busyWait: (state) =>
        `Waiting for the planner to finish (${state.status})`,
      wait: (reason) => waits.push(reason),
      confirm: () => ({
        id: "synthetic-notice",
        agentId: "synthetic-planner",
        text: "Nucleus notice",
      }),
      target: (record) => ({
        agentId: record.agentId,
        id: record.id,
        text: record.text,
      }),
      mark: (_record, status) => marks.push(status),
    });
  return { marks, waits, run };
}

test("a refusal proved before the send leaves the notice pending with its reason, never unknown (nucleus#1445)", async () => {
  const { marks, waits, run } = harness(async () => {
    throw new ProvenPreSendRefusalError(
      "T3Code thread is snoozed until 2030-01-01T00:00:00.000Z; the message waits for that snooze to wake",
      "T3Code message",
    );
  });
  assert.equal(await run(), "done");
  assert.deepEqual(
    marks,
    ["intent"],
    "no uncertain mark is recorded for a send that never left",
  );
  assert.equal(waits.length, 1);
  assert.match(
    waits[0]!,
    /T3Code message refused before send: T3Code thread is snoozed until/,
    "the notice names the refusal that keeps it waiting",
  );
});

test("a send whose outcome is unknown is still recorded as unknown delivery (nucleus#1445)", async () => {
  const { marks, waits, run } = harness(async () => {
    throw Error("socket closed");
  });
  assert.equal(await run(), "done");
  assert.deepEqual(marks, ["intent", "uncertain"]);
  assert.equal(waits.length, 0);
});
