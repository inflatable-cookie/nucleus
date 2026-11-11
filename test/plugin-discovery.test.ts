import test from "node:test";
import assert from "node:assert/strict";
import { pluginCatalogId, pluginRegistration } from "../shared/plugin-discovery.mjs";

test("plugin discovery knows only nucleus; a config naming the retired ID is ignored", () => {
  assert.equal(pluginRegistration({}), null);
  assert.deepEqual(pluginRegistration({ nucleus: { path: "/fixture/plugin" } }), { id: "nucleus", path: "/fixture/plugin" });
  // A registration left under the retired `northstar-queue` ID is never read.
  assert.equal(pluginRegistration({ "northstar-queue": { path: "/old" } }), null);
  assert.equal(pluginRegistration({ "northstar-queue": { path: "/old" }, nucleus: { path: "/new" } })?.id, "nucleus");
  assert.equal(pluginRegistration({ nucleus: { path: "/new", enabled: false } }), null);
  assert.throws(() => pluginRegistration({ nucleus: {} }), /no plugin path/);
  assert.equal(pluginCatalogId([{ id: "nucleus" }]), "nucleus");
  assert.equal(pluginCatalogId([{ id: "other" }, { id: "nucleus" }]), "nucleus");
  assert.throws(() => pluginCatalogId([]), /No Nucleus/);
  assert.throws(() => pluginCatalogId([{ id: "other" }]), /No Nucleus/);
});

test("Paseo CLI routes to nucleus and refuses a catalog without it", async () => {
  const { queueClient } = await import(new URL("../bin/queue-client.mjs", import.meta.url).href);
  const calls: unknown[] = [];
  const fake = { connect: async () => {}, close: () => {}, getPluginCatalog: async () => [{ id: "nucleus" }], invokePluginRpc: async (...args: unknown[]) => { calls.push(args); return "ok"; } };
  const client = await queueClient({ viaPaseo: true, paseoClient: fake });
  await client.connect();
  assert.equal(await client.request("queue.test", { value: 1 }), "ok");
  assert.deepEqual(calls, [["nucleus", "queue.test", { value: 1 }]]);
  client.close();
  const absent = await queueClient({ viaPaseo: true, paseoClient: { connect: async () => {}, close: () => {}, getPluginCatalog: async () => [{ id: "other" }] } });
  await assert.rejects(absent.connect(), /No Nucleus/);
  absent.close();
});
