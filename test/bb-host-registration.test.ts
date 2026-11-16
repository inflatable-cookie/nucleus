import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { QueueService } from "../service/transport/server";
import { readServiceInfo } from "../service/transport/identity";
import { ServiceClient } from "../shared/service/client";
import {
  createFrameReader,
  encodeFrame,
  PROTOCOL_VERSION,
} from "../shared/service/protocol";
import { HostOperationUnknownDeliveryError } from "../service/host-executor";
import {
  hostIdFromDataDir,
  type HostExecutorDeclaration,
} from "../shared/host-operation";
import { socketFixtureDirectory } from "./support/socket-fixture";

/**
 * Spec 062, phase 1: host registration, identity and health, over the real
 * owner-only socket with a fake transport.
 *
 * The fake executor is the plugin end of the reverse channel: it declares the
 * `host-executor` role, answers the declaration's read-only identity probe from
 * whatever the test says, and answers `host.op` requests afterwards. These tests
 * are the phase's acceptance bullets about identity:
 *
 * - a matching probe registers the host, and `service.health` reports it with its
 *   version diagnostics;
 * - a changed data directory, a missing field and a refused schema take the host
 *   offline by name, with nothing registered;
 * - a reconnect proves the identity again;
 * - a dropped connection settles every in-flight operation as unknown delivery,
 *   never resends one, and health reports the host offline with its versions.
 */

type ProbeAnswer = {
  result?: unknown;
  error?: { code: string; message: string };
};

const declarationFor = (dataDir: string): HostExecutorDeclaration => ({
  role: "host-executor",
  host: { dataDir, bbVersion: "0.49.0", sdkVersion: "0.6.132" },
});

const probeValue = (dataDir: string, extra: Record<string, unknown> = {}) => ({
  dataDir,
  bbVersion: "0.49.0",
  sdkVersion: "0.6.132",
  hostIds: ["host_synthetic"],
  ...extra,
});

/**
 * The plugin end of the channel. `probe` decides what the identity probe answers;
 * `answer` decides every later operation. Nothing is inferred: an operation the test
 * did not name is refused as `unavailable`, exactly as the real executor does after a
 * call that may already have committed.
 */
class FakeExecutor {
  /** What the identity probe answers, including the declaration's own probe. */
  probe: () => ProbeAnswer;
  answer: (op: string, input: unknown) => Promise<unknown> = async () => {
    throw Object.assign(new Error("this executor answers nothing"), {
      code: "unavailable",
    });
  };
  received: Array<{ id: string; op: string; input: unknown }> = [];
  /** The declaration's answer: the acceptance, or the refusal the service wrote instead. */
  acceptance: Record<string, unknown> | null = null;
  refusal: { code: string; message: string } | null = null;
  private readonly heartbeatAnswers = new Map<string, () => void>();
  private heartbeats = 0;

  private constructor(
    private readonly socket: Socket,
    readonly declaration: HostExecutorDeclaration,
    probe?: () => ProbeAnswer,
  ) {
    this.probe =
      probe ??
      (() => ({
        result: {
          operation: "identity.probe",
          at: new Date().toISOString(),
          calls: { "system.version": 1 },
          value: probeValue(this.declaration.host.dataDir),
        },
      }));
  }

  get closed(): boolean {
    return this.socket.destroyed;
  }

  /**
   * Connect, authenticate and declare. The service probes the identity *before* it
   * answers the declaration, so this fake exists before that answer and answers the
   * probe from `probe`; the promise settles on the declaration's own answer.
   */
  static open(
    identity: { socketPath: string; credential: string },
    declaration: HostExecutorDeclaration,
    probe?: () => ProbeAnswer,
  ): Promise<FakeExecutor> {
    return new Promise((resolve, reject) => {
      const socket = connect(identity.socketPath);
      let client: FakeExecutor | null = null;
      let opened = false;
      const reader = createFrameReader(
        (frame) => {
          const value = frame as {
            id?: string;
            method?: string;
            result?: Record<string, unknown>;
            error?: { code: string; message: string };
          };
          if (value.id === "auth-1") {
            if (value.error) {
              reject(new Error(value.error.message));
              return;
            }
            socket.write(
              encodeFrame({
                v: PROTOCOL_VERSION,
                id: "decl-1",
                method: "service.host-executor",
                input: declaration,
              }),
            );
            return;
          }
          if (value.id === "decl-1") {
            if (value.error) client!.refusal = value.error;
            else client!.acceptance = value.result ?? {};
            if (!opened) {
              opened = true;
              resolve(client!);
            }
            return;
          }
          if (typeof value.method !== "string") {
            const settle =
              typeof value.id === "string"
                ? client?.heartbeatAnswers.get(value.id)
                : undefined;
            if (settle) {
              client!.heartbeatAnswers.delete(value.id as string);
              settle();
            }
            return;
          }
          // A reverse request from the service: the identity probe, or an operation.
          const request = frame as {
            id: string;
            input: { op: string; input: unknown };
          };
          client!.received.push({
            id: request.id,
            op: request.input.op,
            input: request.input.input,
          });
          if (request.input.op === "identity.probe") {
            const answer = client!.probe();
            socket.write(
              encodeFrame({
                v: PROTOCOL_VERSION,
                id: request.id,
                ...(answer.error
                  ? { error: answer.error }
                  : { result: answer.result }),
              }),
            );
            return;
          }
          void client!.answer(request.input.op, request.input.input).then(
            (result) =>
              socket.write(
                encodeFrame({ v: PROTOCOL_VERSION, id: request.id, result }),
              ),
            (error) =>
              socket.write(
                encodeFrame({
                  v: PROTOCOL_VERSION,
                  id: request.id,
                  error: {
                    code: (error as { code?: string }).code ?? "internal",
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                }),
              ),
          );
        },
        (error) => reject(new Error(`protocol fault: ${error.message}`)),
      );
      socket.on("data", (chunk) => reader.feed(chunk));
      socket.on("error", (error) => {
        if (!opened) reject(error);
      });
      socket.on("close", () => {
        if (!opened)
          reject(
            new Error(
              "the service closed the connection before answering the declaration",
            ),
          );
      });
      socket.on("connect", () => {
        client = new FakeExecutor(socket, declaration, probe);
        socket.write(
          encodeFrame({
            v: PROTOCOL_VERSION,
            id: "auth-1",
            method: "service.auth",
            input: { credential: identity.credential },
          }),
        );
      });
    });
  }

  /** The operations this fake answered, excluding the declarations' identity probes. */
  get operations(): string[] {
    return this.received
      .map((entry) => entry.op)
      .filter((op) => op !== "identity.probe");
  }

  /** One liveness heartbeat on this connection: the plugin reads `service.health`. */
  heartbeat(): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = `heartbeat-${++this.heartbeats}`;
      this.heartbeatAnswers.set(id, () => resolve());
      this.socket.write(
        encodeFrame({ v: PROTOCOL_VERSION, id, method: "service.health", input: {} }),
      );
      setTimeout(() => {
        if (this.heartbeatAnswers.delete(id))
          reject(new Error("the service did not answer the heartbeat"));
      }, 5_000).unref?.();
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

interface Health {
  hosts?: Array<{ id: string; state: string; reason: string }>;
  bb?: {
    online: boolean;
    hosts: Array<{
      hostId: string;
      dataDir: string;
      bbVersion: string;
      sdkVersion: string;
      connectedAt: string;
      hostIds: string[];
      online: boolean;
      lastHeartbeatAt: string | null;
      heartbeatStale: boolean;
    }>;
    offlineReason: string;
    lastRefusal: { field: string; reason: string } | null;
  };
}

async function healthOf(bridge: ServiceClient): Promise<Health> {
  return (await bridge.request("service.health", {})) as Health;
}

/** Wait for one health condition; health is read over the socket, so readiness is the fact. */
async function waitForHealth(
  bridge: ServiceClient,
  ready: (health: Health) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<Health> {
  const deadline = Date.now() + timeoutMs;
  let last: Health = {};
  while (Date.now() < deadline) {
    last = await healthOf(bridge);
    if (ready(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}

test("a matching identity probe registers the host, and health reports its identity, versions and state", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({
    owner: { dataDir: dir, timers: false },
    fixture: "fake",
  });
  await service.start();
  const info = readServiceInfo(dir)!;
  const bridge = new ServiceClient({
    socketPath: info.socketPath,
    credential: info.credential,
  });
  const dataDir = `${dir}/bb-data`;
  let executor: FakeExecutor | null = null;
  try {
    await bridge.connect();
    executor = await FakeExecutor.open(info, declarationFor(dataDir));
    assert.equal(
      executor.refusal,
      null,
      "the declaration is accepted only after its probe succeeds",
    );
    const hostId = hostIdFromDataDir(dataDir);
    assert.equal(executor.acceptance?.hostId, hostId);
    assert.deepEqual(service.hostExecutorIds(), [hostId]);
    assert.deepEqual(
      executor.operations,
      [],
      "the probe rides the declaration, not the operation path",
    );

    const health = await waitForHealth(
      bridge,
      (value) => value.bb?.online === true,
      "the BB host registers",
    );
    const record = health.bb!.hosts.find((entry) => entry.hostId === hostId);
    assert.ok(
      record,
      `health names the registered identity: ${JSON.stringify(health.bb)}`,
    );
    assert.equal(record.dataDir, dataDir);
    assert.equal(record.bbVersion, "0.49.0");
    assert.equal(record.sdkVersion, "0.6.132");
    assert.deepEqual(record.hostIds, ["host_synthetic"]);
    assert.ok(
      record.connectedAt,
      "the acceptance records when the connection was proved",
    );
    assert.equal(health.bb!.offlineReason, "");
    const listed = health.hosts?.find((entry) => entry.id === hostId);
    assert.deepEqual(
      { state: listed?.state, reason: listed?.reason },
      { state: "online", reason: "" },
    );

    // Spec 062: liveness comes from a heartbeat on the retained connection, and health
    // reports when the last one arrived.
    assert.equal(record.lastHeartbeatAt, null, "a fresh acceptance has heard no heartbeat yet");
    assert.equal(record.heartbeatStale, false, "a fresh acceptance is not stale");
    await executor.heartbeat();
    const beat = await waitForHealth(
      bridge,
      (value) => Boolean(value.bb?.hosts[0]?.lastHeartbeatAt),
      "the heartbeat is recorded",
    );
    assert.equal(beat.bb!.hosts[0]!.heartbeatStale, false);
    assert.ok(Date.parse(beat.bb!.hosts[0]!.lastHeartbeatAt!) > 0);
  } finally {
    executor?.close();
    await bridge.close();
    await service.stop();
  }
});

test("a changed data directory refuses by its field and leaves the host offline by name", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({
    owner: { dataDir: dir, timers: false },
    fixture: "fake",
  });
  await service.start();
  const info = readServiceInfo(dir)!;
  const bridge = new ServiceClient({
    socketPath: info.socketPath,
    credential: info.credential,
  });
  const recorded = `${dir}/bb-data-recorded`;
  const moved = `${dir}/bb-data-moved`;
  let first: FakeExecutor | null = null;
  let second: FakeExecutor | null = null;
  try {
    await bridge.connect();
    first = await FakeExecutor.open(info, declarationFor(recorded));
    const hostId = hostIdFromDataDir(recorded);
    await waitForHealth(
      bridge,
      (value) => value.bb?.online === true,
      "the first identity registers",
    );

    // The same plugin now announces a different data directory: that is a different
    // identity, and the recorded one is what this service serves.
    second = await FakeExecutor.open(info, declarationFor(moved));
    assert.equal(second.refusal?.code, "refused");
    assert.match(second.refusal?.message ?? "", /dataDir/);
    assert.match(second.refusal?.message ?? "", /data directory changed/);
    assert.deepEqual(
      service.hostExecutorIds(),
      [],
      "a refused declaration registers nothing",
    );
    assert.equal(hostIdFromDataDir(moved) === hostId, false);

    const health = await waitForHealth(
      bridge,
      (value) => Boolean(value.bb?.offlineReason),
      "the refusal is recorded",
    );
    assert.match(health.bb!.offlineReason, /^dataDir: /);
    assert.match(health.bb!.offlineReason, /data directory changed/);
    assert.equal(health.bb!.online, false);
    assert.equal(health.bb!.lastRefusal?.field, "dataDir");
    // The durable identity is still the recorded one, and it is named as offline in the host list.
    assert.deepEqual(
      health.bb!.hosts.map((entry) => entry.dataDir),
      [recorded],
    );
    const listed = health.hosts?.find((entry) => entry.id === hostId);
    assert.equal(listed?.state, "offline");
    assert.match(listed?.reason ?? "", /data directory changed/);
  } finally {
    first?.close();
    second?.close();
    await bridge.close();
    await service.stop();
  }
});

test("a probe that omits a required field, or answers a refused shape, takes the host offline by name", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({
    owner: { dataDir: dir, timers: false },
    fixture: "fake",
  });
  await service.start();
  const info = readServiceInfo(dir)!;
  const bridge = new ServiceClient({
    socketPath: info.socketPath,
    credential: info.credential,
  });
  let executor: FakeExecutor | null = null;
  try {
    await bridge.connect();
    // A projection missing `hostIds`: the schema refuses it and names the field.
    const missingField = `${dir}/bb-missing-field`;
    executor = await FakeExecutor.open(
      info,
      declarationFor(missingField),
      () => ({
        result: {
          operation: "identity.probe",
          at: new Date().toISOString(),
          calls: {},
          value: {
            dataDir: missingField,
            bbVersion: "0.49.0",
            sdkVersion: "0.6.132",
          },
        },
      }),
    );
    assert.equal(executor.refusal?.code, "refused");
    assert.match(executor.refusal?.message ?? "", /hostIds/);
    const missing = await waitForHealth(
      bridge,
      (value) => /hostIds/.test(value.bb?.offlineReason ?? ""),
      "a missing field is named",
    );
    assert.equal(missing.bb!.online, false);
    assert.match(missing.bb!.offlineReason, /^hostIds: /);
    assert.match(missing.bb!.offlineReason, /identity\.probe/);
    assert.deepEqual(service.hostExecutorIds(), []);

    // A refused schema: the field arrives with the wrong type, so the projection is refused.
    const refusedShape = `${dir}/bb-refused-shape`;
    executor = await FakeExecutor.open(
      info,
      declarationFor(refusedShape),
      () => ({
        result: {
          operation: "identity.probe",
          at: new Date().toISOString(),
          calls: {},
          value: probeValue(refusedShape, { hostIds: "host_synthetic" }),
        },
      }),
    );
    assert.equal(executor.refusal?.code, "refused");
    assert.match(executor.refusal?.message ?? "", /hostIds/);
    const refused = await waitForHealth(
      bridge,
      (value) => /bb-refused-shape|hostIds/.test(value.bb?.offlineReason ?? ""),
      "a refused schema is named",
    );
    assert.equal(refused.bb!.online, false);
    assert.match(refused.bb!.offlineReason, /hostIds/);
    assert.deepEqual(service.hostExecutorIds(), []);

    // A probe the plugin itself refuses is a definite refusal, named too.
    const unavailable = `${dir}/bb-unavailable`;
    const refusedProbe = await FakeExecutor.open(
      info,
      declarationFor(unavailable),
      () => ({
        error: {
          code: "refused",
          message: "sdkVersion: this BB cannot answer system.version",
        },
      }),
    );
    assert.equal(refusedProbe.refusal?.code, "refused");
    assert.match(refusedProbe.refusal?.message ?? "", /sdkVersion/);
    refusedProbe.close();
  } finally {
    executor?.close();
    await bridge.close();
    await service.stop();
  }
});

test("a reconnect proves the identity again, and a dropped connection settles in-flight work unknown without replaying it", async () => {
  const dir = socketFixtureDirectory("queue-service.sock");
  const service = new QueueService({
    owner: { dataDir: dir, timers: false },
    fixture: "fake",
  });
  await service.start();
  const info = readServiceInfo(dir)!;
  const bridge = new ServiceClient({
    socketPath: info.socketPath,
    credential: info.credential,
  });
  const dataDir = `${dir}/bb-reconnect`;
  const hostId = hostIdFromDataDir(dataDir);
  let first: FakeExecutor | null = null;
  let second: FakeExecutor | null = null;
  try {
    await bridge.connect();
    first = await FakeExecutor.open(info, declarationFor(dataDir));
    const registered = await waitForHealth(
      bridge,
      (value) => value.bb?.online === true,
      "the first connection registers",
    );
    const firstConnectedAt = first.acceptance?.acceptedAt as string;
    assert.equal(registered.bb!.hosts[0]!.connectedAt.length > 0, true);

    // One operation is in flight when the connection drops.
    first.answer = () => new Promise(() => {});
    const inFlight = assert.rejects(
      service.sendHostOperation(hostId, "call.counters", {}),
      (error: unknown) =>
        error instanceof HostOperationUnknownDeliveryError &&
        /closed/.test(error.message),
    );
    first.close();
    await inFlight;
    const offline = await waitForHealth(
      bridge,
      (value) => value.bb?.online === false && value.bb.offlineReason !== "",
      "the drop takes the host offline",
    );
    assert.equal(
      offline.bb!.hosts[0]!.bbVersion,
      "0.49.0",
      "version diagnostics survive the drop",
    );
    const listed = offline.hosts?.find((entry) => entry.id === hostId);
    assert.equal(listed?.state, "offline");
    assert.match(listed?.reason ?? "", /closed/);

    // A reconnect re-proves the same identity through a new probe.
    second = await FakeExecutor.open(info, declarationFor(dataDir), () => ({
      result: {
        operation: "identity.probe",
        at: new Date().toISOString(),
        calls: { "system.version": 2 },
        value: probeValue(dataDir),
      },
    }));
    assert.equal(
      second.refusal,
      null,
      "the reconnect proves the same identity again",
    );
    const again = await waitForHealth(
      bridge,
      (value) => value.bb?.online === true,
      "the reconnect re-registers",
    );
    assert.notEqual(
      second.acceptance?.acceptedAt,
      firstConnectedAt,
      "a reconnect is a new acceptance, not a resumed one",
    );
    assert.equal(
      again.bb!.hosts.filter((entry) => entry.hostId === hostId).length,
      1,
      "one identity, not two",
    );
    assert.equal(again.bb!.offlineReason, "");
    assert.deepEqual(service.hostExecutorIds(), [hostId]);
    // The uncertain operation was settled unknown and never replayed on the new connection.
    assert.deepEqual(second.operations, [], "nothing is resent after a drop");

    // And the new connection answers the next operation.
    second.answer = async (op) => ({
      operation: op,
      at: new Date().toISOString(),
      calls: {},
      value: { counters: {}, loadedAt: 1 },
    });
    const counters = await service.sendHostOperation(
      hostId,
      "call.counters",
      {},
    );
    assert.deepEqual(counters.value, { counters: {}, loadedAt: 1 });
    assert.deepEqual(second.operations, ["call.counters"]);
  } finally {
    first?.close();
    second?.close();
    await bridge.close();
    await service.stop();
  }
});

test("the registered BB adapter declares its composition and refuses every task-workflow call before send", async () => {
  const { createBbHostAdapter } = await import("../service/bb-host");
  const { ProvenPreSendRefusalError } = await import("../core/host/errors");
  const adapter = createBbHostAdapter(
    hostIdFromDataDir("/synthetic/bb-data"),
    () => true,
  );
  assert.equal(adapter.isConnected?.(), true);
  assert.deepEqual(adapter.capabilities?.(), {
    reportingViaMcp: false,
    supportsCoordinatorRecovery: true,
    lifecycleDispatch: false,
    perThreadEnvironment: false,
    repositorySharedWorkspaces: false,
  });
  // Phase 1 registers the host and nothing else: each task-workflow call is a proven
  // pre-send refusal, never an empty success and never a task workflow.
  const refusals: Array<[string, () => Promise<unknown>]> = [
    [
      "observe",
      () => (adapter.observe as (id: string) => Promise<unknown>)("thr_1"),
    ],
    [
      "createAgent",
      () => (adapter.createAgent as (...args: never[]) => Promise<unknown>)(),
    ],
    [
      "findAgents",
      () => (adapter.findAgents as (...args: never[]) => Promise<unknown>)(),
    ],
    [
      "archiveAgent",
      () => (adapter.archiveAgent as (id: string) => Promise<unknown>)("thr_1"),
    ],
    [
      "validate",
      () => (adapter.validate as (...args: never[]) => Promise<unknown>)(),
    ],
    [
      "createWorkspace",
      () =>
        (adapter.createWorkspace as (...args: never[]) => Promise<unknown>)(),
    ],
    [
      "findWorkspaces",
      () =>
        (adapter.findWorkspaces as (...args: never[]) => Promise<unknown>)(),
    ],
    [
      "verifyResume",
      () => (adapter.verifyResume as (...args: never[]) => Promise<unknown>)(),
    ],
    [
      "verifyCheckpoint",
      () =>
        (adapter.verifyCheckpoint as (...args: never[]) => Promise<unknown>)(),
    ],
    [
      "verifyReplacementSource",
      () =>
        (
          adapter.verifyReplacementSource as (
            ...args: never[]
          ) => Promise<unknown>
        )(),
    ],
    [
      "verifyCleanQueueWorktree",
      () =>
        (
          adapter.verifyCleanQueueWorktree as (
            ...args: never[]
          ) => Promise<unknown>
        )(),
    ],
    [
      "verifyWorkspace",
      () =>
        (adapter.verifyWorkspace as (...args: never[]) => Promise<unknown>)(),
    ],
    [
      "verifyPr",
      () => (adapter.verifyPr as (...args: never[]) => Promise<unknown>)(),
    ],
  ];
  for (const [name, call] of refusals) {
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(
        error instanceof ProvenPreSendRefusalError,
        `${name} refuses before send, got ${(error as Error)?.name}`,
      );
      assert.match((error as Error).message, /phase 1/);
      return true;
    });
  }
});
