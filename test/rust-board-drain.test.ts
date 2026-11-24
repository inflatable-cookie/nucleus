import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readServiceInfo } from "../service/transport/identity";
import { ServiceClient } from "../shared/service/client";
import { socketFixtureDirectory } from "./support/socket-fixture";

test(
  "a rolling standalone service exits with a Rust board stream open",
  { timeout: 30_000 },
  async (t) => {
    const root = socketFixtureDirectory("queue-service.sock");
    const key = randomBytes(32).toString("hex");
    const upstream = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401).end();
      } else if (req.url === "/v1/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: refresh\ndata: {}\n\n");
      }
      // The task read also stalls, before sending response headers.
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        // Model a handle that outlives the durable drain, as on a live roll.
        `data:text/javascript,${encodeURIComponent("setInterval(() => {}, 60_000)")}`,
        fileURLToPath(new URL("../bin/queue-service.mjs", import.meta.url)),
        `--data-dir=${root}`,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: process.env.TMPDIR,
          // Occupied port forces an ephemeral board port inside this fixture.
          NUCLEUS_WEB_PORT: String(address.port),
          NUCLEUS_BOARD_ENGINE_URL: `http://127.0.0.1:${address.port}`,
          NUCLEUS_BOARD_ENGINE_KEY: key,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });

    const deadline = Date.now() + 15_000;
    let info = readServiceInfo(root);
    while (!info && child.exitCode === null && Date.now() < deadline) {
      await delay(25, undefined, { signal: t.signal });
      info = readServiceInfo(root);
    }
    assert.equal(info?.pid, child.pid, output);
    assert.ok(info);
    const client = new ServiceClient(info);
    t.after(() => client.close());
    await client.connect();
    const { url } = (await client.request("service.ui-link", {})) as {
      url: string;
    };
    const link = new URL(url);
    const token = new URLSearchParams(link.hash.slice(1)).get("token");
    assert.ok(token);
    const paired = await fetch(`${link.origin}/api/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: link.origin },
      signal: t.signal,
    });
    assert.equal(paired.status, 200);
    await paired.arrayBuffer();
    const cookie = paired.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);

    const upstreamStream = once(upstream, "request", { signal: t.signal });
    const stream = await fetch(`${link.origin}/api/engine/events`, {
      headers: { cookie },
      signal: t.signal,
    });
    assert.equal(stream.status, 200);
    const reader = stream.body?.getReader();
    assert.ok(reader);
    assert.ok(!(await reader.read()).done);
    const [streamRequest, streamResponse] = await upstreamStream;
    assert.equal(streamRequest.url, "/v1/events");
    const upstreamStreamClosed = once(
      streamResponse as ServerResponse,
      "close",
      { signal: t.signal },
    );
    const upstreamRead = once(upstream, "request", { signal: t.signal });
    const pending = fetch(`${link.origin}/api/engine/tasks`, {
      headers: { cookie },
      signal: t.signal,
    }).then(
      () => false,
      () => true,
    );
    const [request, response] = await upstreamRead;
    assert.equal(request.url, "/v1/tasks");
    const pendingClosed = once(response as ServerResponse, "close", {
      signal: t.signal,
    });
    const streamClosed = reader.read().then(
      ({ done }) => done,
      () => true,
    );

    const shutdown = once(child, "exit", {
      signal: AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      throw new Error(`the rolling service did not exit\n${output}`, { cause: error });
    });
    const [, exit] = await Promise.all([
      client.request("service.drain", {
        roll: { fromBuild: "old", toBuild: "new" },
      }),
      shutdown,
    ]);
    assert.deepEqual(exit, [0, null], output);
    assert.ok(await streamClosed, "the open browser stream ended");
    assert.ok(await pending, "the unfinished browser request ended");
    await Promise.all([upstreamStreamClosed, pendingClosed]);
    // The roll leaves identity for a standby until that owning PID exits.
    assert.equal(readServiceInfo(root)?.pid, child.pid);
  },
);
