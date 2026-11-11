import { join } from "node:path";
import { hostRunStateDirForDataDir } from "../service/callbacks/host-run-endpoint";
import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueService } from "../service/transport/server";
import { ServiceClient } from "../shared/service/client";
import { readServiceInfo } from "../service/transport/identity";
import { socketFixtureDirectory } from "./support/socket-fixture";
import type { SnapshotState } from "../shared/contracts";

test("board dispatch hold survives a service restart and keeps the pause authority boundary", async () => {
  const dataDir = socketFixtureDirectory("queue-service.sock");
  const hostRunStateDir = join(dataDir, "host-run");
  assert.equal(hostRunStateDirForDataDir(dataDir), hostRunStateDir);
  // Keep scheduler files and sockets inside this fixture, away from the live HOME.
  const makeService = () =>
    new QueueService({ owner: { dataDir, hostRunStateDir, timers: false }, fixture: "fake" });
  let service = makeService();
  let client: ServiceClient | undefined;
  try {
    await service.start();
    let info = readServiceInfo(dataDir)!;
    client = new ServiceClient({
      socketPath: info.socketPath,
      credential: info.credential,
    });
    await client.connect();
    await client.request("queue.control", { dispatchHeld: true });
    const held = (await client.request("queue.snapshot", {})) as SnapshotState;
    assert.equal(held.dispatchHeld, true);
    assert.equal(held.paused, true, "changing hold leaves pause unchanged");
    await client.close();
    await service.stop();
    service = makeService();
    await service.start();
    info = readServiceInfo(dataDir)!;
    client = new ServiceClient({
      socketPath: info.socketPath,
      credential: info.credential,
    });
    await client.connect();
    assert.equal(
      ((await client.request("queue.snapshot", {})) as SnapshotState)
        .dispatchHeld,
      true,
    );
    await assert.rejects(
      client.request("queue.control", {
        dispatchHeld: false,
        callerTaskId: "agent",
        callerRunId: "run",
      }),
      /Unrecognized|invalid/i,
    );
    const agent = new ServiceClient({
      socketPath: info.socketPath,
      credential: "a".repeat(64),
    });
    try {
      await assert.rejects(
        agent.connect(),
        /credential|authentication|unauthenticated/i,
      );
    } finally {
      await agent.close();
    }
    assert.equal(
      ((await client.request("queue.snapshot", {})) as SnapshotState)
        .dispatchHeld,
      true,
    );
    await client.request("queue.control", { dispatchHeld: false });
    assert.equal(
      ((await client.request("queue.snapshot", {})) as SnapshotState)
        .dispatchHeld,
      false,
    );
  } finally {
    await client?.close();
    await service.stop();
  }
});
