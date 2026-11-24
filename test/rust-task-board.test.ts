import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { profilesSnapshot } from "../client/web/rust-api";
import {
  createRustBoardTransport,
  rustWaitDetail,
  type RustCommand,
  type RustTask,
} from "../client/web/rust-board";
import { WebBoard } from "../service/web/web-board";
import { RustBoardProxy } from "../service/web/rust-board";
import { uiBoardSchema } from "../shared/contracts";
import { inboxListWidth } from "../shared/inbox-board";

const legacy = uiBoardSchema.parse({
  revision: 1,
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
});
const repository = "https://github.com/example/board-fixture";

test("Rust board settings retain imported profile fields across edits", () => {
  const profile = {
    name: "Fixture",
    selection: {
      id: "fixture", provider: "claude", model: "fixture-model",
      effort: "high", capability: "worker", weight: "fewer",
    },
    group: "fixture-group",
    enabled: false,
    roles: ["reviewer", "coordinator"],
    scopes: ["general", "complex"],
    providerInstanceId: "claude-fixture",
    modeId: "accept-edits",
    featureValues: { speed: "priority", legacy: { data: true } },
    notes: "Fixture notes",
    unrated: true,
  };
  const saved = { profiles: [profile], pausedGroups: ["fixture-group"] };
  const settings = profilesSnapshot.parse({
    revision: "fixture-revision", configured: true, value: saved,
  });
  assert.deepEqual(settings.value, saved);
});

const head = "a".repeat(40);
const task = (
  id: string,
  phase: RustTask["phase"],
  reference: string = id,
): RustTask => ({
  identity: { id, repository, reference, base: "main" },
  lifecycle: {
    steps: [
      { key: "queued", label: "Queued", state: phase === "queued" ? "current" : "done", tone: "accent", elapsedMs: null, activeSinceMs: null, note: null, roundLabel: null },
      { key: "working", label: "Working", state: phase === "working" ? "current" : "todo", tone: "accent", elapsedMs: phase === "working" ? 831_000 : null, activeSinceMs: null, note: null, roundLabel: null },
      { key: "review", label: "Review", state: "todo", tone: "muted", elapsedMs: null, activeSinceMs: null, note: null, roundLabel: "Round 2" },
      { key: "merge", label: "Merge", state: "todo", tone: "muted", elapsedMs: null, activeSinceMs: null, note: null, roundLabel: null },
      { key: "close", label: "Close", state: "todo", tone: "muted", elapsedMs: null, activeSinceMs: null, note: null, roundLabel: null },
    ],
    admittedAtMs: 1_790_000_000_000,
    finishedAtMs: null,
    reviewRound: 2,
    worker: { thread: "fixture-worker", provider: "codex", model: "fixture-worker-model" },
    reviewer: { thread: "fixture-reviewer", provider: "claude", model: "fixture-review-model" },
  },
  phase,
  version: 7,
  wait: null,
  attention: "waiting",
  nextCheckAt: null,
  question: null,
  hold: null,
  stateLabel: phase[0]!.toUpperCase() + phase.slice(1),
  stateSinceMs: null,
});

test("Rust task status names the check and only shows a time while it is scheduled", () => {
  const row = task("retained", "working");
  const checking = rustWaitDetail({
    ...row, wait: "host_unknown",
    waitDetail: "Checking whether the message reached the task thread.",
    nextCheckAt: Date.UTC(2026, 10, 24, 17, 45),
  });
  assert.match(checking ?? "", /^Checking whether the message reached the task thread\. Next check at .+\.$/);
  const blocked = rustWaitDetail({ ...row, wait: "host_observation_blocked" });
  assert.equal(blocked, "Open the task thread to check.");
});

test("Rust task detail keeps Answer available alongside unknown command names", async (t) => {
  const id = "fixture";
  const path = `/api/engine/tasks/${id}`;
  const question = {
    work: {
      prompt: "Which approach should the worker use?",
      options: ["Recommended:|Keep the current approach", "Try a new approach"],
    },
  };
  const current = {
    ...task(id, "working"),
    attention: "attention",
    wait: "question",
    question,
  };
  const commands = [
    { name: "move", phase: "working", preflight: "ready" },
    { name: "answer", preflight: "ready" },
    { name: "set_dependencies", preflight: "unavailable" },
    { name: "set_prerequisite_wait", preflight: "ready" },
  ];
  const unknownCommand = { name: "future_task_action", preflight: "ready" };
  const history = [
    {
      sequence: 3,
      content: { at: 1_700_000_000_000 },
      presentation: [
        { kind: "run_ended", instance: "finished" },
        { kind: "question", question },
      ],
    },
  ];
  const responses = new Map<string, unknown>([
    [
      path,
      {
        ...current,
        createdAtMs: 1_700_000_000_000,
        brief: { text: "Fixture brief", version: 1 },
        pullRequest: null,
        verdict: null,
        run: null,
      },
    ],
    [
      path + "/next",
      { ...current, commands: [unknownCommand, ...commands, unknownCommand] },
    ],
    [path + "/history?limit=30", history],
  ]);
  const transport = createRustBoardTransport(async (url) => {
    assert.ok(typeof url === "string" && responses.has(url));
    return Response.json(responses.get(url));
  });
  const { signal } = new AbortController();
  assert.deepEqual((await transport.detail(id, signal)).question, question);
  assert.deepEqual(await transport.history(id, undefined, signal), history);
  const warn = t.mock.method(console, "warn", (..._args: unknown[]) => {});
  const next = await transport.next(id, signal);
  assert.deepEqual(next.question, question);
  assert.deepEqual(next.commands, commands);
  assert.deepEqual((await transport.next(id, signal)).commands, commands);
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(warn.mock.calls[0]?.arguments.includes(unknownCommand.name));

  responses.set(path + "/next", {
    ...current,
    commands: [{ name: "answer", preflight: "invalid" }],
  });
  await assert.rejects(transport.next(id, signal), /invalid response/);
});

async function eventually(
  check: () => boolean,
  message: string,
  timeout = 4000,
) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.ok(check(), message);
}

test("the paired Board tracks Rust task changes and uses the next command contract", async (t) => {
  const root = await mkdtemp(join(process.env.TMPDIR!, "rust-board-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = randomBytes(32).toString("hex");
  const running = {
    ...task("running", "working", "old display reference"),
    number: 81,
    reference: "board-fixture#81",
  };
  const blocked: RustTask = {
    ...task("blocked", "queued", "Blocked task"),
    question: { retry: { role: "worker" } } satisfies RustTask["question"],
    wait: "question",
    attention: "attention",
  };
  const rows = [
    running,
    blocked,
    task("reviewing", "reviewing"),
    task("merging", "merging"),
    task("closing", "closing"),
    task("done", "done"),
    task("cancelled", "cancelled"),
    ...Array.from({ length: 25 }, (_, index) =>
      task(`queued-${index}`, "queued"),
    ),
  ];
  const posts: { path: string; command: unknown }[] = [];
  const calls: {
    path: string;
    authorization?: string;
    cookie?: string;
    origin?: string;
  }[] = [];
  const streams = new Set<ServerResponse>();
  let activity = "Editing the fixture";
  let moveReadiness: "pending" | "ready" = "pending";
  let authorityCold = false;
  const engine = createServer(async (req, res) => {
    const path = req.url ?? "";
    calls.push({
      path,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      origin: req.headers.origin,
    });
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401).end();
      return;
    }
    const json = (value: unknown, status = 200) =>
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    if (path === "/v1/events") {
      streams.add(res);
      res.on("close", () => streams.delete(res));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: refresh\ndata: {}\n\n");
      return;
    }
    if (path === "/v1/tasks") {
      json(rows);
      return;
    }
    const [, , , id, route] = path.split("/");
    const row = rows.find((row) => row.identity.id === id);
    if (!row) {
      json({ error: "missing" }, 404);
      return;
    }
    if (req.method === "POST" && route === "commands") {
      if (authorityCold) {
        json(
          { error: "planner authority is not yet known. Retry shortly." },
          503,
        );
        return;
      }
      const parts: Uint8Array[] = [];
      for await (const part of req) parts.push(part);
      const command: unknown = JSON.parse(Buffer.concat(parts).toString());
      posts.push({ path, command });
      if (
        typeof command === "object" &&
        command !== null &&
        "move" in command &&
        moveReadiness === "pending"
      ) {
        json({ status: "pending", version: row.version }, 202);
        return;
      }
      if (
        typeof command === "object" &&
        command !== null &&
        "answer" in command &&
        id === "blocked"
      ) {
        row.question = null;
        row.wait = null;
        row.attention = "waiting";
        row.version++;
      }
      if (
        typeof command === "object" &&
        command !== null &&
        "move" in command &&
        command.move === "reviewing"
      ) {
        row.phase = "reviewing";
        row.version++;
      }
      json(row);
      return;
    }
    if (route === "next") {
      json({
        version: row.version,
        phase: row.phase,
        wait: row.wait,
        question: row.question,
        nextCheckAt: row.nextCheckAt,
        attention: row.attention,
        allowance: { usedMs: 180_000, limitMs: 3_600_000, exhausted: false },
        stateLabel: row.stateLabel,
        stateSinceMs: row.stateSinceMs,
        commands: [
          { name: "move", phase: "reviewing", preflight: moveReadiness },
          { name: "move", phase: "done", preflight: "unavailable" },
          { name: "cancel", preflight: "ready" },
          { name: "amend", preflight: "ready" },
          { name: "hold", preflight: "ready" },
          { name: "set_dependencies", preflight: "unavailable" },
          { name: "set_prerequisite_wait", preflight: "unavailable" },
          ...(row.question
            ? [
                { name: "future_board_action", preflight: "ready" },
                { name: "answer", preflight: "ready" },
              ]
            : []),
        ],
      });
      return;
    }
    if (route?.startsWith("history?")) {
      json([
        {
          sequence: 6,
          content: {
            at: 1_700_000_000_000,
            detail: "run ticket material is not a display record",
          },
          presentation: [
            {
              kind: "run_started",
              instance: "finished",
              role: "reviewer",
              purpose: "Checking round 1",
              reviewHead: head,
            },
            {
              kind: "pull_request",
              url: "https://github.com/example/board-fixture/pull/1",
            },
          ],
        },
      ]);
      return;
    }
    json({
      ...row,
      createdAtMs: 1_700_000_000_000,
      brief: { text: "Fixture brief", version: 1, digest: Array(32).fill(1) },
      pullRequest:
        id === "running"
          ? { url: "https://github.com/example/board-fixture/pull/1", head }
          : null,
      verdict: null,
      run:
        id === "running"
          ? {
              role: "worker",
              thread: "child-thread",
              instance: "current",
              purpose: "Implement the fixture",
              reservedAt: 1_700_000_000_000,
              lastSendAt: 1_700_000_000_000,
              revoked: false,
              activity: { label: activity, startedAt: 1_700_000_000_000 },
            }
          : null,
    });
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    engine.closeAllConnections();
    return new Promise<void>((resolve) => engine.close(() => resolve()));
  });
  const engineAddress = engine.address();
  assert.ok(engineAddress && typeof engineAddress !== "string");

  const { buildWeb } = await (new Function(
    "return import('../scripts/build-runtime.mjs')",
  )() as Promise<{ buildWeb(path: string): Promise<void> }>);
  await buildWeb(root);
  const bundle = await readFile(join(root, "app.js"), "utf8");
  assert.ok(!bundle.includes(key));
  assert.doesNotMatch(bundle, /NUCLEUS_BOARD_ENGINE_(KEY|URL)|RustBoardProxy/);

  const board = new WebBoard({
    bundleDir: root,
    port: 0,
    rustBoard: new RustBoardProxy({
      url: `http://127.0.0.1:${engineAddress.port}`,
      key,
    }),
    host: {
      call: async (method) => {
        if (method === "queue.ui-snapshot") return legacy;
        if (method === "lead.board") return { cards: [], links: [] };
        return [];
      },
      board: () => legacy,
      unavailable: () => null,
      subscribe: () => () => {},
    },
  });
  const port = await board.listen();
  t.after(() => board.close());
  const origin = `http://127.0.0.1:${port}`;
  const link = board.issueLink(5).url;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: link,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const browserCalls: { path: string; credential: string | null }[] = [];
  let cookie = "";
  const fetcher: typeof fetch = async (input, options = {}) => {
    const path = String(input);
    const headers = new Headers(options.headers);
    browserCalls.push({ path, credential: headers.get("authorization") });
    if (cookie) headers.set("cookie", cookie);
    if (options.method === "POST") headers.set("origin", origin);
    const response = await fetch(origin + path, { ...options, headers });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return response;
  };
  const text = () => dom.window.document.body.textContent ?? "";
  const click = async (label: string) => {
    const control = () =>
      dom.window.document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    await eventually(() => Boolean(control()), `visible control: ${label}`);
    control()?.click();
  };
  const reads = (path: string) =>
    calls.filter((request) => request.path === path).length;
  const invalidate = () => {
    for (const stream of streams)
      stream.write(
        'event: invalidate\ndata: {"taskId":"running","version":7}\n\n',
      );
  };

  assert.equal((await fetch(origin + "/api/engine/tasks")).status, 401);
  assert.equal(calls.length, 0);
  Object.assign(dom.window, {
    matchMedia: () =>
      Object.assign(new dom.window.EventTarget(), { matches: true }),
    fetch: fetcher,
    TextDecoder,
    TextEncoder,
    AbortController,
  });
  dom.window.eval(`(() => { ${bundle} })()`);
  await click("Queue, 26");
  await click("Show 1 more task");
  await eventually(
    () => !text().includes("1 more"),
    "overflow expands in its view",
  );
  await click("Working, 1");
  // The card shows the task number alone; the project shows beside it.
  const workingStep = '[aria-label="Step Working: current · 13m 51s"]';
  await eventually(
    () => Boolean(dom.window.document.querySelector(workingStep)),
    "the board card shows the projected work duration",
  );
  await click("#81");
  await eventually(() => text().includes(activity), "initial activity");
  await eventually(
    () => dom.window.document.querySelectorAll(workingStep).length === 2,
    "the card and detail render the same progress step",
  );
  assert.match(text(), /fixture-worker-model/);
  assert.match(text(), /fixture-review-model/);
  assert.equal(dom.window.document.querySelectorAll('[aria-label="Step Review: todo · Round 2"]').length, 2);
  await eventually(() => text().includes("3m / 1h"), "task allowance");
  const beforeList = reads("/v1/tasks");
  const beforeDetail = reads("/v1/tasks/running");
  const beforeNext = reads("/v1/tasks/running/next");

  activity = "Testing the retry path";
  invalidate();
  await eventually(
    () => text().includes(activity),
    "a same-version frame refreshed activity",
  );
  await click("Move, Move");
  assert.equal(
    dom.window.document.querySelector('[aria-label="Move: Done"]'),
    null,
  );
  await click("Move: Reviewing, Check required");
  await eventually(
    () => text().includes("Try again when the command is ready"),
    "the engine reported pending",
  );
  assert.deepEqual(
    posts.map(({ command }) => command),
    [{ move: "reviewing" }],
  );
  activity = "Checking the final patch";
  moveReadiness = "ready";
  invalidate();
  await eventually(
    () => text().includes(activity),
    "a second frame at the same version also refreshed",
  );
  assert.ok(reads("/v1/tasks") > beforeList);
  assert.ok(reads("/v1/tasks/running") >= beforeDetail + 2);
  assert.ok(reads("/v1/tasks/running/next") >= beforeNext + 2);

  await click("Activity");
  await eventually(
    () => text().includes("Checking round 1"),
    "paged history is visible",
  );
  assert.doesNotMatch(text(), /run ticket material/);
  const beforeReconnect = {
    list: reads("/v1/tasks"),
    detail: reads("/v1/tasks/running"),
    next: reads("/v1/tasks/running/next"),
    history: reads("/v1/tasks/running/history?limit=30"),
  };
  for (const stream of streams) stream.end();
  await eventually(
    () =>
      reads("/v1/tasks") > beforeReconnect.list &&
      reads("/v1/tasks/running") > beforeReconnect.detail &&
      reads("/v1/tasks/running/next") > beforeReconnect.next &&
      reads("/v1/tasks/running/history?limit=30") > beforeReconnect.history,
    "reconnect refreshes the list and every visible read",
    7000,
  );

  await click("Overview");
  await click("Move, Move");
  await click("Move: Reviewing");
  await eventually(
    () =>
      posts.filter(({ path }) => path === "/v1/tasks/running/commands")
        .length === 2,
    "move posted",
  );
  assert.deepEqual(posts[1]?.command, { move: "reviewing" });
  await click("Needs you, 1");
  await click("Blocked task, The worker could not finish. Try again?");
  await click("Answer");
  await eventually(
    () => posts.some(({ path }) => path === "/v1/tasks/blocked/commands"),
    "answer posted",
  );
  assert.deepEqual(posts[2]?.command, { answer: "retry" });
  await click("History, 2");
  await eventually(
    () => /Done/.test(text()) && /Cancelled/.test(text()),
    "only the terminal phases are history",
  );

  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      origin + "/api/engine/tasks",
      { headers: { host: "example.org", cookie } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(badHost, 403);
  assert.equal(
    (
      await fetch(origin + "/api/engine/tasks/running/commands", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: '"cancel"',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(origin + "/api/engine/tasks/running/commands", {
        method: "POST",
        headers: {
          cookie,
          origin: `http://localhost:${port}`,
          "content-type": "application/json",
        },
        body: '"cancel"',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(origin + "/api/engine/tasks/running/acp", {
        headers: { cookie },
      })
    ).status,
    404,
  );
  assert.equal(
    (await fetch(origin + "/api/engine/settings", { headers: { cookie } }))
      .status,
    404,
  );
  assert.equal(posts.length, 3);
  authorityCold = true;
  await assert.rejects(
    createRustBoardTransport(fetcher).command("running", { hold: "Fixture" }),
    { message: "planner authority is not yet known. Retry shortly." },
  );
  assert.ok(
    calls.every(
      (call) =>
        call.authorization === `Bearer ${key}` && !call.cookie && !call.origin,
    ),
  );
  assert.ok(
    browserCalls
      .filter(({ path }) => path.startsWith("/api/engine/"))
      .every(({ credential }) => credential === null),
  );
  assert.ok(browserCalls.every(({ credential }) => !credential?.includes(key)));

  // Leave the board connected for longer than the legacy snapshot interval.
  await eventually(
    () =>
      streams.size === 1 &&
      rows.find((row) => row.identity.id === "blocked")?.question === null,
    "answer applied",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const size = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 4200));
  assert.equal(calls.length, size, "the Rust list and detail do not poll");
});

test("typed Board commands match Rust serde shapes and pending is a single write", async () => {
  const commands: RustCommand[] = [
    { move: "closing" },
    { answer: { work: "Use the compact layout" } },
    { answer: "retry" },
    { answer: { accept: { head, reason: "Manually reviewed" } } },
    "cancel",
    { amend: "Updated brief" },
    { hold: "Hold for proof" },
    "release",
  ];
  const sent: unknown[] = [];
  const transport = createRustBoardTransport(async (url, options) => {
    assert.equal(url, "/api/engine/tasks/fixture/commands");
    assert.equal(options?.method, "POST");
    sent.push(JSON.parse(String(options.body)));
    return Response.json({ status: "pending", version: 7 }, { status: 202 });
  });
  for (const command of commands)
    assert.deepEqual(await transport.command("fixture", command), {
      status: "pending",
      version: 7,
    });
  assert.deepEqual(sent, commands);
  assert.throws(
    () =>
      new RustBoardProxy({
        url: "http://example.org",
        key: head.padEnd(64, "a"),
      }),
    /loopback/,
  );
});

test("the standalone bundle is the shared web board on the Rust routes and refreshes on push", async (t) => {
  const root = await mkdtemp(join(process.env.TMPDIR!, "engine-board-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { buildEngineBoard } = await (new Function(
    "return import('../scripts/build-web.mjs')",
  )() as Promise<{ buildEngineBoard(path: string): Promise<void> }>);
  await buildEngineBoard(root);
  const script = await readFile(join(root, "app.js"), "utf8");
  const token = "a".repeat(64);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://127.0.0.1:4319/#token=" + token,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const writes: Array<{ path: string; body: { revision: string; value: Record<string, unknown> } }> = [];
  const requests: string[] = [];
  let taskPhase: RustTask["phase"] = "queued";
  const now = 1_800_000_000_000;
  dom.window.Date.now = () => now;
  const held = {
    ...task("held-task", "queued", "board-fixture#81"),
    number: 81,
    reference: "board-fixture#81",
    title: "Held task",
    wait: "hold",
    hold: { reason: "Wait for the schema review. Then continue with the API." },
    stateLabel: "Held by planner",
    stateSinceMs: now - 3 * 3_600_000 - 60_000,
  };
  let dispatch = {
    usage: "normal", usageUntilMs: null, globalSlots: 2, projectDefaultSlots: 2,
    projectSlotOverrides: {},
    providerLimitCooldownSeconds: 300, mode: "running",
  };
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const snap = (value: unknown, revision: string) => ({ value, revision, configured: true });
  const views = {
    profiles: () => snap({ profiles: [], pausedGroups: [] }, "profiles-1"),
    dispatch: () => snap(dispatch, "dispatch-" + dispatch.globalSlots),
    projects: () => ({
      settings: snap({ projects: { fixture: { name: "Fixture project", archived: false, repositories: [
        { origin: "example/fixture", path: "/work/fixture", base: "main", requiredChecks: [], hungToolMinutes: 30 },
      ] } } }, "projects-1"),
      resolvedPlanners: { fixture: "fixture-planner" },
    }),
    hosts: () => ({ settings: snap({ t3: null }, "hosts-1"), active: { endpoint: "http://127.0.0.1:3773/", status: "reachable" } }),
    storage: () => ({
      settings: snap({ enabled: true, workRoot: null, scratchRoot: null, logRoot: null, retention: { keepNewest: 5, maxAgeDays: null } }, "storage-1"),
      active: { databaseRoot: "/e/db", workRoot: "/e/work", backupRoot: "/e/backups", scratchRoot: "/e/scratch", logRoot: "/e/logs" },
      backups: { complete: true, issues: 0, verified: [] },
    }),
  };
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    requests.push(path);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-nucleus-board"), "1");
    if (path === "/api/engine/pair") {
      assert.equal(init?.method, "POST");
      assert.equal(headers.get("authorization"), "Bearer " + token);
      assert.equal(dom.window.location.hash, "");
      return new Response(null, { status: 204 });
    }
    assert.equal(headers.get("authorization"), null);
    if (path === "/api/engine/events") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode("event: refresh\ndata: {}\n\n"));
        },
      });
      init?.signal?.addEventListener("abort", () => stream?.close(), { once: true });
      return new Response(body);
    }
    if (path === "/api/engine/theme") return Response.json({ theme: null });
    if (path === "/api/engine/profiles/usage") {
      const empty = { counts: {}, groups: {}, sample: 0 };
      return Response.json({
        recent: empty, worker: empty, reviewer: empty, totals: {}, groupTotals: {},
      });
    }
    if (path === "/api/engine/profiles/catalog")
      return Response.json({ providers: null, readAtMs: null, status: "pending" });
    if (path === "/api/engine/tasks") {
      const card = {
        ...task("board-task", taskPhase, "board-fixture#80"),
        number: 80,
        title: "Standalone task",
        stateLabel: taskPhase === "queued" ? "Waiting for capacity" : "Working*",
        stateSinceMs: now - 12 * 60_000,
        wait: taskPhase === "queued" ? "capacity" : "hold",
        hold: taskPhase === "queued" ? null : { reason: "Wait before dispatching again." },
      };
      return Response.json([card, held]);
    }
    if (path === "/api/engine/settings")
      return Response.json(Object.fromEntries(Object.entries(views).map(([key, view]) => [key, view()])));
    const domain = /^\/api\/engine\/settings\/(\w+)$/.exec(path)?.[1] as keyof typeof views | undefined;
    if (domain) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        writes.push({ path, body });
        if (domain === "dispatch") dispatch = body.value;
      }
      return Response.json(views[domain]());
    }
    if (path === "/api/engine/planning/fixture/plan")
      return Response.json({ version: 0, lanes: [], documents: [], idle: true });
    if (path === "/api/engine/planning/fixture/items" || path === "/api/engine/planning/fixture/decisions")
      return Response.json([]);
    assert.fail("Unexpected standalone route " + path);
  };
  Object.assign(dom.window, {
    innerWidth: 1280,
    matchMedia: () => Object.assign(new dom.window.EventTarget(), { matches: true }),
    fetch: fetcher,
    TextDecoder,
    TextEncoder,
    AbortController,
  });
  const selector = (label: string) =>
    dom.window.document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  const click = async (label: string) => {
    await eventually(() => Boolean(selector(label)), "visible control: " + label);
    selector(label)?.click();
  };
  const text = () => dom.window.document.body.textContent ?? "";
  dom.window.eval(`(() => { ${script} })()`);
  // The shared navigation, header and project filter render from the Rust data.
  await click("Queue, 2");
  await eventually(() => text().includes("Standalone task"), "task title renders");
  const header = (card: HTMLElement, state: string, age: string) => {
    const ageText = [...card.querySelectorAll("div")].find(
      (node) => node.childElementCount === 0 && node.textContent === age,
    );
    assert.ok(ageText?.parentElement, age);
    assert.ok(ageText.parentElement.textContent?.endsWith(state + age));
    return ageText.parentElement;
  };
  const heldCard = selector("#81, Held task")!;
  assert.ok(heldCard, "the production list renders the numbered card");
  const heldHeader = header(heldCard, "Held by planner", "3h ago");
  assert.match(heldHeader.textContent ?? "", /^#81/);
  assert.doesNotMatch(heldHeader.textContent ?? "", /Held task|schema review/);
  assert.match(heldCard.textContent ?? "", /Held taskWait for the schema review\./);
  const withoutProgress = (card: HTMLElement) => {
    const progress = card.querySelector('[aria-label^="Progress:"]');
    assert.ok(progress, "the card renders the shared progress strip");
    return (card.textContent ?? "").replace(progress.textContent ?? "", "");
  };
  assert.doesNotMatch(withoutProgress(heldCard), /Then continue|Queued|On hold/);
  const capacityCard = selector("#80, Standalone task")!;
  header(capacityCard, "Waiting for capacity", "12m ago");
  assert.doesNotMatch(withoutProgress(capacityCard), /Queued|work slot/);
  assert.ok(selector("Queue controls menu"), "the shared pause split button renders");
  assert.ok(text().includes("All projects"), "the shared project filter renders");
  taskPhase = "working";
  assert.ok(stream, "the board subscribed to engine changes");
  stream.enqueue(new TextEncoder().encode('event: invalidate\ndata: {"taskId":"board-task","version":8}\n\n'));
  await click("Working, 1");
  await eventually(() => Boolean(selector("#80, Standalone task")), "working view renders");
  const workingCard = selector("#80, Standalone task")!;
  header(workingCard, "Working*", "12m ago");
  assert.doesNotMatch(workingCard.textContent ?? "", /On hold/);
  // Dispatch hold writes the Rust Dispatch mode through Settings.
  await click("Queue controls menu");
  await click("Dispatch hold");
  await eventually(() => writes.length === 1, "the hold is written to the Dispatch domain");
  assert.equal(writes[0]!.path, "/api/engine/settings/dispatch");
  assert.equal(writes[0]!.body.value.mode, "held");
  await click("Settings");
  assert.equal(dom.window.location.pathname, "/settings");
  await eventually(() => text().includes("Usage level"), "the shared Limits section renders");
  assert.doesNotMatch(text(), /Concurrent host calls|Advanced limits/);
  assert.ok(!text().includes("Telemetry"), "retired sections stay hidden");
  assert.ok(requests.every((path) => path.startsWith("/api/engine/")));
});
