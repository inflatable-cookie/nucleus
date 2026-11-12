import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueRuntime } from "../service/runtime-owner";

/**
 * nucleus#1139 review: a secondary host coming online owes one catalog
 * refresh; steady-state bootstrap ticks and a disconnected primary change
 * nothing, and the bootstrap chain never rejects unhandled.
 */

interface ArrivalHost {
  refreshes: number[];
  connected: boolean;
  refresh: () => Promise<void>;
  refreshOnSecondaryArrival: () => Promise<void>;
}

const stub = (connected: boolean) => {
  const host = {
    refreshes: [] as number[],
    connected,
    refresh: () => { host.refreshes.push(host.refreshes.length + 1); return Promise.resolve(); },
  };
  const runtime = Object.assign(Object.create(QueueRuntime.prototype), {
    t3Host: { status: () => ({ connected: host.connected }) },
    refresh: host.refresh,
    secondaryOnline: false,
  }) as unknown as ArrivalHost & { refreshOnSecondaryArrival: () => Promise<void> };
  return { host, runtime };
};

test("one refresh on secondary arrival, none on steady ticks, one again after a reconnect", async () => {
  const { host, runtime } = stub(true);
  await runtime.refreshOnSecondaryArrival();
  await runtime.refreshOnSecondaryArrival();
  await runtime.refreshOnSecondaryArrival();
  assert.equal(host.refreshes.length, 1, "the arrival refresh runs once, not per tick");
  host.connected = false;
  await runtime.refreshOnSecondaryArrival();
  assert.equal(host.refreshes.length, 1, "a disconnection refreshes nothing and rejects nothing");
  host.connected = true;
  await runtime.refreshOnSecondaryArrival();
  assert.equal(host.refreshes.length, 2, "a reconnect owes one fresh catalog read");
});
