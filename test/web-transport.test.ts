import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebTransport, scheduleWebTokenRenewal } from "../client/web/transport";
import { RPC_CATALOGUE } from "../shared/rpc-catalogue";
import type { RpcContract } from "../shared/rpc";

test("the web client schedules renewal one minute before expiry", async () => {
  let ran = false;
  const timer = scheduleWebTokenRenewal(60_000, () => { ran = true; }, () => 0);
  await new Promise(resolve => setTimeout(resolve, 10));
  clearTimeout(timer);
  assert.equal(ran, true);
});

test("renewal returns a replacement credential used by API and event requests", async () => {
  const calls: { url: string; authorization: string | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? undefined });
    if (String(input) === "/api/renew") return new Response(JSON.stringify({ token: "replacement", expiresAt: 999_999 }), { status: 200 });
    if (String(input) === "/api/events") return new Response("", { status: 200 });
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  };
  const original = createWebTransport("original", fetcher);
  const renewed = await original.renew();
  assert.deepEqual(renewed, { token: "replacement", expiresAt: 999_999 });
  const replacement = createWebTransport(renewed.token, fetcher);
  const snapshot = RPC_CATALOGUE.find(entry => entry.name === "queue.ui-snapshot")!.contract as unknown as RpcContract;
  await assert.rejects(replacement.rpc(snapshot, {} as never));
  await replacement.events(new AbortController().signal);
  assert.equal(calls[0]?.authorization, "Bearer original");
  assert.equal(calls[1]?.authorization, "Bearer replacement");
  assert.equal(calls[2]?.authorization, "Bearer replacement");
});
