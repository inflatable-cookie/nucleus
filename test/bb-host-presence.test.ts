import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueService } from "../service/transport/server";
import { readServiceInfo } from "../service/transport/identity";
import { ServiceClient } from "../shared/service/client";
import { hostIdFromDataDir } from "../shared/host-operation";
import { runHostChannel } from "../hosts/bb/plugin/channel";
import {
  createHostOperations,
  type BbHostSdk,
} from "../hosts/bb/plugin/operations";
import { socketFixtureDirectory } from "./support/socket-fixture";

/**
 * Spec 062, phase 1: the plugin's own side of registration and presence.
 *
 * The real `runHostChannel` runs against the real owner-only socket with a stub
 * operation executor (nothing writes a host operation in phase 1). It proves the
 * three claims the phase makes about the plugin:
 *
 * - it authenticates, declares the executor role and holds the retained connection;
 * - it requests the same one bridge presence claim the Paseo bridge holds, and a
 *   refused claim is retried on that retained connection until it is granted;
 * - a reload is a reconnect that re-proves the identity, so the service records a
 *   new acceptance rather than resuming the old one.
 */

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** The service's health, read over the same socket the test already holds a client for. */
const holderHealth = (client: ServiceClient) => client.request("service.health", {});

/**
 * The real executor over the two SDK reads `identity.probe` uses (`system.version`
 * and `hosts.list`). Phase 1 sends no other operation, so a call beyond them would be
 * a bug and fails loudly instead of pretending.
 */
const fakeSdk = {
  system: { version: async () => ({ currentVersion: "0.49.0" }) },
  hosts: { list: async () => [{ id: "host_synthetic", status: "connected" }] },
};

const waitUntil = async <T>(
  read: () => Promise<T | undefined> | T | undefined,
  label: string,
  timeoutMs = 10_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (last !== undefined) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
};

test("the BB plugin declares the executor role, claims the one bridge presence, retries a refused claim and re-proves identity on reconnect", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({
    owner: { dataDir: dir, timers: false },
    fixture: "fake",
  });
  await service.start();
  const info = readServiceInfo(dir)!;
  const dataDir = `${dir}/bb-data`;
  const hostId = hostIdFromDataDir(dataDir);
  const holder = new ServiceClient({
    socketPath: info.socketPath,
    credential: info.credential,
  });
  const contender = new ServiceClient({
    socketPath: info.socketPath,
    credential: info.credential,
  });
  const operations = createHostOperations({
    sdk: fakeSdk as unknown as BbHostSdk,
    pluginId: "nucleus",
    sdkVersion: "0.6.132",
    dataDir: () => dataDir,
  });
  const controller = new AbortController();
  const channel = (signal: AbortSignal) =>
    runHostChannel({
      serviceDataDir: dir,
      operations,
      declaration: () => ({
        dataDir,
        bbVersion: "0.49.0",
        sdkVersion: "0.6.132",
      }),
      log: silent,
      signal,
      backoff: { minMs: 20, maxMs: 100 },
      presenceRetryMs: 100,
      // The heartbeat cadence is injected so the run proves the rule, not the clock.
      heartbeatMs: 100,
    });
  const running = channel(controller.signal);
  try {
    // The Paseo bridge holds the one claim first, so the plugin's claims are refused.
    await holder.connect();
    assert.deepEqual(
      await holder.request("service.nucleus-bridge-presence", {}),
      { active: true },
    );
    await waitUntil(
      () => (service.hostExecutorIds().includes(hostId) ? true : undefined),
      "the plugin declares the role",
    );
    await contender.connect();
    assert.deepEqual(
      await contender.request("service.nucleus-bridge-presence", {}),
      { active: false },
      "the holder keeps the claim while the plugin retries",
    );

    // The holder leaves; the plugin's retry on its retained connection is granted.
    await holder.close();
    const granted = await waitUntil(
      async () => {
        const answer = (await contender.request(
          "service.nucleus-bridge-presence",
          {},
        )) as { active?: boolean };
        return answer.active === false ? true : undefined;
      },
      "the plugin's retry takes the claim",
      5_000,
    );
    assert.equal(
      granted,
      true,
      "the plugin holds the claim after the retry, so another host is refused",
    );

    // The retained connection carries the plugin's own liveness heartbeat: health
    // records when the last one arrived and reports it fresh (Spec 062, "Identity,
    // connection and faults").
    const beat = await waitUntil(async () => {
      const health = (await holderHealth(contender)) as {
        bb?: { hosts?: Array<{ lastHeartbeatAt: string | null; heartbeatStale: boolean }> };
      };
      const record = health.bb?.hosts?.[0];
      return record?.lastHeartbeatAt ? record : undefined;
    }, "the plugin's heartbeat reaches the service");
    assert.equal(beat.heartbeatStale, false, "a heartbeat that arrived is not stale");

    // The declaration's acceptance is the connection's own identity proof.
    const first = service.hostExecutorStatus(hostId);
    assert.ok(
      first,
      "the service accepted the declaration for the derived identity",
    );
    assert.equal(first.dataDir, dataDir);
    assert.equal(first.bbVersion, "0.49.0");

    // A plugin reload is a reconnect: the identity is proved again on a new connection.
    controller.abort();
    await running;
    await waitUntil(
      () => (service.hostExecutorIds().includes(hostId) ? undefined : true),
      "the reload released the identity",
    );
    const second = new AbortController();
    const restarted = channel(second.signal);
    try {
      const acceptance = await waitUntil(() => {
        const status = service.hostExecutorStatus(hostId);
        return status && status.connectedAt !== first.connectedAt
          ? status
          : undefined;
      }, "the reconnect is accepted afresh");
      assert.deepEqual(
        service.hostExecutorIds(),
        [hostId],
        "one identity, not two",
      );
      assert.equal(acceptance.dataDir, dataDir);
    } finally {
      second.abort();
      await restarted;
    }
  } finally {
    controller.abort();
    await running.catch(() => {});
    await holder.close();
    await contender.close();
    await service.stop();
  }
});
