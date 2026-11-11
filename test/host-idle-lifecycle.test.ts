import { observeIdle } from './support/fakes';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueRuntime } from "../service/runtime-owner";
import { Store } from "../core/store/store";
import { QueueService } from "../service/transport/server";
import { ServiceClient } from "../shared/service/client";
import { readServiceInfo } from "../service/transport/identity";
import {
  localQueueClient,
  LocalServiceUnavailable,
} from "../shared/service/local-client";
import { socketFixtureDirectory } from "./support/socket-fixture";
import { hostRunSettlementSchema } from "../shared/contracts";
import type { Adapter } from "../core/host/adapter";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
}

/** One fixture host with a connection a test can take away and give back. */
function hostFixture(
  dir: string,
  options: { connected?: boolean; offline?: boolean } = {},
) {
  const client = { isConnected: options.connected ?? true };
  const raw = {
    client,
    hostId: "fixture-host",
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "worker-helper.mjs"),
    connect: async () => {
      if (options.offline) throw new Error("the fixture host is offline");
      client.isConnected = true;
    },
    close: async () => {
      client.isConnected = false;
    },
    catalog: async () => ({ providers: [] }),
    observe: observeIdle("ws", "worker"),
  } as unknown as Adapter;
  return { client, raw };
}

function settledRun(runId: string) {
  return hostRunSettlementSchema.parse({
    format: "host.run.settlement",
    version: 1,
    runId,
    outcome: "lost",
    launched: true,
    settledAt: new Date().toISOString(),
    result: null,
    containers: [],
  });
}

test("the daemon closes only after the idle grace and a reconnect inside it cancels the shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idle-grace-"));
  const host = hostFixture(dir);
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => host.raw,
    timers: false,
    hostIdleGraceMs: 150,
  });
  try {
    await runtime.started;
    await runtime.bootstrap;
    assert.equal(
      runtime.hostRegistry.known().length,
      1,
      "the connected host is recorded",
    );
    assert.equal(
      runtime.hostShutdownDue(),
      false,
      "a connected host keeps the daemon alive",
    );
    host.client.isConnected = false;
    assert.equal(
      runtime.hostShutdownDue(),
      false,
      "the last host just left; the grace has not run out",
    );
    await sleep(190);
    // The reconnect lands after the grace would have expired: only cancelling it
    // keeps the daemon open, a later decision would already have latched.
    host.client.isConnected = true;
    await runtime.ensureBootstrap();
    await sleep(190);
    assert.equal(
      runtime.hostShutdownDue(),
      false,
      "a reconnect inside the grace cancels the shutdown",
    );
    host.client.isConnected = false;
    assert.equal(
      runtime.hostShutdownDue(),
      false,
      "the grace starts again from this close",
    );
    await sleep(190);
    assert.equal(
      runtime.hostShutdownDue(),
      true,
      "with no host and no live run the grace closes the daemon",
    );
  } finally {
    await runtime.drain();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live host run holds the daemon past the grace and the shutdown follows once it settles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idle-run-"));
  const host = hostFixture(dir);
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => host.raw,
    timers: false,
    hostIdleGraceMs: 120,
  });
  try {
    await runtime.started;
    await runtime.bootstrap;
    host.client.isConnected = false;
    assert.equal(runtime.hostShutdownDue(), false);
    await sleep(160);
    const id = "idle-grace-run";
    runtime.hostRuns.submit(
      {
        id,
        epoch: runtime.hostRuns.authority().epoch,
        caller: "test:idle-grace",
        repository: {
          origin: "https://github.com/example/project",
          path: "/fixture",
        },
        selector: "qa",
        runClass: "light",
        classSource: "default",
        priority: "interactive",
        runTimeoutMs: 60_000,
        submissionSource: "admission",
      },
      {
        launch: (run) => {
          runtime.hostRuns.markLaunched(run.id);
        },
      },
    );
    assert.equal(runtime.hostRuns.get(id)?.state, "running");
    await sleep(160);
    assert.equal(
      runtime.hostShutdownDue(),
      false,
      "an active host run keeps the daemon alive past the grace",
    );
    runtime.hostRuns.settle(id, settledRun(id));
    assert.equal(
      runtime.hostShutdownDue(),
      true,
      "the shutdown follows once the run settles",
    );
  } finally {
    await runtime.drain();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart inside the grace resumes the same clock instead of granting a fresh one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idle-restart-"));
  const graceMs = 800;
  const host = hostFixture(dir);
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => host.raw,
    timers: false,
    hostIdleGraceMs: graceMs,
  });
  let disconnectedAt: number;
  try {
    await runtime.started;
    await runtime.bootstrap;
    host.client.isConnected = false;
    assert.equal(runtime.hostShutdownDue(), false);
    disconnectedAt = runtime.store.getMeta<number>("hostDisconnectedAt") ?? 0;
    assert.ok(disconnectedAt > 0, "the last host close is durable");
    await sleep(300);
  } finally {
    await runtime.drain();
  }
  const offline = hostFixture(dir, { connected: false, offline: true });
  const restarted = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => offline.raw,
    timers: false,
    hostIdleGraceMs: graceMs,
  });
  try {
    await restarted.started;
    await restarted.bootstrap;
    assert.equal(
      restarted.hostRegistry.disconnectedAt(),
      disconnectedAt,
      "the restart restores the recorded last close",
    );
    assert.equal(
      restarted.hostRegistry.shutdownDueAt(),
      disconnectedAt + graceMs,
      "the due instant is the original close plus one grace",
    );
    assert.equal(
      restarted.store.getMeta<number>("hostDisconnectedAt"),
      disconnectedAt,
    );
    const remaining = disconnectedAt + graceMs - Date.now();
    assert.ok(
      remaining < graceMs,
      "the restart resumes the clock instead of starting another full grace",
    );
    if (remaining > 0)
      assert.equal(
        restarted.hostShutdownDue(),
        false,
        "it still waits out the little grace that is left",
      );
    await sleep(Math.max(remaining, 0) + 100);
    assert.equal(
      restarted.hostShutdownDue(),
      true,
      "the restored timer is caught up",
    );
  } finally {
    await restarted.drain();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ordinary CLI call refuses without a daemon and starts nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idle-cli-"));
  const client = localQueueClient(dir, {
    compatibilityWaitMs: 50,
    onProgress: () => {},
  });
  try {
    await assert.rejects(
      () => client.request("queue.snapshot", {}),
      (error: unknown) =>
        error instanceof LocalServiceUnavailable &&
        /load the Nucleus plugin/.test(error.message),
    );
    assert.deepEqual(
      readdirSync(dir),
      [],
      "the CLI writes no identity, socket, store or spawn record",
    );
  } finally {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an old store without a close record gets one grace, and a legacy host record alone supplies no clock", async () => {
  // A newer build over an older store: the registry exists but nothing recorded
  // when the host closed. It starts one grace rather than closing at once on a
  // guess, and never reads the unknown as "the host left long ago".
  const dir = mkdtempSync(join(tmpdir(), "idle-old-store-"));
  const seeded = new Store(join(dir, "queue.sqlite"));
  try {
    seeded.setMeta("hostId", "fixture-host");
    seeded.setMeta("hostRegistry", [
      { id: "fixture-host", endpoint: "ws://127.0.0.1:6767/ws" },
    ]);
  } finally {
    seeded.close();
  }
  const host = hostFixture(dir, { connected: false, offline: true });
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => host.raw,
    timers: false,
    hostIdleGraceMs: 200,
  });
  try {
    await runtime.started;
    await runtime.bootstrap;
    assert.notEqual(
      runtime.hostRegistry.disconnectedAt(),
      null,
      "a known host with no recorded close starts the grace now",
    );
    assert.equal(runtime.hostShutdownDue(), false, "the grace has not run out");
    await sleep(240);
    assert.equal(
      runtime.hostShutdownDue(),
      true,
      "the started grace then runs out normally",
    );
  } finally {
    await runtime.drain();
    rmSync(dir, { recursive: true, force: true });
  }
  // A legacy single-host record names an identity, not a connection: with no
  // observed host there is no evidence that anything left, so there is no clock.
  const legacyDir = mkdtempSync(join(tmpdir(), "idle-legacy-store-"));
  const legacyStore = new Store(join(legacyDir, "queue.sqlite"));
  try {
    legacyStore.setMeta("hostId", "fixture-host");
  } finally {
    legacyStore.close();
  }
  const offline = hostFixture(legacyDir, { connected: false, offline: true });
  const legacy = new QueueRuntime({
    dataDir: legacyDir,
    adapterFactory: () => offline.raw,
    timers: false,
    hostIdleGraceMs: 100,
  });
  try {
    await legacy.started;
    await legacy.bootstrap;
    assert.equal(
      legacy.hostRegistry.known().length,
      0,
      "a legacy identity is not a live or observed host",
    );
    assert.equal(legacy.hostRegistry.disconnectedAt(), null);
    await sleep(160);
    assert.equal(
      legacy.hostShutdownDue(),
      false,
      "an unknown host waits; it is never permission to close",
    );
  } finally {
    await legacy.drain();
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

/** Seed the durable registry as a daemon that restarted inside its grace would find it. */
function seedClosedHost(dataDir: string, disconnectedAt: number) {
  const store = new Store(join(dataDir, "queue.sqlite"));
  try {
    store.setMeta("hostId", "fixture-host");
    store.setMeta("hostRegistry", [
      { id: "fixture-host", endpoint: "ws://127.0.0.1:6767/ws" },
    ]);
    store.setMeta("hostDisconnectedAt", disconnectedAt);
  } finally {
    store.close();
  }
}

test("the local daemon drains itself after the last host leaves, and a bridge presence holds it open", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({
    owner: { dataDir: dir, timers: false, hostIdleGraceMs: 300 },
    fixture: "fake",
    debug: true,
    hostLifecycle: true,
    hostLifecycleIntervalMs: 20,
  });
  let bridge: ServiceClient | null = null;
  try {
    await service.start();
    const info = readServiceInfo(dir)!;
    bridge = new ServiceClient({
      socketPath: info.socketPath,
      credential: info.credential,
    });
    await bridge.connect();
    await bridge.request("service.nucleus-bridge-presence", {});
    // The app leaves: its native connection and its bridge presence both go.
    await service.debug({
      target: "fixture",
      action: "set-host-offline",
      value: true,
    });
    await sleep(360);
    assert.equal(
      service.drainingNow,
      false,
      "a bridge presence keeps the daemon open past the grace",
    );
    await bridge.close();
    bridge = null;
    await waitUntil(() => service.drainingNow, 3_000);
    assert.equal(
      service.drainingNow,
      true,
      "the daemon closes once the last host and its presence are gone",
    );
    await service.drainedPromise();
    assert.equal(
      existsSync(join(dir, "queue-service.json")),
      false,
      "the idle drain released the service identity",
    );
    assert.equal(
      existsSync(join(dir, "queue-service.sock")),
      false,
      "the idle drain released the socket",
    );
  } finally {
    await bridge?.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a daemon restarted past its grace closes on the next check instead of serving another full grace", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const graceMs = 3_000;
  seedClosedHost(dir, Date.now() - graceMs - 1_000);
  const service = new QueueService({
    owner: { dataDir: dir, timers: false, hostIdleGraceMs: graceMs },
    fixture: "fake",
    fixtureState: { hostOffline: true },
    debug: true,
    hostLifecycle: true,
    hostLifecycleIntervalMs: 20,
  });
  try {
    await service.start();
    await waitUntil(() => service.drainingNow, 1_000);
    assert.equal(
      service.drainingNow,
      true,
      "the restored, already-expired grace closes the daemon at once",
    );
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bridge presence cancels a due shutdown, and its close starts the grace again", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const graceMs = 1_200;
  seedClosedHost(dir, Date.now() - graceMs - 1_000);
  const service = new QueueService({
    owner: { dataDir: dir, timers: false, hostIdleGraceMs: graceMs },
    fixture: "fake",
    fixtureState: { hostOffline: true },
    debug: true,
    hostLifecycle: true,
    hostLifecycleIntervalMs: 100,
  });
  let bridge: ServiceClient | null = null;
  try {
    await service.start();
    const info = readServiceInfo(dir)!;
    bridge = new ServiceClient({
      socketPath: info.socketPath,
      credential: info.credential,
    });
    await bridge.connect();
    await bridge.request("service.nucleus-bridge-presence", {});
    await sleep(1_500);
    assert.equal(
      service.drainingNow,
      false,
      "presence cancels a shutdown the expired grace would have decided",
    );
    await bridge.close();
    bridge = null;
    // The close restarts the grace, and nothing closes before it runs out.
    await sleep(400);
    assert.equal(
      service.drainingNow,
      false,
      "the grace runs again from the presence close",
    );
    await waitUntil(() => service.drainingNow, graceMs + 2_000);
    assert.equal(
      service.drainingNow,
      true,
      "with the presence gone the daemon closes after the grace",
    );
  } finally {
    await bridge?.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
