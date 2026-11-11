import { test } from "node:test";
import assert from "node:assert/strict";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import {
  socketFixtureDirectory,
  assertSocketPathWithinBound,
} from "./support/socket-fixture";
import { QueueService } from "../service/transport/server";
import { ServiceClient, ServiceRequestError } from "../shared/service/client";
import { readServiceInfo } from "../service/transport/identity";
import { WebTokens } from "../service/web/web-board";
import { RPC_CATALOGUE } from "../shared/rpc-catalogue";
import { SETTINGS_WRITE_METHODS } from "../shared/web-surface";

/**
 * The local web board (service-boundary contract, "Local web board"): a loopback
 * HTTP server with a bearer token on every API request, the shared catalogue with
 * `via: "web"`, and a live board channel. These cases use a real service and real
 * sockets; only the token clock is a fixture.
 */

interface Http {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function http(
  port: number,
  path: string,
  options: {
    method?: string;
    host?: string;
    token?: string;
    origin?: string;
    body?: unknown;
    settings?: boolean;
  } = {},
): Promise<Http> {
  const headers: Record<string, string> = {};
  if (options.host) headers.host = options.host;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.origin) headers.origin = options.origin;
  if (options.settings) headers["x-nucleus-surface"] = "settings";
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  if (payload !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

const rpc = (
  port: number,
  method: string,
  input: unknown,
  token?: string,
  host?: string,
  settings = false,
) =>
  http(port, "/api/rpc", {
    method: "POST",
    body: { method, input },
    token,
    host: host ?? `127.0.0.1:${port}`,
    settings,
  });

interface Fixture {
  service: QueueService;
  client: ServiceClient;
  dataDir: string;
  port: number;
  clock: { now: number };
}

async function startBoard(): Promise<Fixture> {
  const dataDir = socketFixtureDirectory("queue-service.sock");
  const clock = { now: Date.now() };
  const service = new QueueService({
    owner: { dataDir },
    fixture: "fake",
    debug: true,
    webBoard: { bundleDir: null, now: () => clock.now },
  });
  await service.start();
  const info = readServiceInfo(dataDir);
  assert.ok(info, "the service publishes its identity file");
  assertSocketPathWithinBound(info.socketPath);
  assert.ok(
    info.httpPort,
    "the identity file records the board port beside the socket",
  );
  const client = new ServiceClient({
    socketPath: info.socketPath,
    credential: info.credential,
  });
  await client.connect();
  return { service, client, dataDir, port: info.httpPort, clock };
}

async function stopBoard(fixture: Fixture) {
  await fixture.client.close();
  await fixture.service.stop();
  rmSync(fixture.dataDir, { recursive: true, force: true });
}

async function mintToken(
  client: ServiceClient,
  ttlMinutes?: number,
): Promise<{ url: string; token: string; expiresAt: string }> {
  const issued = (await client.request(
    "service.ui-link",
    ttlMinutes === undefined ? {} : { ttlMinutes },
  )) as { url: string; expiresAt: string };
  const token = issued.url.split("#token=")[1];
  assert.match(
    token ?? "",
    /^[A-Za-z0-9_-]{43}$/,
    "the link fragment carries a 43-character token",
  );
  return { ...issued, token: token! };
}

/** Open the live channel and collect its SSE events as they arrive. */
function openEvents(port: number, token?: string) {
  const events: { event: string; data: unknown; id: string | null }[] = [];
  let buffer = "";
  let ended = false;
  const waiters: (() => void)[] = [];
  let statusCode = 0;
  const request = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path: "/api/events",
      headers: {
        host: `127.0.0.1:${port}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
    (response: IncomingMessage) => {
      statusCode = response.statusCode ?? 0;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const fields = Object.fromEntries(
            block
              .split("\n")
              .filter((line) => line.includes(":") && !line.startsWith(":"))
              .map((line) => [
                line.slice(0, line.indexOf(":")),
                line.slice(line.indexOf(":") + 1).trim(),
              ]),
          );
          if (fields.event)
            events.push({
              event: fields.event,
              data: JSON.parse(fields.data),
              id: fields.id ?? null,
            });
          end = buffer.indexOf("\n\n");
        }
        waiters.splice(0).forEach((wake) => wake());
      });
      response.on("end", () => {
        ended = true;
        waiters.splice(0).forEach((wake) => wake());
      });
      response.on("close", () => {
        ended = true;
        waiters.splice(0).forEach((wake) => wake());
      });
      response.on("error", () => {
        ended = true;
        waiters.splice(0).forEach((wake) => wake());
      });
    },
  );
  request.on("error", () => {
    ended = true;
    waiters.splice(0).forEach((wake) => wake());
  });
  request.end();
  async function next(
    predicate: (event: {
      event: string;
      data: unknown;
      id: string | null;
    }) => boolean,
    timeoutMs = 10_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (let seen = 0; ; ) {
      while (seen < events.length) {
        const event = events[seen++];
        if (predicate(event)) return event;
      }
      if (ended)
        throw new Error("the live channel ended before the expected event");
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("timed out waiting for a live channel event");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  return {
    request,
    next,
    status: () => statusCode,
    ended: () => ended,
    close: () => request.destroy(),
  };
}

test("the board listens on 127.0.0.1 only and refuses any Host it does not name", async () => {
  const fixture = await startBoard();
  try {
    assert.deepEqual(fixture.service.webBoardAddress(), {
      host: "127.0.0.1",
      port: fixture.port,
    });
    const token = (await mintToken(fixture.client)).token;
    // A page on another domain that resolves to 127.0.0.1 still sends its own Host.
    for (const host of [
      `attacker.example:${fixture.port}`,
      `127.0.0.1.nip.io:${fixture.port}`,
      `127.0.0.1`,
      `localhost:1`,
    ]) {
      const refused = await rpc(
        fixture.port,
        "queue.ui-snapshot",
        {},
        token,
        host,
      );
      assert.equal(refused.status, 403, `Host ${host} is refused`);
      assert.equal(JSON.parse(refused.body).error.code, "host");
    }
    const served = await rpc(
      fixture.port,
      "queue.ui-snapshot",
      {},
      token,
      `localhost:${fixture.port}`,
    );
    assert.equal(
      served.status,
      200,
      "the loopback name for this port is served",
    );
    const cross = await http(fixture.port, "/api/rpc", {
      method: "POST",
      token,
      origin: "https://evil.example",
      body: { method: "queue.ui-snapshot", input: {} },
    });
    assert.equal(
      cross.status,
      403,
      "a foreign Origin is refused even with a valid token",
    );
  } finally {
    await stopBoard(fixture);
  }
});

test("every API request needs a live token: none, wrong, malformed, expired and revoked are refused alike", async () => {
  const fixture = await startBoard();
  try {
    const minted = await mintToken(fixture.client, 5);
    const body = { method: "queue.ui-snapshot", input: {} };
    const refusals = [
      await http(fixture.port, "/api/rpc", {
        method: "POST",
        body,
        host: `127.0.0.1:${fixture.port}`,
      }),
      await rpc(
        fixture.port,
        "queue.ui-snapshot",
        {},
        randomBytes(32).toString("base64url"),
      ),
      await rpc(fixture.port, "queue.ui-snapshot", {}, "not-a-token"),
      await rpc(
        fixture.port,
        "queue.ui-snapshot",
        {},
        minted.token.slice(0, -1) + (minted.token.endsWith("A") ? "B" : "A"),
      ),
    ];
    for (const refusal of refusals) {
      assert.equal(refusal.status, 401);
      assert.equal(JSON.parse(refusal.body).error.code, "unauthenticated");
      assert.match(String(refusal.headers["www-authenticate"]), /Bearer/);
    }
    const events = await http(fixture.port, "/api/events", {
      host: `127.0.0.1:${fixture.port}`,
    });
    assert.equal(events.status, 401, "the live channel is token-gated too");

    assert.equal(
      (await rpc(fixture.port, "queue.ui-snapshot", {}, minted.token)).status,
      200,
      "a live token is served",
    );

    // Expiry is read from the token's own clock, not from the service.
    fixture.clock.now += 6 * 60_000;
    assert.equal(
      (await rpc(fixture.port, "queue.ui-snapshot", {}, minted.token)).status,
      401,
      "an expired token is refused",
    );

    // Revocation refuses every outstanding token at once.
    const second = await mintToken(fixture.client);
    assert.equal(
      (await rpc(fixture.port, "queue.ui-snapshot", {}, second.token)).status,
      200,
    );
    assert.deepEqual(
      await fixture.client.request("service.ui-link", { action: "revoke" }),
      { revoked: 1 },
    );
    assert.equal(
      (await rpc(fixture.port, "queue.ui-snapshot", {}, second.token)).status,
      401,
      "a revoked token is refused",
    );
    assert.equal(
      (await rpc(fixture.port, "queue.ui-snapshot", {}, minted.token)).status,
      401,
    );
  } finally {
    await stopBoard(fixture);
  }
});

test("a token read and a board verb work over the web; the verb lands in the store", async () => {
  const fixture = await startBoard();
  try {
    const { token } = await mintToken(fixture.client);
    const snapshot = await rpc(fixture.port, "queue.ui-snapshot", {}, token);
    assert.equal(snapshot.status, 200);
    const board = JSON.parse(snapshot.body).result as {
      revision: number;
      paused: boolean;
      tasks: unknown[];
    };
    assert.ok(Array.isArray(board.tasks));
    assert.equal(typeof board.revision, "number");

    const paused = await rpc(
      fixture.port,
      "queue.control",
      { paused: false },
      token,
    );
    assert.equal(paused.status, 200);
    assert.deepEqual(JSON.parse(paused.body).result, { ok: true });
    assert.equal(
      await fixture.service.debug({
        target: "store",
        method: "getMeta",
        args: ["paused"],
      }),
      false,
    );

    const unknown = await rpc(fixture.port, "queue.not-a-method", {}, token);
    assert.equal(unknown.status, 404);
    assert.equal(JSON.parse(unknown.body).error.code, "method_unknown");

    const invalid = await rpc(
      fixture.port,
      "queue.control",
      { paused: "yes" },
      token,
    );
    assert.equal(invalid.status, 400);
    assert.equal(JSON.parse(invalid.body).error.code, "invalid_input");
  } finally {
    await stopBoard(fixture);
  }
});

test("Settings writes work over the web with a token and record the web surface; the socket still refuses them", async () => {
  const fixture = await startBoard();
  try {
    const { token } = await mintToken(fixture.client);
    const before = (await fixture.client.request(
      "queue.capacity-state",
      {},
    )) as { changes: { surface: string }[] };
    // A token alone is not the Settings screen: the same write without its marker is refused, and nothing changes.
    const unmarked = await rpc(
      fixture.port,
      "queue.capacity",
      { globalLimit: 21, projectLimit: 4 },
      token,
    );
    assert.equal(unmarked.status, 403);
    assert.equal(JSON.parse(unmarked.body).error.code, "refused");
    assert.match(JSON.parse(unmarked.body).error.message, /Settings write/);
    assert.equal(
      (
        (await fixture.client.request("queue.capacity-state", {})) as {
          changes: unknown[];
        }
      ).changes.length,
      before.changes.length,
      "a refused unmarked write records nothing",
    );

    const applied = await rpc(
      fixture.port,
      "queue.capacity",
      { globalLimit: 22, projectLimit: 4 },
      token,
      undefined,
      true,
    );
    assert.equal(applied.status, 200, applied.body);
    assert.deepEqual(JSON.parse(applied.body).result, { ok: true });
    const after = (await fixture.client.request(
      "queue.capacity-state",
      {},
    )) as {
      changes: { surface: string }[];
      effective: { globalLimit: number };
    };
    assert.equal(after.effective.globalLimit, 22);
    assert.equal(after.changes.length, before.changes.length + 1);
    assert.equal(
      after.changes.at(-1)!.surface,
      "web",
      "the change names the surface it arrived from",
    );

    // The same write without a token is refused by the transport before any handler runs.
    const tokenless = await rpc(fixture.port, "queue.capacity", {
      globalLimit: 23,
      projectLimit: 4,
    });
    assert.equal(tokenless.status, 401);
    // The socket (CLI, task shell) keeps refusing every Settings write with zero mutation.
    await assert.rejects(
      () =>
        fixture.client.request("queue.capacity", {
          globalLimit: 24,
          projectLimit: 4,
        }),
      (error: unknown) =>
        error instanceof ServiceRequestError && error.code === "refused",
    );
    assert.equal(
      (
        (await fixture.client.request("queue.capacity-state", {})) as {
          effective: { globalLimit: number };
        }
      ).effective.globalLimit,
      22,
    );
  } finally {
    await stopBoard(fixture);
  }
});

test("a worker self-registration is refused over the web even with a token", async () => {
  const fixture = await startBoard();
  try {
    const { token } = await mintToken(fixture.client);
    const refused = await rpc(
      fixture.port,
      "task.register",
      {
        title: "From the web",
        description: "Should not register",
        complexity: "low",
        caller: "web",
      },
      token,
    );
    assert.equal(refused.status, 403);
    assert.equal(JSON.parse(refused.body).error.code, "refused");
    assert.match(
      JSON.parse(refused.body).error.message,
      /registers itself from its own thread/,
    );
  } finally {
    await stopBoard(fixture);
  }
});

test("the live channel delivers the board revision, then each later change, and closes when its token is revoked", async () => {
  const fixture = await startBoard();
  try {
    const { token } = await mintToken(fixture.client);
    const events = openEvents(fixture.port, token);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(events.status(), 200);
      const first = await events.next((event) => event.event === "board");
      const firstBoard = first.data as { revision: number; tasks: unknown[] };
      assert.equal(first.id, String(firstBoard.revision));
      assert.ok(Array.isArray(firstBoard.tasks));

      // A verb that moves the revision reaches the open stream as a newer board.
      assert.equal(
        (await rpc(fixture.port, "queue.control", { paused: true }, token))
          .status,
        200,
      );
      const moved = await events.next(
        (event) =>
          event.event === "board" &&
          (event.data as { revision: number }).revision > firstBoard.revision,
      );
      assert.ok(
        (moved.data as { revision: number }).revision > firstBoard.revision,
      );

      // Revoking the token closes the stream; no board arrives after it.
      await fixture.client.request("service.ui-link", { action: "revoke" });
      await events.next(() => false, 5_000).catch(() => undefined);
      assert.equal(
        events.ended(),
        true,
        "the stream ends when its token is revoked",
      );
    } finally {
      events.close();
    }
  } finally {
    await stopBoard(fixture);
  }
});

test("the board serves its minimal page when no bundle is built, with a restrictive policy", async () => {
  const fixture = await startBoard();
  try {
    const page = await http(fixture.port, "/", {
      host: `127.0.0.1:${fixture.port}`,
    });
    assert.equal(page.status, 200);
    assert.match(page.body, /web board isn't built yet/);
    assert.match(
      String(page.headers["content-security-policy"]),
      /frame-ancestors 'none'/,
    );
    assert.equal(page.headers["cache-control"], "no-store");
    const missing = await http(fixture.port, "/assets/app.js", {
      host: `127.0.0.1:${fixture.port}`,
    });
    assert.equal(missing.status, 404);
    // A target that does not parse is a typed refusal, not a server fault.
    const malformed = await http(fixture.port, "//", {
      host: `127.0.0.1:${fixture.port}`,
    });
    assert.equal(malformed.status, 400);
    assert.equal(JSON.parse(malformed.body).error.code, "invalid_input");
  } finally {
    await stopBoard(fixture);
  }
});

test("token issuance is bounded and the table keeps only digests of what it issued", () => {
  let clock = 0;
  const tokens = new WebTokens(() => clock);
  const issued: string[] = [];
  for (let index = 0; index < 20; index++)
    issued.push(tokens.issue(60_000).token);
  // Eviction is oldest-first: the first four are gone, the newest sixteen remain.
  assert.equal(tokens.admit(issued[0]), null);
  assert.equal(tokens.admit(issued[3]), null);
  assert.ok(tokens.admit(issued[4]));
  assert.ok(tokens.admit(issued.at(-1)));
  assert.equal(tokens.revokeAll(), 16);
  assert.equal(tokens.admit(issued.at(-1)), null);
  clock = 61_000;
  assert.equal(
    tokens.admit(issued.at(-1)),
    null,
    "a revoked token stays refused after its expiry",
  );
});

test("every Settings write named by the web surface is a mutating catalogue method", () => {
  const byName = new Map(RPC_CATALOGUE.map((entry) => [entry.name, entry]));
  for (const name of SETTINGS_WRITE_METHODS) {
    const entry = byName.get(name);
    assert.ok(
      entry,
      `${name} must be a catalogue method, or the marker guards nothing`,
    );
    assert.equal(entry.mutating, true, `${name} changes state`);
  }
});
