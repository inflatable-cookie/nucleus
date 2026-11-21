import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceClient } from "../shared/service/client";
import {
  createFrameReader,
  encodeFrame,
  PROTOCOL_VERSION,
} from "../shared/service/protocol";
import { PersistenceExecutor } from "../service/executor/executor";

for (const [method, input] of [
  ["lead.submit", {}],
] as const) {
  test(`${method} settlement survives client deadlines and still rejects socket loss`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wait-"));
    const socketPath = join(root, "s");
    const sockets = new Set<import("node:net").Socket>();
    let reply!: () => void;
    const server = createServer((socket) => {
      sockets.add(socket);
      const reader = createFrameReader(
        (frame: any) => {
          const respond = () =>
            socket.write(
              encodeFrame({
                v: PROTOCOL_VERSION,
                id: frame.id,
                result: { settled: true },
              }),
            );
          if (frame.method === "service.auth") respond();
          else reply = respond;
        },
        (error) => {
          throw error;
        },
      );
      socket.on("data", (chunk) => reader.feed(chunk));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = new ServiceClient({
      socketPath,
      credential: "a".repeat(64),
    });
    try {
      await client.connect();
      const request = client.request(method, input, 10);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(client.inFlight, 1);
      reply();
      assert.deepEqual(await request, { settled: true });
      const lost = client.request(method, input, 10);
      const rejection = assert.rejects(lost, /socket closed/);
      for (const socket of sockets) socket.destroy();
      await rejection;
      assert.equal(client.inFlight, 0);
    } finally {
      client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("executor settlement calls have no call timer while ordinary calls keep their deadline", async () => {
  // Isolate the parent transport: a worker that captures delivery and answers when released.
  const executor = new PersistenceExecutor({
    owner: { dataDir: tmpdir() },
  } as any);
  const internal = executor as any;
  const sent: any[] = [];
  internal.worker = { postMessage: (message: any) => sent.push(message) };
  for (const [method, input, waiting] of [
    ["lead.submit", {}, true],
    ["project.qa.run", { wait: true }, false],
    ["project.qa.run", {}, false],
    ["project.qa.get", {}, false],
  ] as const) {
    const request = executor.rpc(method, input);
    const message = sent.at(-1);
    const pending = internal.pending.get(message.id);
    assert.equal(Boolean(pending.timer), !waiting);
    internal.receive({
      kind: "reply",
      id: message.id,
      ok: true,
      result: "settled",
    });
    assert.equal(await request, "settled");
  }
});

test("a host RPC timeout retains its correlated late response", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-continuation-"));
  const socketPath = join(root, "s");
  let finish!: () => void;
  const server = createServer((socket) => {
    const reader = createFrameReader(
      (frame: any) => {
        if (frame.method === "service.auth")
          return socket.write(
            encodeFrame({ v: PROTOCOL_VERSION, id: frame.id, result: {} }),
          );
        socket.write(
          encodeFrame({
            v: PROTOCOL_VERSION,
            id: frame.id,
            error: { code: "timeout", message: "host timed out" },
            continuation: true,
          }),
        );
        finish = () =>
          socket.write(
            encodeFrame({
              v: PROTOCOL_VERSION,
              id: frame.id,
              result: { accepted: true },
            }),
          );
      },
      (error) => {
        throw error;
      },
    );
    socket.on("data", (chunk) => reader.feed(chunk));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = new ServiceClient({ socketPath, credential: "synthetic" });
  try {
    const request = client.request("service.bb-host-operation", {}, 1_000);
    let late!: Promise<unknown>;
    await assert.rejects(request, (error: unknown) => {
      assert.ok(error instanceof Error && "late" in error);
      late = (error as Error & { late: Promise<unknown> }).late;
      return true;
    });
    finish();
    assert.deepEqual(await late, { accepted: true });
    assert.equal(client.inFlight, 0);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("late host writes do not use active service-client read slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-capacity-"));
  const socketPath = join(root, "s");
  const server = createServer((socket) => {
    const reader = createFrameReader(
      (frame: any) => {
        if (frame.method === "service.auth")
          return socket.write(
            encodeFrame({ v: PROTOCOL_VERSION, id: frame.id, result: {} }),
          );
        if (frame.input.op === "thread.send")
          return socket.write(
            encodeFrame({
              v: PROTOCOL_VERSION,
              id: frame.id,
              error: { code: "timeout", message: "host timed out" },
              continuation: true,
            }),
          );
        socket.write(
          encodeFrame({
            v: PROTOCOL_VERSION,
            id: frame.id,
            result: { available: true },
          }),
        );
      },
      (error) => {
        throw error;
      },
    );
    socket.on("data", (chunk) => reader.feed(chunk));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = new ServiceClient({
    socketPath,
    credential: "synthetic",
    maxInFlight: 2,
  });
  try {
    await Promise.all(
      [0, 1].map((i) =>
        assert.rejects(
          client.request("service.bb-host-operation", { op: "thread.send", i }),
        ),
      ),
    );
    assert.deepEqual(
      await client.request("service.bb-host-operation", {
        op: "thread.observe",
      }),
      { available: true },
    );
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("socket backpressure rejects only the new request as unsent", async () => {
  const client = new ServiceClient({
    socketPath: "/synthetic",
    credential: "synthetic",
  });
  const inner = client as any;
  let oldReject!: (error: Error) => void;
  const old = new Promise((_resolve, reject) => {
    oldReject = reject;
  });
  inner.socket = {
    destroyed: false,
    bufferSize: 33 * 1024 * 1024,
    destroy() {
      this.destroyed = true;
    },
  };
  inner.pending.set("earlier", {
    resolve() {},
    reject: oldReject,
    timer: undefined,
  });
  const prior = assert.rejects(
    old,
    (error: any) => error.code === "unavailable",
  );
  await assert.rejects(
    client.request("service.bb-host-operation", { op: "thread.send" }),
    (error: any) => error.code === "busy",
  );
  await prior;
});
