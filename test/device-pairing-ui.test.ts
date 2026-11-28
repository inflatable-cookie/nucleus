import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs } from "./support/render";
import { HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, waitFor } from "./support/budgets";

useNativeStubs();
const h = React.createElement;
const colors = new Proxy({}, { get: () => "#123" }) as never;
const settle = (probe: () => boolean) =>
  waitFor(probe, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, "pairing UI to settle");

test("DevicesSettings shows the short code and countdown after pressing Pair a device", async (t) => {
  const { DevicesSettings } = await import("../client/web/device-pairing");
  let nowMs = 1_000_000;
  const requests: Array<{ url: string; method?: string; headers?: unknown }> =
    [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers,
    });
    return new Response(
      JSON.stringify({ code: "K7QM-3XRD", expiresAtMs: nowMs + 300_000 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const ui = mount(
    h(DevicesSettings, { c: colors, inset: 16, fetcher, now: () => nowMs }),
  );
  t.after(() => ui.update(h("View")));

  assert.ok(ui.get("Pair a device"));
  assert.equal(ui.query("Device pairing code"), undefined);
  ui.press("Pair a device");
  await settle(() => ui.text().includes("K7QM-3XRD"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/engine/pair/code");
  assert.equal(requests[0].method, "POST");
  assert.match(ui.text(), /Expires in 5:00/);

  nowMs += 300_000;
  ui.update(
    h(DevicesSettings, { c: colors, inset: 16, fetcher, now: () => nowMs }),
  );
  assert.match(ui.text(), /Code expired/);
});

test("DevicePairPrompt shows a code field, reports invalid codes, and calls onPaired on success", async (t) => {
  const { DevicePairPrompt } = await import("../client/web/device-pairing");
  let paired = 0;
  const calls: Array<{ url: string; body?: string }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url: String(url), body });
    const parsed = JSON.parse(body) as { code?: string };
    if (parsed.code === "K7QM-3XRD") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const ui = mount(
    h(DevicePairPrompt, {
      c: colors,
      fetcher,
      onPaired: () => {
        paired++;
      },
    }),
  );
  t.after(() => ui.update(h("View")));

  assert.ok(ui.get("Pairing code"));
  assert.ok(ui.get("Pair"));
  ui.type("Pairing code", "WRONG-CODE");
  ui.press("Pair");
  await settle(() => ui.text().includes("Invalid or expired code."));
  assert.equal(paired, 0);

  ui.type("Pairing code", "K7QM-3XRD");
  ui.press("Pair");
  await settle(() => paired === 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "/api/engine/pair/redeem");
});
