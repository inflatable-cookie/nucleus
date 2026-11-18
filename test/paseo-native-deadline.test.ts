import { test } from "node:test";
import assert from "node:assert/strict";
import { DaemonClient } from "paseo-provenance-client/internal/daemon-client";
import { Admission } from "../core/host/admission";
import {
  HostCallAbandonedError,
  ProvenPreSendRefusalError,
} from "../core/host/errors";
import { PaseoMessageHost } from "../hosts/paseo/adapter/host-messages";

async function fixture() {
  const { ChunkedTransport } = await import(
    "../node_modules/paseo-provenance-client/node_modules/@getpaseo/protocol/dist/chunked-transport.js"
  );
  const client = new DaemonClient({
    url: "ws://127.0.0.1:9",
    clientId: "synthetic",
  } as never) as any;
  const writes: any[] = [];
  client.transport = {};
  client.chunkedTransport = new ChunkedTransport({
    frameBytes: 1024 * 1024,
    supportsDrain: true,
    send: (frame: string | Uint8Array) => {
      writes.push(
        JSON.parse(
          typeof frame === "string" ? frame : new TextDecoder().decode(frame),
        ),
      );
    },
    deliver: () => {},
    onFailure: () => {},
  });
  const agent = {
    refresh: async () => true,
    status: "idle",
    archivedAt: null,
    activeTurn: null,
    pendingPermissions: [],
  };
  const host = new PaseoMessageHost({
    api: { agents: { ref: () => agent } },
    provenanceClient: client,
  } as never);
  return { client, host, writes };
}

test("the pinned SDK never queues a send while connecting", async () => {
  const f = await fixture();
  f.client.connectionState = { status: "connecting" };
  await assert.rejects(
    f.host.sendPlannerMessage("agent", { prompt: "hello", messageId: "m" }),
    ProvenPreSendRefusalError,
  );
  f.client.connectionState = { status: "connected" };
  f.client.flushPendingSendQueue();
  assert.equal(f.writes.length, 0);
});

test("the pinned SDK retains a send waiter past admission and accepts its late reply", async () => {
  const f = await fixture();
  f.client.connectionState = { status: "connected" };
  const admission = new Admission({
    startIntervalMs: 0,
    callDeadlineMs: 20,
    log: () => {},
  });
  const error = await admission
    .run(
      "callback",
      () =>
        f.host.sendWhenIdle("agent", {
          prompt: "hello",
          messageId: "m",
          signal: new AbortController().signal,
          timeoutMs: 1000,
        }),
      undefined,
      { holder: "notify:agent" },
    )
    .catch((error) => error);
  assert.ok(error instanceof HostCallAbandonedError);
  assert.equal(f.writes.length, 1);
  assert.equal(
    [...f.client.waiters][0].timeoutHandle,
    null,
    "the SDK waiter is not removed by its default deadline",
  );
  const requestId = f.writes[0].message.requestId;
  f.client.resolveWaiters({
    type: "send_agent_message_response",
    payload: { requestId, accepted: true },
  });
  await error.late;
  assert.equal(f.writes.length, 1);
  assert.equal(f.client.waiters.size, 0);
});
