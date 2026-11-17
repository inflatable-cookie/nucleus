import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebTransport, pairWebSession } from "../client/web/transport";
import { RPC_CATALOGUE } from "../shared/rpc-catalogue";
import type { RpcContract } from "../shared/rpc";

test("the link token is exchanged once and paired calls rely on the browser cookie", async () => {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    if (String(input) === "/api/pair") return new Response("{}", { status: 200 });
    if (String(input) === "/api/events") return new Response("", { status: 200 });
    return new Response(JSON.stringify({ result: { revision: 1 } }), { status: 200 });
  };
  await pairWebSession("one-time-link-token", fetcher);
  await pairWebSession(undefined, fetcher);
  const transport = createWebTransport(fetcher);
  const snapshot = RPC_CATALOGUE.find(entry => entry.name === "queue.ui-snapshot")!.contract as unknown as RpcContract;
  const result = await transport.rpc(snapshot, {} as never);
  await transport.events(new AbortController().signal);
  assert.deepEqual(result, { revision: 1 });
  assert.equal(calls[0]?.authorization, "Bearer one-time-link-token");
  assert.equal(calls[1]?.authorization, null);
  assert.equal(calls[2]?.authorization, null);
  assert.equal(calls[3]?.authorization, null);
});

test("read calls retry after a service restart without retrying mutations", async () => {
  let available = false;
  let reads = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "queue.ui-snapshot") {
      reads++;
      if (!available) throw new TypeError("service stopped");
      return new Response(JSON.stringify({ result: { revision: 2 } }), { status: 200 });
    }
    throw new TypeError("service stopped");
  };
  const transport = createWebTransport(fetcher);
  const snapshot = RPC_CATALOGUE.find(entry => entry.name === "queue.ui-snapshot")!.contract as unknown as RpcContract;
  const pending = transport.rpc(snapshot, {} as never);
  setTimeout(() => { available = true; }, 50);
  assert.deepEqual(await pending, { revision: 2 });
  assert.ok(reads >= 2, "the read reconnects after the service returns");
  const mutation = RPC_CATALOGUE.find(entry => entry.name === "queue.control")!.contract as unknown as RpcContract;
  await assert.rejects(transport.rpc(mutation, {} as never), /service stopped/);
});
