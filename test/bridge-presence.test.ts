import { bridgeProcessActions } from "../service/install/bridge-process-actions";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { QueueService } from "../service/transport/server";
import { ServiceBridge } from "../hosts/paseo/plugin/bridge";
import { ServiceClient } from "../shared/service/client";
import { readServiceInfo } from "../service/transport/identity";
import { socketFixtureDirectory } from "./support/socket-fixture";

const checkout = fileURLToPath(new URL("..", import.meta.url));

test("the first bridge presence claim holds until its connection closes", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  await service.start();
  const info = readServiceInfo(dir)!;
  const client = () => new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  const first = client(), second = client();
  try {
    await first.connect();
    await second.connect();
    assert.deepEqual(await first.request("service.nucleus-bridge-presence", {}), { active: true });
    assert.deepEqual(await second.request("service.nucleus-bridge-presence", {}), { active: false });
    await first.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(await second.request("service.nucleus-bridge-presence", {}), { active: true });
  } finally {
    await second.close();
    await first.close();
    await service.stop();
  }
});

test("a refused presence claim is retried on the retained connection until it is granted", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  await service.start();
  const info = readServiceInfo(dir)!;
  const holder = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  const probe = () => new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  const bridge = new ServiceBridge({ processActions: bridgeProcessActions,
    dataDir: dir,
    sourcePath: checkout,
    sessionId: info.sessionId,
    serviceCommand: () => { throw new Error("must not spawn over a live claimed service"); },
  });
  try {
    await holder.connect();
    assert.deepEqual(await holder.request("service.nucleus-bridge-presence", {}), { active: true });
    const state = await bridge.serviceState();
    assert.equal(state.state, "running", "a refused claim still keeps the health-matching service");
    const whileHeld = probe();
    await whileHeld.connect();
    assert.deepEqual(await whileHeld.request("service.nucleus-bridge-presence", {}), { active: false });
    await whileHeld.close();
    await holder.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    await bridge.serviceState();
    const after = probe();
    await after.connect();
    assert.deepEqual(
      await after.request("service.nucleus-bridge-presence", {}),
      { active: false },
      "the second bridge retried and now holds the claim",
    );
    await after.close();
  } finally {
    bridge.close();
    await holder.close();
    await service.stop();
  }
});

test("the retired legacy presence RPC is gone, so an old bridge cannot claim presence", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  await service.start();
  const info = readServiceInfo(dir)!;
  const bridge = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  try {
    await bridge.connect();
    await assert.rejects(bridge.request("service.host-presence", {}), /method_unknown|unknown method/i);
    // The claim stayed free: the nucleus bridge presence answers active.
    assert.deepEqual(await bridge.request("service.nucleus-bridge-presence", {}), { active: true });
  } finally {
    await bridge.close();
    await service.stop();
  }
});
