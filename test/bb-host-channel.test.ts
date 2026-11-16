import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { QueueService } from "../service/transport/server";
import { readServiceInfo } from "../service/transport/identity";
import { ServiceClient } from "../shared/service/client";
import { createFrameReader, encodeFrame, PROTOCOL_VERSION } from "../shared/service/protocol";
import { HostOperationRefusedError, HostOperationUnknownDeliveryError } from "../service/host-executor";
import { hostIdFromDataDir, type HostExecutorDeclaration } from "../shared/host-operation";
import { socketFixtureDirectory } from "./support/socket-fixture";

/**
 * The reverse host-operation role end to end over the real owner-only socket.
 *
 * Assumption 2 of Spec 062 is the reason this file exists: the role must ride the
 * existing socket without disturbing the bridge presence claim, roll recovery or the
 * request path. So the assertion is not just "an executor can declare" — the same
 * service must keep answering the catalogue, keep granting one presence claim, and
 * treat a replacement connection as a reload whose in-flight work is unknown, never
 * replayed.
 */
class ExecutorClient {
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  /** What this fake executor answers. Defaults to refusing every operation. */
  answer: (op: string, input: unknown) => Promise<unknown> = async () => { throw Object.assign(new Error("this executor answers nothing"), { name: "HostOperationError", code: "unavailable" }); };
  received: Array<{ id: string; op: string; input: unknown }> = [];

  private constructor(private readonly socket: Socket, readonly acceptance: Record<string, unknown>) {}

  get closed(): boolean { return this.socket.destroyed; }

  static connect(identity: { socketPath: string; credential: string }, declaration: HostExecutorDeclaration): Promise<ExecutorClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(identity.socketPath);
      let client: ExecutorClient | null = null;
      let declared = false;
      const reader = createFrameReader(frame => {
        const value = frame as { id?: string; result?: Record<string, unknown>; error?: { code: string; message: string } };
        if (typeof value.id !== "string") return;
        if (!declared && value.id.startsWith("decl-")) {
          if (value.error) { reject(new Error(value.error.message)); return; }
          declared = true;
          resolve(client!);
          return;
        }
        if (!declared && value.id === "auth-1") {
          if (value.error) { reject(new Error(value.error.message)); return; }
          socket.write(encodeFrame({ v: PROTOCOL_VERSION, id: "decl-1", method: "service.host-executor", input: declaration }));
          return;
        }
        if (!declared) return;
        // A reverse request from the service.
        const request = frame as { id: string; method: string; input: { op: string; input: unknown } };
        client!.received.push({ id: request.id, op: request.input.op, input: request.input.input });
        void client!.answer(request.input.op, request.input.input).then(
          result => socket.write(encodeFrame({ v: PROTOCOL_VERSION, id: request.id, result })),
          error => socket.write(encodeFrame({ v: PROTOCOL_VERSION, id: request.id, error: { code: (error as { code?: string }).code ?? "internal", message: error instanceof Error ? error.message : String(error) } })),
        );
        return;
      }, error => reject(new Error(`protocol fault: ${error.message}`)));
      socket.on("data", chunk => reader.feed(chunk));
      socket.on("error", error => reject(error));
      socket.on("connect", () => {
        client = new ExecutorClient(socket, {});
        socket.write(encodeFrame({ v: PROTOCOL_VERSION, id: "auth-1", method: "service.auth", input: { credential: identity.credential } }));
      });
    });
  }

  /** A raw handshake used by the refusal cases, which are expected to fail. */
  static rawHandshake(identity: { socketPath: string; credential: string }, frames: unknown[]): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
    return new Promise((resolve, reject) => {
      const socket = connect(identity.socketPath);
      const reader = createFrameReader(frame => {
        const value = frame as { id?: string; result?: unknown; error?: { code: string; message: string } };
        if (value.id !== (frames[frames.length - 1] as { id?: string }).id) return;
        resolve(value);
        socket.destroy();
      }, error => reject(new Error(error.message)));
      socket.on("data", chunk => reader.feed(chunk));
      socket.on("error", reject);
      socket.on("connect", () => { for (const frame of frames) socket.write(encodeFrame(frame)); });
    });
  }

  close(): void { this.socket.destroy(); }
}

const declarationFor = (dataDir: string): HostExecutorDeclaration => ({
  role: "host-executor",
  host: { dataDir, bbVersion: "0.49.0", sdkVersion: "0.6.132" },
});

test("the host-executor role rides the owner-only socket without disturbing presence or the request path", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  await service.start();
  const info = readServiceInfo(dir)!;
  const bridge = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  let executor: ExecutorClient | null = null;
  try {
    await bridge.connect();
    assert.deepEqual(await bridge.request("service.nucleus-bridge-presence", {}), { active: true });
    executor = await ExecutorClient.connect(info, declarationFor("/tmp/bb-data"));
    const hostId = hostIdFromDataDir("/tmp/bb-data");
    assert.deepEqual(service.hostExecutorIds(), [hostId]);

    // The existing request path still answers, roll recovery included.
    const health = await bridge.request("service.health", {}) as { service: string; protocolVersion: number };
    assert.equal(health.service, "nucleus");
    assert.equal(health.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(await bridge.request("service.request-outcome", { key: "unheard-of" }), { status: "not_received" });

    // Presence is still one claim, held by the bridge, and the executor never took it.
    const contender = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
    await contender.connect();
    try {
      assert.deepEqual(await contender.request("service.nucleus-bridge-presence", {}), { active: false });
    } finally {
      await contender.close();
    }

    // A bounded operation travels to the executor and its answer comes back validated.
    executor.answer = async (op, input) => ({
      operation: op,
      at: "2026-11-16T00:00:00.000Z",
      calls: { "threads.get": 1 },
      value: { threadId: (input as { threadId: string }).threadId, title: "Synthetic", status: "idle", displayStatus: "idle", environmentId: "env_1", parentThreadId: null, parentNotifications: "off", pluginMetadata: null, archivedAt: null, queuedWork: null },
    });
    const observed = await service.sendHostOperation(hostId, "thread.observe", { threadId: "thr_1" });
    assert.equal((observed.value as { environmentId: string }).environmentId, "env_1");
    assert.deepEqual(observed.calls, { "threads.get": 1 });
    assert.deepEqual(executor.received.map(entry => entry.op), ["thread.observe"]);
  } finally {
    executor?.close();
    await bridge.close();
    await service.stop();
  }
});

test("a replacement executor connection is a reload: in-flight work is unknown, never replayed", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  await service.start();
  const info = readServiceInfo(dir)!;
  const hostId = hostIdFromDataDir("/tmp/bb-data");
  let first: ExecutorClient | null = null;
  let second: ExecutorClient | null = null;
  try {
    first = await ExecutorClient.connect(info, declarationFor("/tmp/bb-data"));
    // Nothing answers this operation before the reload.
    first.answer = () => new Promise(() => {});
    const inFlight = assert.rejects(
      service.sendHostOperation(hostId, "call.counters", {}),
      (error: unknown) => error instanceof HostOperationUnknownDeliveryError && /newer connection/.test(error.message),
    );
    second = await ExecutorClient.connect(info, declarationFor("/tmp/bb-data"));
    await inFlight;
    assert.deepEqual(service.hostExecutorIds(), [hostId]);

    second.answer = async op => ({ operation: op, at: "2026-11-16T00:00:00.000Z", calls: { "system.version": 1 }, value: { dataDir: "/tmp/bb-data", bbVersion: "0.49.0", sdkVersion: "0.6.132", hostIds: ["host_1"] } });
    const probed = await service.sendHostOperation(hostId, "identity.probe", {});
    assert.deepEqual((probed.value as { hostIds: string[] }).hostIds, ["host_1"]);
    // The uncertain operation was settled unknown, not replayed on the replacement.
    assert.deepEqual(first.received.map(entry => entry.op), ["call.counters"]);
    assert.deepEqual(second.received.map(entry => entry.op), ["identity.probe"]);
  } finally {
    first?.close();
    second?.close();
    await service.stop();
  }
});

test("a declaration that is missing a required field, or arrives before auth, is refused by name", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  await service.start();
  const info = readServiceInfo(dir)!;
  try {
    const partial = await ExecutorClient.rawHandshake(info, [
      { v: PROTOCOL_VERSION, id: "auth", method: "service.auth", input: { credential: info.credential } },
      { v: PROTOCOL_VERSION, id: "decl", method: "service.host-executor", input: { role: "host-executor", host: { dataDir: "/tmp/bb-data", bbVersion: "0.49.0" } } },
    ]);
    assert.equal(partial.error?.code, "invalid_input");
    assert.match(partial.error?.message ?? "", /sdkVersion/);
    assert.deepEqual(service.hostExecutorIds(), []);

    const unauthenticated = await ExecutorClient.rawHandshake(info, [
      { v: PROTOCOL_VERSION, id: "decl", method: "service.host-executor", input: declarationFor("/tmp/bb-data") },
    ]);
    assert.equal(unauthenticated.error?.code, "unauthenticated");
  } finally {
    await service.stop();
  }
});

test("a malformed executor answer settles that operation, and the connection keeps working", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  await service.start();
  const info = readServiceInfo(dir)!;
  const hostId = hostIdFromDataDir("/tmp/bb-data");
  let executor: ExecutorClient | null = null;
  try {
    executor = await ExecutorClient.connect(info, declarationFor("/tmp/bb-data"));
    executor.answer = async op => ({ operation: op, at: "2026-11-16T00:00:00.000Z", calls: {}, value: { threadId: "thr_1" } });
    await assert.rejects(
      service.sendHostOperation(hostId, "thread.observe", { threadId: "thr_1" }),
      (error: unknown) => error instanceof HostOperationUnknownDeliveryError && /environmentId/.test(error.message),
    );
    // The same connection answers the next operation, so one fault settled one operation.
    executor.answer = async op => ({ operation: op, at: "2026-11-16T00:00:00.000Z", calls: {}, value: { counters: {}, loadedAt: 1 } });
    const counters = await service.sendHostOperation(hostId, "call.counters", {});
    assert.deepEqual(counters.value, { counters: {}, loadedAt: 1 });
    assert.equal(executor.received.length, 2);
  } finally {
    executor?.close();
    await service.stop();
  }
});

test("over the real socket only a proven pre-write refusal is definite; a post-write failure is unknown", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  await service.start();
  const info = readServiceInfo(dir)!;
  const hostId = hostIdFromDataDir("/tmp/bb-data");
  let executor: ExecutorClient | null = null;
  try {
    executor = await ExecutorClient.connect(info, declarationFor("/tmp/bb-data"));
    // The plugin proved this before writing: a caller may stop here.
    executor.answer = async () => { throw Object.assign(new Error("the cascade also names thr_foreign"), { code: "refused" }); };
    await assert.rejects(
      service.sendHostOperation(hostId, "thread.archive", { threadId: "thr_1", expectedCascadeThreadIds: [] }),
      (error: unknown) => error instanceof HostOperationRefusedError,
    );
    // The plugin reported this after its spawn committed: a caller may not resend.
    for (const code of ["unavailable", "internal"] as const) {
      executor.answer = async () => { throw Object.assign(new Error(`committed then failed (${code})`), { code }); };
      await assert.rejects(
        service.sendHostOperation(hostId, "run.attach", { projectId: "proj_1", title: "Synthetic worker", environmentPath: "/tmp/worktree", prompt: "Do nothing." }),
        (error: unknown) => {
          assert.ok(error instanceof HostOperationUnknownDeliveryError, `${code} must be unknown delivery, got ${(error as Error)?.name}`);
          assert.match(error.message, new RegExp(`answered ${code}`));
          return true;
        },
      );
    }
    // The connection survived every one of those faults.
    executor.answer = async op => ({ operation: op, at: "2026-11-16T00:00:00.000Z", calls: {}, value: { counters: {}, loadedAt: 1 } });
    assert.deepEqual((await service.sendHostOperation(hostId, "call.counters", {})).value, { counters: {}, loadedAt: 1 });
  } finally {
    executor?.close();
    await service.stop();
  }
});

test("no executor connection means no operation, rather than a guessed answer", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  await service.start();
  try {
    await assert.rejects(service.sendHostOperation(hostIdFromDataDir("/tmp/bb-data"), "identity.probe", {}), /No host executor is connected/);
  } finally {
    await service.stop();
  }
});
