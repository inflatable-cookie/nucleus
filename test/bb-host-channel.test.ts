import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { QueueService } from "../service/transport/server";
import { createBbWorkspaceAdapter } from "../service/bb-host";
import { Store } from "../core/store/store";
import { readServiceInfo } from "../service/transport/identity";
import { ServiceClient, ServiceRequestError } from "../shared/service/client";
import { createFrameReader, encodeFrame, PROTOCOL_VERSION } from "../shared/service/protocol";
import { HostOperationRefusedError, HostOperationUnknownDeliveryError } from "../service/host-executor";
import { hostIdFromDataDir, workspaceHandleForPath, type HostExecutorDeclaration } from "../shared/host-operation";
import type { Task } from "../shared/contracts";
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
  /**
   * What this fake executor answers. The declaration's identity probe is always
   * answered from the declaration itself (that is what a real plugin does, and the
   * service registers nothing without it); every other operation is refused until a
   * test says otherwise.
   */
  answer: (op: string, input: unknown) => Promise<unknown> = async (op: string) => {
    // The declaration's probe is the four reads the real executor makes (Spec 062,
    // "Identity"): status.get, system.version, one threads.list and hosts.list.
    if (op === "identity.probe") return { operation: op, at: "2026-11-16T00:00:00.000Z", calls: { "status.get": 1, "system.version": 1, "threads.list": 1, "hosts.list": 1 }, value: { dataDir: this.declaration.host.dataDir, bbVersion: this.declaration.host.bbVersion, sdkVersion: this.declaration.host.sdkVersion, hostIds: ["host_1"] } };
    throw Object.assign(new Error("this executor answers nothing"), { name: "HostOperationError", code: "unavailable" });
  };
  received: Array<{ id: string; op: string; input: unknown }> = [];
  /** Answers to the requests this executor writes itself (the plugin's forwarded board calls). */
  private readonly own = new Map<string, (answer: { result?: unknown; error?: { code: string; message: string } }) => void>();

  /** One request on this executor connection, as the plugin's board bridge writes it. */
  request(method: string, input: unknown, via?: "bb"): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
    const id = `own-${++this.sequence}`;
    return new Promise(resolve => {
      this.own.set(id, resolve);
      this.socket.write(encodeFrame({ v: PROTOCOL_VERSION, id, method, input, ...(via ? { via } : {}) }));
    });
  }

  /** Settle one of this executor's own requests; true when the frame was one. */
  settleOwn(frame: { id?: string; result?: unknown; error?: { code: string; message: string } }): boolean {
    const settle = typeof frame.id === "string" ? this.own.get(frame.id) : undefined;
    if (!settle) return false;
    this.own.delete(frame.id!);
    settle(frame);
    return true;
  }

  private constructor(private readonly socket: Socket, readonly declaration: HostExecutorDeclaration) {}

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
        if (client!.settleOwn(value)) return;
        // A reverse request from the service. The declaration's own identity probe is
        // one of these and arrives before the declaration is answered, so a request is
        // answered whether or not this client has seen its acceptance yet.
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
        client = new ExecutorClient(socket, declaration);
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

test("the BB adapter route preserves proven pre-send refusals and releases workspace reservations", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  const store = new Store(":memory:");
  const bbDataDir = join(dir, "bb-data");
  const repositoryRoot = join(dir, "repository");
  const noExecutorDirectory = join(dir, "no-executor-worktree");
  const refusedDirectory = join(dir, "refused-worktree");
  const unknownDirectory = join(dir, "unknown-worktree");
  for (const path of [bbDataDir, repositoryRoot, noExecutorDirectory, refusedDirectory, unknownDirectory]) mkdirSync(path);
  const hostId = hostIdFromDataDir(bbDataDir);
  const adapter = createBbWorkspaceAdapter(hostId, () => true, dir, store);
  const taskAt = (directory: string) => ({ id: "task_synthetic", title: "Synthetic task", repoPath: repositoryRoot, directory }) as unknown as Task;
  let executor: ExecutorClient | null = null;
  try {
    await service.start();
    await assert.rejects(
      adapter.createWorkspace!(taskAt(noExecutorDirectory)),
      (error: unknown) => error instanceof ServiceRequestError && error.code === "refused",
    );
    assert.deepEqual(await adapter.findWorkspaces!(taskAt(noExecutorDirectory)), [], "a no-executor refusal releases the reservation");

    const info = readServiceInfo(dir)!;
    executor = await ExecutorClient.connect(info, declarationFor(bbDataDir));
    let refuseNextCreate = true;
    let unknownCreatePending = true;
    let projectExists = false;
    executor.answer = async (op, input) => {
      if (op === "workspace.inspect") {
        return {
          operation: op,
          at: "2026-11-16T00:00:00.000Z",
          calls: { "projects.list": 1 },
          value: { projectId: projectExists ? "proj_synthetic" : null, projectFound: projectExists, path: projectExists ? repositoryRoot : null },
        };
      }
      if (op !== "workspace.create") throw new Error(`Unexpected operation ${op}`);
      const { workspacePath } = input as { workspacePath: string };
      if (workspacePath === refusedDirectory && refuseNextCreate) {
        refuseNextCreate = false;
        throw Object.assign(new Error("project registration was refused before write"), { code: "refused" });
      }
      if (workspacePath === unknownDirectory && unknownCreatePending) {
        unknownCreatePending = false;
        projectExists = true;
        throw Object.assign(new Error("project registration reply was lost"), { code: "unavailable" });
      }
      const projectCreated = !projectExists;
      projectExists = true;
      return {
        operation: op as "workspace.create",
        at: "2026-11-16T00:00:00.000Z",
        calls: { "projects.create": 1, "threads.spawn": 0 },
        value: {
          projectId: "proj_synthetic",
          projectCreated,
          projectCount: 1,
          handle: workspaceHandleForPath(workspacePath),
          path: workspacePath,
          spawned: 0,
        },
      };
    };
    await assert.rejects(
      adapter.createWorkspace!(taskAt(refusedDirectory)),
      (error: unknown) => error instanceof ServiceRequestError && error.code === "refused",
    );
    assert.deepEqual(await adapter.findWorkspaces!(taskAt(refusedDirectory)), [], "a plugin refusal releases the reservation");
    const created = await adapter.createWorkspace!(taskAt(refusedDirectory));
    assert.equal(created.id, workspaceHandleForPath(refusedDirectory));
    await assert.rejects(
      adapter.createWorkspace!(taskAt(unknownDirectory)),
      (error: unknown) => error instanceof ServiceRequestError && error.code === "internal",
    );
    const recovered = await adapter.createWorkspace!(taskAt(unknownDirectory));
    assert.equal(recovered.id, workspaceHandleForPath(unknownDirectory));
    assert.deepEqual(executor.received.map(entry => entry.op), ["identity.probe", "workspace.create", "workspace.create", "workspace.create", "workspace.inspect"]);
    assert.equal(executor.closed, false, "a refused reply does not close the shared executor connection");
  } finally {
    executor?.close();
    store.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
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
      value: { threadId: (input as { threadId: string }).threadId, title: "Synthetic", status: "idle", displayStatus: "idle", environmentId: "env_1", parentThreadId: null, parentNotifications: "off", pluginMetadata: null, archivedAt: null, queuedWork: "none", providerId: "codex", execution: null, environmentPath: "/synthetic/worktree", originPluginId: "nucleus", updatedAt: 1, hasPendingInteraction: false, interactions: [] },
    });
    const observed = await service.sendHostOperation(hostId, "thread.observe", { threadId: "thr_1" });
    assert.equal((observed.value as { environmentId: string }).environmentId, "env_1");
    assert.deepEqual(observed.calls, { "threads.get": 1 });
    assert.deepEqual(executor.received.map(entry => entry.op), ["identity.probe", "thread.observe"]);
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
    // Each connection proves the identity once before it answers anything else.
    assert.deepEqual(first.received.map(entry => entry.op), ["identity.probe", "call.counters"]);
    assert.deepEqual(second.received.map(entry => entry.op), ["identity.probe", "identity.probe"]);
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
    assert.equal(executor.received.length, 3);
  } finally {
    executor?.close();
    await service.stop();
  }
});

test("a late read reply leaves the executor channel and another operation intact", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  await service.start();
  const hostId = hostIdFromDataDir("/tmp/bb-data");
  let executor: ExecutorClient | null = null;
  try {
    executor = await ExecutorClient.connect(readServiceInfo(dir)!, declarationFor("/tmp/bb-data"));
    let replyLate!: (value: unknown) => void;
    let replyIndependent!: (value: unknown) => void;
    let receivedIndependent!: () => void;
    const independentReceived = new Promise<void>(resolve => { receivedIndependent = resolve; });
    executor.answer = op => new Promise(resolve => {
      if (op === "call.counters") replyLate = resolve;
      else { replyIndependent = resolve; receivedIndependent(); }
    });
    await assert.rejects(service.sendHostOperation(hostId, "call.counters", {}), HostOperationUnknownDeliveryError);
    const independent = service.sendHostOperation(hostId, "identity.probe", {});
    await independentReceived;
    replyLate({ operation: "call.counters", at: "2026-11-16T00:00:00.000Z", calls: {}, value: { counters: {}, loadedAt: 1 } });
    replyIndependent({ operation: "identity.probe", at: "2026-11-16T00:00:00.000Z", calls: {}, value: { dataDir: "/tmp/bb-data", bbVersion: "0.49.0", sdkVersion: "0.6.132", hostIds: ["host_1"] } });
    assert.deepEqual((await independent).value, { dataDir: "/tmp/bb-data", bbVersion: "0.49.0", sdkVersion: "0.6.132", hostIds: ["host_1"] });
    assert.equal(executor.closed, false);
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

test("a forwarded BB board call carries `via: bb` only on the executor connection, and a Settings write records that surface", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: "fake" });
  await service.start();
  const info = readServiceInfo(dir)!;
  const owner = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  let executor: ExecutorClient | null = null;
  try {
    await owner.connect();
    // A plain owner connection cannot claim the BB plugin's surface.
    await assert.rejects(
      (owner.request as (method: string, input: unknown, timeoutMs?: number, via?: string) => Promise<unknown>)("queue.capacity", { globalLimit: 23, projectLimit: 4 }, undefined, "bb"),
      (error: unknown) => error instanceof ServiceRequestError && error.code === "invalid_input" && /host-executor/u.test(error.message),
    );
    executor = await ExecutorClient.connect(info, declarationFor("/tmp/bb-data-board"));
    // The BB Settings section's capacity write, forwarded by the plugin on its executor connection.
    const written = await executor.request("queue.capacity", { globalLimit: 23, projectLimit: 4 }, "bb");
    assert.deepEqual(written.result, { ok: true });
    const state = await owner.request("queue.capacity-state", {}) as { effective: { globalLimit: number }; changes: Array<{ surface: string }> };
    assert.equal(state.effective.globalLimit, 23);
    assert.equal(state.changes.at(-1)?.surface, "bb", "the record names the BB surface, which only the plugin's connection can carry");
    // The same write with no surface is refused as every non-Settings route is.
    const bare = await executor.request("queue.capacity", { globalLimit: 22, projectLimit: 4 });
    assert.match(bare.error?.message ?? "", /queue\.capacity is refused/u);
  } finally {
    executor?.close();
    await owner.close();
    await service.stop();
  }
});
