import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BOARD_SURFACE_T3,
  WebBoard,
  uiLinkInputSchema,
} from "../service/web/web-board";
import { uiBoardSchema } from "../shared/contracts";

/**
 * nucleus#1450: generated T3 project badges reach the board only through a session
 * minted for the T3 surface. A standalone link (`nucleus ui`, a browser) gets the same
 * board without them, over both the RPC route and the live channel. The board is parsed
 * by the real wire schema, so a badge the schema drops would fail here.
 */

const BADGES = {
  "t3code:env-a": {
    "/synthetic/repos/biock-aase": { monogram: "BA", color: "fuchsia" },
  },
};
const REPOSITORY_BADGES = {
  "/synthetic/repos/biock-aase": { monogram: "BA", color: "fuchsia" },
};

function boardWithBadges() {
  return uiBoardSchema.parse({
    revision: 7,
    connected: true,
    hostId: "host",
    paused: false,
    error: "",
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
    projectBadges: BADGES,
    repositoryBadges: REPOSITORY_BADGES,
  });
}

async function withBoard(run: (board: WebBoard, tmp: string) => Promise<void>) {
  const tmp = await mkdtemp(
    join(process.env.TMPDIR ?? tmpdir(), "web-badges-"),
  );
  const board = boardWithBadges();
  const server = new WebBoard({
    sessionFile: join(tmp, "web-sessions.json"),
    host: {
      call: async (method) => (method === "queue.ui-snapshot" ? board : []),
      board: () => board,
      unavailable: () => null,
      subscribe: () => () => {},
    },
  });
  try {
    await run(server, tmp);
  } finally {
    await server.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

async function pair(server: WebBoard, surface?: typeof BOARD_SURFACE_T3) {
  const port = await server.listen();
  const link = new URL(server.issueLink(5, surface).url);
  const token = new URLSearchParams(link.hash.slice(1)).get("token")!;
  const response = await fetch(`http://127.0.0.1:${port}/api/pair`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { port, cookie };
}

async function snapshotOver(port: number, cookie: string) {
  const response = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ method: "queue.ui-snapshot", input: {} }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { result: Record<string, unknown> })
    .result;
}

async function firstBoardFrame(port: number, cookie: string) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  // The stream opens with a retry hint; read until the board frame is complete.
  const complete = () => {
    const at = text.indexOf("event: board");
    return at >= 0 && text.indexOf("\n\n", at) >= 0;
  };
  while (!complete()) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  controller.abort();
  const frame = text
    .split("\n\n")
    .find((part) => part.includes("event: board"));
  assert.ok(frame, "the first live frame is the board");
  return JSON.parse(
    frame
      .split("\n")
      .find((line) => line.startsWith("data: "))!
      .slice(6),
  ) as Record<string, unknown>;
}

test("a T3 surface session receives the generated badges over the RPC route", async () => {
  await withBoard(async (server) => {
    const { port, cookie } = await pair(server, BOARD_SURFACE_T3);
    const board = await snapshotOver(port, cookie);
    assert.deepEqual(board.projectBadges, BADGES);
    assert.deepEqual(board.repositoryBadges, REPOSITORY_BADGES);
  });
});

test("a standalone session receives the same board without the badges, over RPC and live", async () => {
  await withBoard(async (server) => {
    const { port, cookie } = await pair(server);
    const board = await snapshotOver(port, cookie);
    assert.equal("projectBadges" in board, false);
    assert.equal("repositoryBadges" in board, false);
    const live = await firstBoardFrame(port, cookie);
    assert.equal("projectBadges" in live, false);
    assert.equal("repositoryBadges" in live, false);
    assert.equal(live.revision, 7);
  });
});

test("the T3 surface receives the badges over the live channel too", async () => {
  await withBoard(async (server) => {
    const { port, cookie } = await pair(server, BOARD_SURFACE_T3);
    const live = await firstBoardFrame(port, cookie);
    assert.deepEqual(live.projectBadges, BADGES);
    assert.deepEqual(live.repositoryBadges, REPOSITORY_BADGES);
  });
});

test("the surface survives a restart from the session file, and a session without one stays standalone", async () => {
  await withBoard(async (server, tmp) => {
    const { cookie } = await pair(server, BOARD_SURFACE_T3);
    await server.close();
    const persisted = JSON.parse(
      await readFile(join(tmp, "web-sessions.json"), "utf8"),
    ) as {
      sessions: Array<{ surface?: string }>;
    };
    assert.equal(persisted.sessions.length, 1);
    assert.equal(persisted.sessions[0]!.surface, BOARD_SURFACE_T3);
    const restarted = new WebBoard({
      sessionFile: join(tmp, "web-sessions.json"),
      host: {
        call: async () => boardWithBadges(),
        board: () => boardWithBadges(),
        unavailable: () => null,
        subscribe: () => () => {},
      },
    });
    try {
      const port = await restarted.listen();
      const board = await snapshotOver(port, cookie);
      assert.deepEqual(board.projectBadges, BADGES);
      assert.deepEqual(board.repositoryBadges, REPOSITORY_BADGES);
    } finally {
      await restarted.close();
    }
  });
});

test("the owner's link request names only the T3 surface, and anything else is refused", () => {
  assert.equal(
    uiLinkInputSchema.parse({ action: "issue", surface: "t3code" }).surface,
    "t3code",
  );
  assert.equal(uiLinkInputSchema.parse({ action: "issue" }).surface, undefined);
  assert.equal(
    uiLinkInputSchema.safeParse({ action: "issue", surface: "bb" }).success,
    false,
  );
});
