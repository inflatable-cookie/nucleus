import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeLifecycle,
  type RuntimeLifecycleOwner,
} from "../service/runtime-lifecycle";

/**
 * nucleus#1139 review: a secondary host coming online owes one catalog
 * refresh; steady-state bootstrap ticks and a disconnected primary change
 * nothing, and the bootstrap chain never rejects unhandled.
 *
 * The arrival refresh is a lifecycle mechanism, so its boundary is the
 * lifecycle owner: a T3 status and a catalog read.
 */

interface ArrivalHost {
  refreshes: number[];
  connected: boolean;
}

const stub = (connected: boolean) => {
  const host: ArrivalHost = { refreshes: [], connected };
  const owner = {
    t3Host: {
      status: () => ({ connected: host.connected }),
      ensureConnected: async () => undefined,
    },
    engine: {
      refresh: async () => {
        host.refreshes.push(host.refreshes.length + 1);
      },
    },
    store: { prStateTasks: () => [], advanceRevision: () => undefined },
    hostRegistry: { known: () => [] },
    plannerTickets: { ensure: async () => undefined },
    adapter: { connect: async () => undefined },
    admission: {},
    daemonUrl: "ws://127.0.0.1:6767/ws",
    connectTimeoutMs: 10,
    paseoHostId: "fixture-host",
    hostSession: null,
    idleShutdownLatched: false,
    connected: () => false,
    readPrStates: async () => ({}),
  } as unknown as RuntimeLifecycleOwner;
  return { host, lifecycle: new RuntimeLifecycle(owner) };
};

test("one refresh on secondary arrival, none on steady ticks, one again after a reconnect", async () => {
  const { host, lifecycle } = stub(true);
  await lifecycle.refreshOnSecondaryArrival();
  await lifecycle.refreshOnSecondaryArrival();
  await lifecycle.refreshOnSecondaryArrival();
  assert.equal(host.refreshes.length, 1, "the arrival refresh runs once, not per tick");
  host.connected = false;
  await lifecycle.refreshOnSecondaryArrival();
  assert.equal(host.refreshes.length, 1, "a disconnection refreshes nothing and rejects nothing");
  host.connected = true;
  await lifecycle.refreshOnSecondaryArrival();
  assert.equal(host.refreshes.length, 2, "a reconnect owes one fresh catalog read");
});
