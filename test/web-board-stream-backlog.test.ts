import { test } from "node:test";
import assert from "node:assert/strict";
import {
  get as httpGet,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { WebBoard, type WebBoardHost } from "../service/web/web-board";
import { uiBoardSchema, type UiBoard } from "../shared/contracts";

/**
 * The live channel's backlog bound (nucleus#1542). A client that stops reading must not
 * let the service queue board revisions for it without limit, and a stream that stays
 * backlogged is closed so its slot frees. These cases use the real board on real loopback
 * sockets with a fake executor host. Only the buffer bound and the stall timeout are
 * shortened, and every board frame is larger than the bound, so one frame backlogs a stream.
 */

const LIMIT = 64 * 1024;
const PAYLOAD = 100_000;

const board = (revision: number): UiBoard =>
  uiBoardSchema.parse({
    revision,
    connected: true,
    hostId: "host",
    paused: false,
    error: `revision ${revision} `.padEnd(PAYLOAD, "x"),
    quiet: true,
    activeWorkers: 0,
    unsettled: 0,
    occupiedSlots: 0,
    globalLimit: 32,
    projectLimit: 5,
    tasks: [],
    profiles: [],
    pool: [],
    availability: [],
    assignments: {},
    recentAssignments: {},
    lanes: [],
    projects: [],
    prStates: {},
    stoppedThreads: 0,
    resumedThreads: 0,
  });

function executor(initial: UiBoard) {
  let current = initial;
  const listeners = new Set<() => void>();
  const host: WebBoardHost = {
    call: async () => {
      throw new Error("the stream cases make no catalogue calls");
    },
    board: () => current,
    unavailable: () => null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    host,
    publish(next: UiBoard) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

async function startBoard(options: { limit?: number; stallMs?: number } = {}) {
  const exec = executor(board(1));
  const web = new WebBoard({
    host: exec.host,
    bundleDir: null,
    port: 0,
    streamBufferLimitBytes: options.limit ?? LIMIT,
    streamStallMs: options.stallMs ?? 60_000,
  });
  const port = await web.listen();
  const link = web.issueLink(5);
  const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get("token");
  assert.ok(token, "the link fragment carries the token");
  const cookie = await pair(port, token);
  return { web, port, cookie, publish: exec.publish };
}

type Fixture = Awaited<ReturnType<typeof startBoard>>;

function send(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function pair(port: number, token: string): Promise<string> {
  const paired = await send(port, "/api/pair", { authorization: `Bearer ${token}` }, "POST");
  assert.equal(paired.status, 200);
  const cookie = String(paired.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  assert.match(cookie, /^nucleus_session=[A-Za-z0-9_-]{43}$/);
  return cookie;
}

interface Events {
  status: number;
  req: ClientRequest;
  res: IncomingMessage;
  text(): string;
  closed(): boolean;
  resume(): void;
}

/** Open the live channel and read nothing until `resume()`: the client that stops reading. */
function openEvents(port: number, cookie: string): Promise<Events> {
  return new Promise((resolve, reject) => {
    let body = "";
    let closed = false;
    const req = httpGet(
      {
        host: "127.0.0.1",
        port,
        path: "/api/events",
        headers: { host: `127.0.0.1:${port}`, cookie },
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("close", () => {
          closed = true;
        });
        res.on("error", () => {
          closed = true;
        });
        res.pause();
        resolve({
          status: res.statusCode ?? 0,
          req,
          res,
          text: () => body,
          closed: () => closed,
          resume: () => res.resume(),
        });
      },
    );
    req.on("error", reject);
  });
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const boardIds = (text: string) =>
  [...text.matchAll(/id: (\d+)\nevent: board\n/g)].map((match) => Number(match[1]));

const turn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const backlogged = (fixture: Fixture) =>
  fixture.web.liveStreamBacklog().every((stream) => stream.bufferedBytes > LIMIT);

/**
 * Publish until every stream's socket holds more than the bound and stays so. The loop
 * yields between revisions: the kernel absorbs a few megabytes per socket before it stops
 * accepting, and only then does the service's own queue hold the rest.
 */
async function publishUntilBacklogged(fixture: Fixture, from: number): Promise<number> {
  for (let revision = from; revision < from + 500; revision++) {
    fixture.publish(board(revision));
    await turn(5);
    if (backlogged(fixture)) {
      await turn(50);
      if (backlogged(fixture)) return revision;
    }
  }
  throw new Error("the stalled clients never backlogged their streams");
}

test("a client that never reads keeps its stream's buffered bytes under the bound across many revisions", async () => {
  const fixture = await startBoard();
  const stalled = await openEvents(fixture.port, fixture.cookie);
  try {
    assert.equal(stalled.status, 200);
    await waitFor(() => fixture.web.liveStreamBacklog().length === 1, "the stream to register");
    const backlogRevision = await publishUntilBacklogged(fixture, 2);
    const frameBytes = Buffer.byteLength(JSON.stringify(board(backlogRevision)));

    let peak = 0;
    for (let revision = backlogRevision + 1; revision <= backlogRevision + 40; revision++) {
      fixture.publish(board(revision));
      peak = Math.max(peak, fixture.web.liveStreamBacklog()[0].bufferedBytes);
    }

    assert.ok(
      peak <= LIMIT + frameBytes + 1024,
      `buffered ${peak} bytes exceeded the bound ${LIMIT} plus one frame of ${frameBytes}`,
    );
    assert.equal(
      fixture.web.liveStreamBacklog()[0].stalled,
      true,
      "a backlogged stream is armed for the stall timeout",
    );
    assert.equal(stalled.closed(), false, "the stream stays open until the stall timeout");
  } finally {
    stalled.req.destroy();
    await fixture.web.close();
  }
});

test("a stalled stream that drains receives the latest revision, not the ones it skipped", async () => {
  const fixture = await startBoard();
  const stalled = await openEvents(fixture.port, fixture.cookie);
  try {
    assert.equal(stalled.status, 200);
    await waitFor(() => fixture.web.liveStreamBacklog().length === 1, "the stream to register");
    const backlogRevision = await publishUntilBacklogged(fixture, 2);
    const latest = backlogRevision + 20;
    for (let revision = backlogRevision + 1; revision <= latest; revision++)
      fixture.publish(board(revision));

    stalled.resume();
    await waitFor(() => boardIds(stalled.text()).includes(latest), "the latest revision");

    const delivered = boardIds(stalled.text());
    assert.equal(delivered.at(-1), latest, "the drained stream ends on the latest revision");
    assert.ok(
      delivered.length < latest - 1,
      `the skipped revisions were not replayed: delivered ${delivered.length} of ${latest}`,
    );
    assert.equal(fixture.web.liveStreamBacklog()[0].stalled, false, "a drained stream disarms its stall timer");
    assert.equal(stalled.closed(), false, "a drained stream stays open");
  } finally {
    stalled.req.destroy();
    await fixture.web.close();
  }
});

test("a stream that stays backlogged past the stall timeout is closed, freeing its slot", async () => {
  const fixture = await startBoard({ stallMs: 1_000 });
  const clients: Events[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const client = await openEvents(fixture.port, fixture.cookie);
      assert.equal(client.status, 200);
      clients.push(client);
    }
    await waitFor(() => fixture.web.liveStreamBacklog().length === 8, "eight streams to register");

    await publishUntilBacklogged(fixture, 2);
    assert.ok(
      fixture.web.liveStreamBacklog().every((stream) => stream.stalled),
      "every stalled client is backlogged and its stall timer is armed",
    );

    const refused = await openEvents(fixture.port, fixture.cookie);
    refused.res.resume();
    assert.equal(refused.status, 503, "all eight slots are held while the stalled streams wait");

    await waitFor(() => fixture.web.liveStreamBacklog().length === 0, "the stalled streams to close", 5_000);
    // The server has closed the sockets; a client that never reads sees the close only once it reads.
    for (const client of clients) client.resume();
    await waitFor(() => clients.every((client) => client.closed()), "the clients to see their close");

    const reopened = await openEvents(fixture.port, fixture.cookie);
    assert.equal(reopened.status, 200, "the freed slot takes a new live stream");
    reopened.req.destroy();
  } finally {
    for (const client of clients) client.req.destroy();
    await fixture.web.close();
  }
});
