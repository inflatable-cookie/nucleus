import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HostExecutorLink,
  HostExecutorUnavailableError,
  HostOperationRefusedError,
  HostOperationUnknownDeliveryError,
  HostOperationTimeoutError,
} from "../service/host-executor";
import { isHostOperationNonDelivery } from "../shared/host-operation";
import { PROTOCOL_VERSION } from "../shared/service/protocol";
import type {
  HostExecutorDeclaration,
  HostOperationOutcome,
} from "../shared/host-operation";

/**
 * The link is the service's half of the reverse channel: it writes one bounded
 * request, waits for the answer that names it, and settles exactly that operation.
 *
 * The fault boundaries are the point of this file: an answer for another operation,
 * a projection missing a field and a passed deadline are all unknown delivery, while
 * a bounded refusal the plugin proved before the write is a definite answer.
 */
const declaration: HostExecutorDeclaration = {
  role: "host-executor",
  host: { dataDir: "/tmp/bb-data", bbVersion: "0.49.0", sdkVersion: "0.6.132" },
};

function link(deadlineMs = 1_000) {
  const written: Array<{
    v: number;
    id: string;
    method: string;
    input: { op: string; input: unknown };
  }> = [];
  const instance = new HostExecutorLink({
    hostId: "bb:0123456789abcdef0123456789abcdef",
    declaration,
    deadlineMs,
    write: (frame) => {
      written.push(frame as (typeof written)[number]);
    },
  });
  return { instance, written };
}

function outcome(
  op: string,
  value: unknown,
  calls: Record<string, number> = {},
): HostOperationOutcome {
  return {
    operation: op as HostOperationOutcome["operation"],
    at: "2026-11-16T00:00:00.000Z",
    calls,
    value,
  };
}

test("one operation is written as a bounded host.op request and settles from its own answer", async () => {
  const { instance, written } = link();
  const pending = instance.request("thread.observe", { threadId: "thr_1" });
  assert.equal(written.length, 1);
  assert.equal(written[0].method, "host.op");
  assert.equal(written[0].v, PROTOCOL_VERSION);
  assert.deepEqual(written[0].input, {
    op: "thread.observe",
    input: { threadId: "thr_1" },
  });
  assert.equal(
    instance.settle({
      v: PROTOCOL_VERSION,
      id: written[0].id,
      result: outcome("thread.observe", {
        threadId: "thr_1",
        title: null,
        status: "idle",
        displayStatus: "idle",
        environmentId: "env_1",
        parentThreadId: null,
        parentNotifications: "off",
        pluginMetadata: null,
        archivedAt: null,
        queuedWork: "none",
        providerId: "codex",
        execution: null,
        environmentPath: "/synthetic/worktree",
        originPluginId: "nucleus",
        updatedAt: 1,
        hasPendingInteraction: false,
        interactions: [],
      }),
    }),
    true,
  );
  const settled = await pending;
  assert.equal(settled.operation, "thread.observe");
  assert.equal(
    (settled.value as { environmentId: string }).environmentId,
    "env_1",
  );
  assert.equal(instance.inFlight, 0);
});

test("an answer for a different operation, or a projection missing a field, is unknown delivery", async () => {
  const first = link();
  const other = first.instance.request("thread.observe", { threadId: "thr_1" });
  first.instance.settle({
    v: PROTOCOL_VERSION,
    id: first.written[0].id,
    result: outcome("thread.stop", {
      threadId: "thr_1",
      status: "idle",
      displayStatus: "idle",
    }),
  });
  await assert.rejects(
    other,
    (error: unknown) =>
      error instanceof HostOperationUnknownDeliveryError &&
      /named thread.stop/.test(error.message),
  );

  const second = link();
  const partial = second.instance.request("thread.observe", {
    threadId: "thr_1",
  });
  second.instance.settle({
    v: PROTOCOL_VERSION,
    id: second.written[0].id,
    result: outcome("thread.observe", { threadId: "thr_1" }),
  });
  await assert.rejects(
    partial,
    (error: unknown) =>
      error instanceof HostOperationUnknownDeliveryError &&
      /environmentId/.test(error.message),
  );
});

test("a bounded refusal the plugin proved is a definite answer, not an unknown write", async () => {
  const { instance, written } = link();
  const pending = instance.request("thread.archive", {
    threadId: "thr_1",
    expectedCascadeThreadIds: [],
  });
  instance.settle({
    v: PROTOCOL_VERSION,
    id: written[0].id,
    error: {
      code: "refused",
      message: "Archive refused: the cascade also names thr_foreign",
    },
  });
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof HostOperationRefusedError &&
      error.failure.code === "refused" &&
      /thr_foreign/.test(error.message),
  );
});

test("a post-write failure the host reports is unknown delivery, never a refusal a caller may retry", async () => {
  for (const code of ["unavailable", "internal"] as const) {
    assert.equal(isHostOperationNonDelivery(code), false);
    const { instance, written } = link();
    const pending = instance.request("run.attach", {
      projectId: "proj_1",
      title: "Synthetic worker",
      environmentPath: "/tmp/worktree",
      prompt: "Do nothing.",
    });
    instance.settle({
      v: PROTOCOL_VERSION,
      id: written[0].id,
      error: { code, message: `committed thread thr_1 then failed (${code})` },
    });
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(
        error instanceof HostOperationUnknownDeliveryError,
        `${code} must settle as unknown delivery, got ${(error as Error)?.name}`,
      );
      assert.match(error.message, new RegExp(`answered ${code}`));
      return true;
    });
  }
});

test("a passed deadline, a malformed refusal and a closed connection are all unknown delivery", async () => {
  const expired = link(10);
  await assert.rejects(
    expired.instance.request("call.counters", {}),
    (error: unknown) =>
      error instanceof HostOperationUnknownDeliveryError &&
      /no answer within 10 ms/.test(error.message),
  );

  const malformed = link();
  const pendingMalformed = malformed.instance.request("call.counters", {});
  malformed.instance.settle({
    v: PROTOCOL_VERSION,
    id: malformed.written[0].id,
    error: { code: "not-a-code" },
  });
  await assert.rejects(
    pendingMalformed,
    (error: unknown) => error instanceof HostOperationUnknownDeliveryError,
  );

  const closed = link();
  const pendingClosed = closed.instance.request("identity.probe", {});
  closed.instance.close("the host executor connection closed");
  await assert.rejects(
    pendingClosed,
    (error: unknown) =>
      error instanceof HostOperationUnknownDeliveryError &&
      /connection closed/.test(error.message),
  );
  await assert.rejects(
    closed.instance.request("identity.probe", {}),
    (error: unknown) => error instanceof HostExecutorUnavailableError,
  );
});

test("an input the service refuses is never written to the host", async () => {
  const { instance, written } = link();
  await assert.rejects(
    instance.request("thread.observe", { threadId: "" }),
    (error: unknown) =>
      error instanceof HostOperationRefusedError &&
      error.failure.code === "invalid_input",
  );
  await assert.rejects(
    instance.request("run.attach", { projectId: "proj_1" }),
    (error: unknown) =>
      error instanceof HostOperationRefusedError &&
      /title/.test(error.failure.message),
  );
  assert.deepEqual(written, []);
});

test("an answer frame that names no in-flight operation is reported, not guessed at", () => {
  const { instance } = link();
  assert.equal(
    instance.settle({
      v: PROTOCOL_VERSION,
      id: "host-op-unknown",
      result: outcome("call.counters", {}),
    }),
    false,
  );
  assert.equal(instance.settle({ v: 99, id: "host-op-unknown" }), false);
  assert.equal(instance.settle(null), false);
  assert.equal(
    instance.settle({
      v: PROTOCOL_VERSION,
      id: "host-op-unknown",
      method: "host.op",
    }),
    false,
  );
});

test("a late host send reply remains correlated after the caller's deadline", async () => {
  const { instance, written } = link(10);
  const request = instance.request("thread.send", {
    threadId: "thr_1",
    text: "hello",
    messageId: "msg_1",
  });
  let timeout!: HostOperationTimeoutError;
  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof HostOperationTimeoutError);
    timeout = error;
    return true;
  });
  const answer = outcome("thread.send", {
    threadId: "thr_1",
    delivery: "sent",
    mode: "queue",
  });
  assert.equal(
    instance.settle({ v: PROTOCOL_VERSION, id: written[0].id, result: answer }),
    true,
  );
  assert.deepEqual(await timeout.late, answer);
  assert.equal(instance.inFlight, 0);
});

test("a timed-out read drops only its correlated reply while another request remains in flight", async () => {
  const { instance, written } = link(10);
  await assert.rejects(
    instance.request("call.counters", {}),
    HostOperationTimeoutError,
  );
  assert.equal(instance.inFlight, 0);
  const independent = instance.request("call.counters", {});
  const expiredId = written[0].id;
  assert.equal(instance.settle({ v: PROTOCOL_VERSION, id: expiredId }), false);
  assert.equal(instance.settle({ v: PROTOCOL_VERSION, id: expiredId, error: { code: "invalid" } }), false);
  assert.equal(instance.settle({ v: PROTOCOL_VERSION, id: expiredId, result: outcome("identity.probe", {}) }), false);
  assert.equal(instance.settle({ v: PROTOCOL_VERSION, id: "host-op-unissued", result: outcome("call.counters", { counters: {}, loadedAt: 1 }) }), false);
  assert.equal(
    instance.settle({
      v: PROTOCOL_VERSION,
      id: expiredId,
      result: outcome("call.counters", { counters: {}, loadedAt: 1 }),
    }),
    true,
  );
  assert.equal(instance.inFlight, 1);
  assert.equal(instance.settle({ v: PROTOCOL_VERSION, id: written[1].id, result: outcome("call.counters", { counters: {}, loadedAt: 2 }) }), true);
  assert.deepEqual((await independent).value, { counters: {}, loadedAt: 2 });
  assert.equal(instance.settle({ v: PROTOCOL_VERSION, id: expiredId, result: outcome("call.counters", { counters: {}, loadedAt: 1 }) }), false);
});

test("expired read correlation is bounded and accepts a valid late refusal", async () => {
  const { instance, written } = link(10);
  await Promise.all(Array.from({ length: 1024 }, () => instance.request("call.counters", {}).catch(() => {})));
  await assert.rejects(instance.request("call.counters", {}), HostOperationTimeoutError);
  const reply = { v: PROTOCOL_VERSION, error: { code: "refused", message: "refused" } };
  assert.equal(instance.settle({ ...reply, id: written[0].id }), false);
  assert.equal(instance.settle({ ...reply, id: written[1].id }), true);
});

test("retained effect replies cannot exhaust observation capacity", async () => {
  const { instance, written } = link(10);
  const sends = Array.from({ length: 1024 }, (_, i) =>
    instance
      .request("thread.send", {
        threadId: "thr_1",
        text: "x",
        messageId: `msg_${i}`,
      })
      .catch((error) => error),
  );
  const errors = await Promise.all(sends);
  assert.ok(
    errors.every((error) => error instanceof HostOperationTimeoutError),
  );
  const read = instance.request("call.counters", {});
  const frame = written.at(-1)!;
  assert.equal(frame.input.op, "call.counters");
  assert.equal(
    instance.settle({
      v: PROTOCOL_VERSION,
      id: frame.id,
      result: outcome("call.counters", { counters: {}, loadedAt: 1 }),
    }),
    true,
  );
  await read;
  instance.close();
});
