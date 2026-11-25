import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { profilesSnapshot, type storageView } from "../client/web/rust-api";
import {
  createRustBoardTransport,
  rustProjectActivity,
  rustWaitDetail,
  type RustCommand,
  type RustTask,
} from "../client/web/rust-board";
import { projectActive, PROJECT_ACTIVITY_WINDOW_MS } from "../shared/project-activity";
import { projectSchema } from "../shared/schema/projects";
import { inboxListWidth } from "../shared/inbox-board";
import { generatedProjectBadge, projectBadgeWebStyle } from "../shared/t3/project-badge";

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

test("project activity counts distinct recent tasks and linked planning items", () => {
  const repo = { origin: repository, path: "/fixture" };
  const project = projectSchema.parse({ key: "app", name: "App", repositories: [repo], primary: repo });
  const now = Date.UTC(2026, 10, 24);
  const cutoff = now - PROJECT_ACTIVITY_WINDOW_MS;
  const running = { ...task("one", "working"), latestEventAtMs: cutoff - 1 };
  const done = { ...task("two", "done"), latestEventAtMs: now - 1 };
  const lead = { project: "app", id: "lead", at: new Date(now).toISOString(), taskIds: [] };
  const active = (tasks: RustTask[], leads: Parameters<typeof rustProjectActivity>[2]) =>
    projectActive(rustProjectActivity([project], tasks, leads)[0], now);
  assert.equal(active([running], []), false);
  assert.equal(active([running, done], []), true);
  assert.equal(active([running], [lead]), true);
  assert.equal(active([running], [{ ...lead, taskIds: ["one"] }]), false);
  assert.equal(active([running, done], [{ ...lead, taskIds: ["one", "two"] }]), false);
  assert.equal(active([running, { ...done, latestEventAtMs: cutoff }], []), false);
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
    });
    if (path === "/api/engine/pair" && req.headers.authorization === `Bearer ${key}`) {
      res.writeHead(204, { "set-cookie": "board_session=fixture; HttpOnly; SameSite=Strict" }).end();
      return;
    }
    if (req.headers.cookie !== "board_session=fixture") {
      res.writeHead(401).end();
      return;
    }
    const json = (value: unknown, status = 200) =>
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    if (path === "/api/engine/session") {
      json({ id: "fixture-session", canEditSettings: true, planningProjects: null });
      return;
    }
    if (path === "/api/engine/settings") {
      const snapshot = (value: unknown) => ({ configured: true, revision: "1", value });
      json({
        profiles: snapshot({ profiles: [], pausedGroups: [] }),
        dispatch: snapshot({ usage: "normal", usageUntilMs: null, globalSlots: 4, projectDefaultSlots: 4,
          projectSlotOverrides: {}, providerLimitCooldownSeconds: 300, mode: "running" }),
        projects: { settings: snapshot({ projects: {} }), resolvedPlanners: {} },
        hosts: { settings: snapshot({ t3: null }), active: { endpoint: "", status: "reachable" } },
        storage: { settings: snapshot({ enabled: true, workRoot: null, logRoot: null, scratchRoot: null,
          retention: { keepNewest: 5, maxAgeDays: null } }),
          active: { databaseRoot: "/fixture/db", workRoot: "/fixture/work", backupRoot: "/fixture/backups",
            scratchRoot: "/fixture/scratch", logRoot: "/fixture/logs" } },
      });
      return;
    }
    if (path === "/api/engine/theme") {
      json({ theme: null });
      return;
    }
    if (path === "/api/engine/events") {
      streams.add(res);
      res.on("close", () => streams.delete(res));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: refresh\ndata: {}\n\n");
      return;
    }
    if (path === "/api/engine/tasks") {
      json(rows);
      return;
    }
    const [, , , , id, route] = path.split("/");
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

  const { buildEngineBoard } = await (new Function(
    "return import('../scripts/build-web.mjs')",
  )() as Promise<{ buildEngineBoard(path: string): Promise<void> }>);
  await buildEngineBoard(root);
  const bundle = await readFile(join(root, "app.js"), "utf8");
  assert.ok(!bundle.includes(key));
  assert.doesNotMatch(bundle, /NUCLEUS_BOARD_ENGINE_(KEY|URL)|RustBoardProxy/);

  const origin = `http://127.0.0.1:${engineAddress.port}`;
  const link = `${origin}/#token=${key}`;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: link,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  let cookie = "";
  const fetcher: typeof fetch = async (input, options = {}) => {
    const path = String(input);
    const headers = new Headers(options.headers);
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
  assert.equal(dom.window.document.querySelector('[aria-label^="Step Working:"]'), null);
  await click("#81");
  await eventually(() => text().includes(activity), "initial activity");
  const detail = dom.window.document.querySelector('[aria-label="Task detail"]');
  assert.ok(detail);
  assert.ok(detail.querySelector('[aria-label="Step Working: current · 13m 51s"]'));
  assert.match(text(), /fixture-worker-model/);
  assert.match(text(), /fixture-review-model/);
  assert.ok(detail.querySelector('[aria-label="Step Review: todo · Round 2"]'));
  await eventually(() => text().includes("3m / 1h"), "task allowance");
  const beforeList = reads("/api/engine/tasks");
  const beforeDetail = reads("/api/engine/tasks/running");
  const beforeNext = reads("/api/engine/tasks/running/next");

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
  assert.ok(reads("/api/engine/tasks") > beforeList);
  assert.ok(reads("/api/engine/tasks/running") >= beforeDetail + 2);
  assert.ok(reads("/api/engine/tasks/running/next") >= beforeNext + 2);

  await click("Activity");
  await eventually(
    () => text().includes("Checking round 1"),
    "paged history is visible",
  );
  assert.doesNotMatch(text(), /run ticket material/);
  const beforeReconnect = {
    list: reads("/api/engine/tasks"),
    detail: reads("/api/engine/tasks/running"),
    next: reads("/api/engine/tasks/running/next"),
    history: reads("/api/engine/tasks/running/history?limit=30"),
  };
  for (const stream of streams) stream.end();
  await eventually(
    () =>
      reads("/api/engine/tasks") > beforeReconnect.list &&
      reads("/api/engine/tasks/running") > beforeReconnect.detail &&
      reads("/api/engine/tasks/running/next") > beforeReconnect.next &&
      reads("/api/engine/tasks/running/history?limit=30") > beforeReconnect.history,
    "reconnect refreshes the list and every visible read",
    7000,
  );

  await click("Overview");
  await click("Move, Move");
  await click("Move: Reviewing");
  await eventually(
    () =>
      posts.filter(({ path }) => path === "/api/engine/tasks/running/commands")
        .length === 2,
    "move posted",
  );
  assert.deepEqual(posts[1]?.command, { move: "reviewing" });
  await click("Needs you, 1");
  await click("Blocked task, The worker could not finish. Try again?");
  await click("Answer");
  await eventually(
    () => posts.some(({ path }) => path === "/api/engine/tasks/blocked/commands"),
    "answer posted",
  );
  assert.deepEqual(posts[2]?.command, { answer: "retry" });
  await click("History, 2");
  await eventually(
    () => /Done/.test(text()) && /Cancelled/.test(text()),
    "only the terminal phases are history",
  );

  assert.equal(posts.length, 3);
  authorityCold = true;
  await assert.rejects(
    createRustBoardTransport(fetcher).command("running", { hold: "Fixture" }),
    { message: "planner authority is not yet known. Retry shortly." },
  );
  assert.deepEqual(calls.filter(call => call.authorization).map(call => call.path), ["/api/engine/pair"]);
  assert.ok(calls.filter(({ path }) => path !== "/api/engine/pair")
    .every(({ authorization, cookie }) => !authorization && cookie === "board_session=fixture"));

  // Only a stream event should refresh a settled task.
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
  let workerRunning = false;
  const now = 1_800_000_000_000;
  let clock = now;
  dom.window.Date.now = () => clock;
  let operator = true;
  let pausedGroups = ["fixture team"];
  let usageCount = 49;
  let resetAt: number | undefined;
  let decisionOpen = true;
  let decisionQuestion = "Which route should we take?";
  let itemBody = "Fixture body";
  let reconnectGate: Promise<void> | undefined;
  let answeredOption: string | null = null;
  const decision = () => ({
    id: "fixture-decision", projectId: "fixture", author: "Fixture planner",
    question: decisionQuestion, createdAtMs: now,
    options: [
      { id: "first", label: "Same label" }, { id: "second", label: " Same label " },
      { id: "third", label: "Third" }, { id: "fourth", label: "Fourth" },
    ],
    answer: answeredOption === null ? null : {
      optionId: answeredOption, note: null, author: "Fixture operator", answeredAtMs: now,
    },
  });
  let projectArchived = false;
  let projectRemoved = false;
  let removalWrites = 0;
  const boundRepository = "example/bound-control";
  const boundTitle = "Native Control";
  const longLead = "A lead title long enough to overflow the sidebar and verify that the entire record title is available on hover and in detail";
  const parkReason = "Paused until the dependency ships.";
  const parkedLead = "Parked lead between open leads";
  const parkedCut = "Parked papercut between open papercuts";
  const secondCut = "A second open papercut";
  const leadItem = (id: string, title: string, origin: string) => ({
    id, title, repositories: [origin], kind: "lead", author: "Fixture planner",
    body: itemBody, lanes: [], state: "open",
    createdAtMs: now - 4 * 3_600_000, updatedAtMs: now - 36 * 60_000,
  });
  const papercut = "A papercut title long enough to verify the sidebar ellipsis and the browser’s built-in full-title hover";
  let editableCut = {
    ...leadItem("second-cut", secondCut, boundRepository),
    kind: "papercut",
    version: 11,
    lanes: ["delivery"],
  };
  const papercutWrites: Array<{
    path: string;
    body: { version: number; title: string; body: string; lanes: string[] };
  }> = [];
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
  let closeStream: (() => void) | undefined;
  const snap = (value: unknown, revision: string) => ({ value, revision, configured: true });
  const fixtureProject = () => ({ name: "Fixture project", archived: projectArchived, repositories: [
    { origin: "example/board-fixture", path: "/work/fixture", base: "main", requiredChecks: [], hungToolMinutes: 30 },
    { origin: boundRepository, path: "/work/bound", base: "main", requiredChecks: [], hungToolMinutes: 30,
      hostProject: "fixture-bound", hostProjectTitle: boundTitle },
  ] });
  const scratchOverride = "/custom/run-scratch";
  let activePlacement: "internal" | "barge" = "internal";
  const githubPath = "/settings/github-accounts";
  const reviewer = { host: "github.com", userId: "27", login: "fixture-reviewer" };
  const reviewerId = "github.com:27";
  const githubCalls: Array<{ method: string; route: string; body?: unknown }> = [];
  let githubSettings = {
    revision: "github-1",
    accounts: [] as Array<typeof reviewer & { presence: "present" | "missing" | "unavailable" }>,
    reviewerAccountId: null as string | null,
    workerAccountId: null as string | null,
    canSignIn: false,
    canImportReviewer: false,
  };
  let githubFlow: "starting" | "waiting" | "confirm" | "failed" = "starting";
  let githubFlowCount = 0;
  let invalidGitHubResponse = false;
  const githubFlowView = () => {
    const id = `fixture-flow-${githubFlowCount}`;
    switch (githubFlow) {
      case "starting": return { id, status: githubFlow };
      case "waiting": return { id, status: githubFlow, verificationUri: "https://github.com/login/device",
        userCode: "ABCD-EFGH", expiresAtMs: now + 60_000 };
      case "confirm": return { id, status: githubFlow, account: reviewer };
      case "failed": return { id, status: githubFlow, message: "GitHub sign-in expired. Start again." };
    }
  };
  let storage: ReturnType<typeof storageView.parse>["settings"]["value"] = {
    enabled: true,
    placement: "internal",
    workRoot: null,
    scratchRoot: scratchOverride,
    buildsRoot: null,
    logRoot: null,
    retention: { keepNewest: 5, maxAgeDays: null },
  };
  const views = {
    profiles: () => snap({
      profiles: [{
        name: "Fixture worker", group: "fixture team",
        selection: { id: "fixture-worker", provider: "codex", model: "m", effort: "high", capability: "worker", weight: "default" },
      }],
      pausedGroups,
    }, "profiles-1"),
    dispatch: () => snap(dispatch, "dispatch-" + dispatch.globalSlots),
    projects: () => ({
      settings: snap({ projects: projectRemoved ? {} : { fixture: fixtureProject() } },
        projectRemoved ? "projects-removed" : "projects-1"),
      resolvedPlanners: { fixture: "fixture-planner" },
    }),
    hosts: () => ({ settings: snap({ t3: null }, "hosts-1"), active: { endpoint: "http://127.0.0.1:3773/", status: "reachable" } }),
    storage: () => {
      const barge = activePlacement === "barge";
      return {
        settings: snap(storage, "storage-" + storage.placement),
        active: {
          home: "/e",
          placement: activePlacement,
          databaseRoot: "/e/db",
          workRoot: barge ? "/pool/worktrees/nucleus" : "/e/work",
          buildsRoot: barge ? "/pool/builds/nucleus" : "/e/builds",
          scratchRoot: scratchOverride,
          backupRoot: "/e/backups",
          logRoot: "/e/logs",
          ...(barge ? {
            bargePaths: {
              worktrees: "/pool/worktrees/nucleus",
              builds: "/pool/builds/nucleus",
            },
          } : {}),
        },
        backups: { complete: true, issues: 0, verified: [] },
      };
    },
  };
  let hostThemeAvailable = true;
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
      await reconnectGate;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          let closed = false;
          closeStream = () => {
            if (closed) return;
            closed = true;
            controller.close();
          };
          init?.signal?.addEventListener("abort", closeStream, { once: true });
          controller.enqueue(new TextEncoder().encode("event: refresh\ndata: {}\n\n"));
        },
      });
        return new Response(body);
    }
    if (path === "/api/engine/session")
      return Response.json({
        id: operator ? "operator-session" : "planner-session",
        canEditSettings: operator,
        planningProjects: operator ? null : ["fixture"],
      });
    if (path === "/api/engine/theme") return Response.json({
      theme: hostThemeAvailable ? {
        settings: { defaultTheme: "t3-code", defaultAppearance: "dark" },
        theme: { id: "t3-code", appearance: "dark", colors: {
          text: "#f5f5f5", textMuted: "#a3a3a3", secondaryLabel: "#818181", sidebar: "#000000",
          surfaceRaised: "#111111", sidebarRowHover: "#111111", sidebarRowSelected: "#111111",
        } },
      } : null,
    });
    if (path === "/api/engine/profiles/usage") {
      const empty = { counts: {}, groups: {}, sample: 0 };
      const counts = { "fixture-worker": usageCount };
      const groups = { "fixture team": usageCount };
      const recorded = { counts, groups, sample: Math.min(50, usageCount) };
      return Response.json({
        recent: recorded, worker: recorded, reviewer: empty,
        totals: counts, groupTotals: groups,
        limitedGroups: resetAt ? { "fixture team": resetAt } : {},
      });
    }
    if (path === "/api/engine/profiles/catalog")
      return Response.json({ providers: null, readAtMs: null, status: "pending" });
    if (path.startsWith("/api/engine/tasks")) {
      const card = {
        ...task("board-task", taskPhase, "board-fixture#80"),
        number: 80,
        title: "Standalone task",
        stateLabel: taskPhase === "queued" ? "Waiting for capacity" : workerRunning ? "Working" : "Working*",
        stateSinceMs: taskPhase === "queued" ? null : now - 12 * 60_000,
        latestEventAtMs: now - 4 * 60_000,
        wait: taskPhase === "queued" ? "capacity" : workerRunning ? "running" : "hold",
        hold: taskPhase === "queued" || workerRunning ? null : { reason: "Wait before dispatching again." },
      };
      if (taskPhase === "working") {
        card.lifecycle.steps = card.lifecycle.steps.map((step) => {
          if (step.key === "working") return { ...step, activeSinceMs: now };
          if (step.key === "review") return { ...step, elapsedMs: 430_000 };
          return step;
        });
      }
      if (path === "/api/engine/tasks/board-task") {
        return Response.json({
          ...card, createdAtMs: now, brief: { text: "Fixture brief", version: 1 },
          pullRequest: null, verdict: null, run: null,
        });
      }
      if (path === "/api/engine/tasks/board-task/next")
        return Response.json({ ...card, commands: [] });
      assert.equal(path, "/api/engine/tasks");
      return Response.json([card, held]);
    }
    if (path === "/api/engine/settings/projects/fixture/removal") {
      assert.ok(operator);
      const project = fixtureProject();
      if (init?.method !== "POST") {
        return Response.json({ project, digest: "confirmed-project-revision", tasks: [] });
      }
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body, { digest: "confirmed-project-revision", reason: "Fixture retired" });
      removalWrites += 1;
      projectRemoved = true;
      return Response.json({
        repositories: project.repositories.map(({ origin, path }) => ({ origin, path })),
        removedAtMs: now,
      });
    }
    if (path.startsWith("/api/engine" + githubPath)) {
      assert.ok(operator, "planner sessions make no GitHub settings requests");
      const route = path.slice(("/api/engine" + githubPath).length);
      const method = init?.method ?? "GET";
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      githubCalls.push({ method, route, body });
      if (method === "GET" && route === "")
        return Response.json(invalidGitHubResponse
          ? { ...githubSettings, refreshToken: "fixture-unexpected-secret" }
          : githubSettings);
      if (method === "POST" && route === "/sign-in") {
        assert.deepEqual(body, {});
        githubFlowCount += 1;
        githubFlow = "starting";
        return Response.json(githubFlowView());
      }
      if (method === "POST" && route === "/import-reviewer") {
        assert.deepEqual(body, { organization: "fixture-org" });
        githubFlowCount += 1;
        githubFlow = "confirm";
        return Response.json(githubFlowView());
      }
      if (method === "PUT" && route === "/reviewer") {
        const next = githubSettings.reviewerAccountId === null ? reviewerId : null;
        assert.deepEqual(body, { revision: githubSettings.revision, accountId: next });
        githubSettings = { ...githubSettings, revision: githubSettings.revision + "-changed", reviewerAccountId: next };
        return Response.json(githubSettings);
      }
      if (method === "POST" && route === "/accounts/github.com%3A27/sign-out") {
        assert.deepEqual(body, { revision: githubSettings.revision });
        assert.equal(githubSettings.workerAccountId, null);
        githubSettings = { ...githubSettings, revision: githubSettings.revision + "-signed-out",
          accounts: [], reviewerAccountId: null };
        return Response.json(githubSettings);
      }
      if (method === "GET" && route === `/flows/fixture-flow-${githubFlowCount}`)
        return Response.json(githubFlowView());
      if (method === "DELETE" && route === `/flows/fixture-flow-${githubFlowCount}`) {
        assert.equal(body, undefined);
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && route === `/flows/fixture-flow-${githubFlowCount}/confirm`) {
        assert.deepEqual(body, { revision: githubSettings.revision });
        githubSettings = { ...githubSettings, revision: githubSettings.revision + "-confirmed",
          accounts: [{ ...reviewer, presence: "present" }], reviewerAccountId: reviewerId };
        return Response.json(githubSettings);
      }
      assert.fail("Unexpected GitHub settings request " + method + " " + route);
    }
    if (path === "/api/engine/settings")
      return Response.json(Object.fromEntries(Object.entries(views).map(([key, view]) => [key, view()])));
    const domain = /^\/api\/engine\/settings\/(\w+)$/.exec(path)?.[1] as keyof typeof views | undefined;
    if (domain) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        writes.push({ path, body });
        if (domain === "dispatch") dispatch = body.value;
        if (domain === "storage") storage = body.value;
        if (domain === "profiles") pausedGroups = body.value.pausedGroups;
        if (domain === "projects") projectArchived = body.value.projects.fixture.archived;
        stream?.enqueue(new TextEncoder().encode("event: settings\ndata: {}\n\n"));
      }
      return Response.json(views[domain]());
    }
    if (path === "/api/engine/planning/fixture/plan")
      return Response.json({
        version: 1, idle: false,
        lanes: [{ key: "delivery", horizon: "now", doneWhen: "", statusNote: "In progress" }],
        documents: [{ key: "delivery", version: 1, title: "Delivery", aim: "Ship the fixture", document: "", status: "open" }],
      });
    if (path === "/api/engine/planning/fixture/items") return Response.json([
      leadItem("unbound", longLead, "example/board-fixture"),
      { ...leadItem("parked-lead", parkedLead, boundRepository), state: "parked", reason: parkReason },
      leadItem("bound", "Lead with a saved T3 title", boundRepository),
      { ...leadItem("mixed", "Lead spanning mixed bindings", boundRepository), repositories: [boundRepository, "example/board-fixture"] },
      { ...leadItem("cut", papercut, "example/board-fixture"), kind: "papercut", updatedAtMs: null, version: 22 },
      { ...leadItem("parked-cut", parkedCut, boundRepository), kind: "papercut", state: "parked", reason: parkReason, version: 21 },
      editableCut,
    ]);
    if (init?.method === "PUT" && path.startsWith("/api/engine/planning/fixture/items/")) {
      const body = JSON.parse(String(init.body));
      papercutWrites.push({ path, body });
      assert.equal(path, "/api/engine/planning/fixture/items/second-cut");
      assert.equal(body.version, editableCut.version);
      editableCut = { ...editableCut, ...body, version: body.version + 1, updatedAtMs: now };
      return Response.json(editableCut);
    }
    if (path === "/api/engine/planning/fixture/decisions")
      return Response.json(decisionOpen ? [decision()] : []);
    if (path === "/api/engine/planning/fixture/decisions/fixture-decision/answer") {
      assert.equal(init?.method, "POST");
      const answer = JSON.parse(String(init.body)) as { optionId: string; note: string | null };
      assert.deepEqual(answer, { optionId: "second", note: null });
      answeredOption = answer.optionId;
      return Response.json(decision());
    }
    assert.fail("Unexpected standalone route " + path);
  };
  const systemTheme = Object.assign(new dom.window.EventTarget(), { matches: true });
  Object.assign(dom.window, {
    innerWidth: 1280,
    matchMedia: () => systemTheme,
    fetch: fetcher,
    TextDecoder,
    TextEncoder,
    AbortController,
  });
  // The fixture uses literal hex colours. JSDOM has no canvas implementation.
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    value: () => ({ fillStyle: "" }),
  });
  const selector = (label: string) =>
    dom.window.document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  const click = async (label: string) => {
    await eventually(() => Boolean(selector(label)), "visible control: " + label);
    selector(label)?.click();
  };
  const text = () => dom.window.document.body.textContent ?? "";
  const count = (route: string) => requests.filter((path) => path === "/api/engine" + route).length;
  const emit = (event: string, value: object = {}) => stream!.enqueue(
    new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`),
  );
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  dom.window.eval(`(() => { ${script} })()`);
  const planningReads = () => requests.filter((path) => path.startsWith("/api/engine/planning/"));
  const menuCounts = ["Planning, 1 open lanes", "Leads, 3", "Papercuts, 2", "Needs you, 1"];
  await eventually(() => menuCounts.every((label) => Boolean(selector(label))),
    "planning and decision counts settle before any navigation");
  assert.ok(stream, "the board subscribed to engine changes");
  const initialPlanningReads = ["decisions", "items", "plan"].map((key) => `/api/engine/planning/fixture/${key}`);
  assert.deepEqual(planningReads().sort(), initialPlanningReads, "one store read per collection in scope");
  const taskReads = () => count("/tasks");
  // Let the startup resync settle before observing the steady-state window.
  await wait(150);
  const routes = ["/tasks", "/profiles/usage", "/settings", "/settings/storage"];
  const beforeIdle = routes.map(count);
  assert.deepEqual(beforeIdle, [1, 0, 1, 0], "entry reads the task list and board settings once");
  for (let i = 0; i < 5; i++) {
    emit("invalidate", { taskId: "board-task", version: 8, detailOnly: true });
    await wait(1000);
  }
  const idleReads = routes.map((route, i) => count(route) - beforeIdle[i]!);
  t.diagnostic("5s idle with detail events: " + JSON.stringify(Object.fromEntries(
    routes.map((route, i) => [route, idleReads[i]]),
  )));
  assert.deepEqual(idleReads, [0, 0, 0, 0]);
  assert.deepEqual(planningReads().sort(), initialPlanningReads, "idle and task activity make no collection reads");
  // The shared navigation, header and project filter render from the Rust data.
  await click("Queue, 2");
  decisionOpen = false;
  emit("decisions");
  await eventually(() => Boolean(selector("Needs you, 0")), "a decision change updates the menu outside Needs you");
  assert.deepEqual(planningReads().slice(3), [initialPlanningReads[0]]);
  emit("planning");
  await eventually(() => planningReads().length >= 6, "a planning change refreshes plans and items");
  assert.deepEqual(planningReads().slice(4).sort(), initialPlanningReads.slice(1));
  await eventually(() => text().includes("Standalone task"), "task title renders");
  const header = (card: HTMLElement, state: string, age: string) => {
    const ageText = [...card.querySelectorAll("div")].find(
      (node) => node.childElementCount === 0 && node.textContent === age,
    );
    assert.ok(ageText?.parentElement, age);
    assert.equal(ageText.parentElement.lastElementChild, ageText);
    assert.ok(!ageText.parentElement.textContent?.includes(state));
    return ageText.parentElement;
  };
  const heldCard = selector("#81, Held task")!;
  assert.ok(heldCard, "the production list renders the numbered card");
  const heldHeader = header(heldCard, "Held by planner", "3h ago");
  assert.match(heldHeader.textContent ?? "", /^#81/);
  assert.doesNotMatch(heldHeader.textContent ?? "", /Held task|schema review/);
  assert.match(heldCard.textContent ?? "", /Held taskHeld by planner$/);
  assert.equal(heldCard.querySelector('[title="Wait for the schema review. Then continue with the API."]')?.textContent, "Held by planner");
  assert.doesNotMatch(heldCard.textContent ?? "", /Then continue|Queued|On hold/);
  const capacityCard = selector("#80, Standalone task")!;
  header(capacityCard, "Waiting for capacity", "4m ago");
  assert.doesNotMatch(capacityCard.textContent ?? "", /Queued|work slot/);
  assert.ok(selector("Queue controls menu"), "the shared pause split button renders");
  assert.ok(text().includes("All projects"), "the shared project filter renders");
  taskPhase = "working";
  const beforeTransition = routes.map(count);
  emit("invalidate", { taskId: "board-task", version: 9 });
  await click("Working, 1");
  await eventually(() => Boolean(selector("#80, Standalone task")), "working view renders");
  const workingCard = selector("#80, Standalone task")!;
  const workingHeader = header(workingCard, "Working*", "12m ago");
  const title = [...workingCard.querySelectorAll("div")].find(
    (node) => node.childElementCount === 0 && node.textContent === "Standalone task",
  );
  assert.ok(title);
  const style = (element: Element) => dom.window.getComputedStyle(element);
  assert.equal(style(title).fontWeight, "400");
  // T3's standard sidebar uses text-foreground/75 here, text-foreground on
  // the open row, and text-secondary-label on metadata (nightly 20261124.5191).
  assert.equal(style(title).color, "rgba(245, 245, 245, 0.75)");
  assert.equal(title.getAttribute("title"), "Standalone task");
  assert.equal(style(title).whiteSpace, "nowrap");
  assert.equal(style(title).textOverflow, "ellipsis");
  for (const label of ["#80", "Fixture project", "12m ago"]) {
    const node = [...workingHeader.querySelectorAll("div")].find((item) => item.textContent === label);
    assert.ok(node, label);
    assert.equal(style(node).color, "rgb(129, 129, 129)");
  }
  const statusLine = title.nextElementSibling?.querySelector('[title="Wait before dispatching again."]');
  assert.equal(statusLine?.textContent, "Working*");
  assert.equal(style(statusLine!.lastElementChild!).color, "rgb(129, 129, 129)");
  assert.doesNotMatch(workingCard.textContent ?? "", /On hold/);
  assert.deepEqual(routes.map((route, i) => count(route) - beforeTransition[i]!), [1, 0, 0, 0]);
  const cardStrip = workingCard.parentElement?.querySelector('[role="img"][aria-label^="Progress:"]');
  assert.ok(cardStrip, "the card has an accessible progress strip");
  assert.ok(
    workingCard.compareDocumentPosition(cardStrip) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "the strip follows the compact card body",
  );
  assert.ok(workingCard.parentElement?.lastElementChild?.contains(cardStrip), "the strip is at the bottom of the card");
  assert.equal(cardStrip.children.length, 5, "one bar per code task step");
  assert.equal(cardStrip.textContent, "", "card bars have no visible text");
  assert.match(cardStrip.getAttribute("aria-label") ?? "", /Working \(current, 13m 51s\).*Review \(todo, Round 2 · 7m 10s\)/);
  const footer = cardStrip.parentElement!;
  const body = workingCard.firstElementChild!;
  const tile = body.firstElementChild!;
  const leftPadding = (element: Element) => Number.parseFloat(style(element).paddingLeft) || 0;
  assert.equal(leftPadding(footer), leftPadding(workingCard) + Number.parseFloat(style(tile).width) + Number.parseFloat(style(body).gap));
  assert.equal(Number.parseFloat(style(footer).paddingRight) || 0, Number.parseFloat(style(workingCard).paddingRight) || 0);
  for (const segment of cardStrip.children)
    assert.equal(style(segment.firstElementChild!).height, "2px");

  const tooltip = () => dom.window.document.querySelector('[role="tooltip"]');
  for (const [index, text] of [[1, "Working · 13m 51s"], [2, "Review · round 2 · 7m 10s"], [3, "Merge · not started"]] as const) {
    const segment = cardStrip.children[index]!;
    segment.dispatchEvent(new dom.window.PointerEvent("pointerenter", { pointerType: "mouse" }));
    await eventually(() => tooltip()?.textContent === text, "hover shows " + text);
    segment.dispatchEvent(new dom.window.PointerEvent("pointerleave", { pointerType: "mouse" }));
    await eventually(() => !tooltip(), "leaving the segment dismisses the tooltip");
  }

  await click("#80, Standalone task");
  const detailProgress = () => selector("Task detail")?.querySelector('[aria-label^="Progress:"]');
  await eventually(() => Boolean(detailProgress()?.textContent?.includes("13m 51s")),
    "the selected task displays its run duration in the timeline");
  const fullStrip = detailProgress()!;
  assert.equal(style(title).fontWeight, "400");
  assert.equal(style(title).color, "rgb(245, 245, 245)");
  const taskHeading = selector("Task detail")?.querySelector('[role="heading"]');
  assert.match(taskHeading?.textContent ?? "", /board-fixture#80 · Standalone task/);
  assert.notEqual(style(taskHeading!).whiteSpace, "nowrap");
  assert.match(selector("Task detail")?.textContent ?? "", /Wait before dispatching again\./);
  assert.match(fullStrip.textContent ?? "", /Queued.*Working.*13m 51s.*Review.*Round 2.*Merge.*Close/);
  const colours = (strip: Element) => Array.from(strip.children, (step) => {
    assert.ok(step.firstElementChild);
    return dom.window.getComputedStyle(step.firstElementChild).backgroundColor;
  });
  assert.equal(new Set(colours(cardStrip)).size, 3, "done, current and future bars have different colours");
  assert.deepEqual(colours(cardStrip), colours(fullStrip), "card and detail use the same step colours");
  const beforeClock = requests.length;
  clock += 2000;
  await eventually(() => text().includes("13m 53s"), "run duration ticks locally");
  assert.equal(requests.length, beforeClock);

  const beforeDetail = routes.map(count);
  const detailReads = count("/tasks/board-task");
  emit("invalidate", { taskId: "board-task", version: 9, detailOnly: true });
  await eventually(() => count("/tasks/board-task") === detailReads + 1, "detail changes refresh the open task");
  assert.deepEqual(routes.map((route, i) => count(route) - beforeDetail[i]!), [0, 0, 0, 0]);
  workerRunning = true;
  emit("invalidate", { taskId: "board-task", version: 10 });
  await eventually(() => Boolean(selector("#80, Standalone task")?.textContent?.endsWith("Standalone taskWorking")),
    "the task list shows the running worker");
  const beforePause = taskReads();
  dispatch = { ...dispatch, mode: "paused" };
  emit("settings");
  await eventually(() => Boolean(selector("Draining · 1 active · 0 unconfirmed")), "the paused header keeps the live worker count");
  assert.equal(taskReads(), beforePause, "pausing reuses the loaded task list");
  dispatch = { ...dispatch, mode: "running" };
  emit("settings");
  await eventually(() => !selector("Draining · 1 active · 0 unconfirmed"), "resuming clears the draining pill");

  const beforeLeads = planningReads().length;
  await click("Leads, 3");
  await eventually(() => Boolean(selector(`Lead: ${longLead}, Status: Unchecked · awaiting a check`)),
    "the Leads view uses the loaded items");
  assert.equal(planningReads().length, beforeLeads, "opening Leads makes no collection reads");
  const triageTitles = (view: string, kind: string) => {
    const list = selector(view + " list");
    assert.ok(list);
    return [...list.querySelectorAll(`[role="button"][aria-label^="${kind}: "]`)]
      .map((card) => card.querySelector("[title]")?.getAttribute("title"));
  };
  const expectParked = (kind: string, title: string, openLabel: string) => {
    const parked = selector(`${kind}: ${title}, Status: Parked · ${parkReason}`);
    const open = selector(openLabel);
    assert.ok(parked && open);
    const body = parked.firstElementChild!;
    assert.equal(style(body).filter, "grayscale(1)");
    assert.equal(style(body).opacity, "0.75");
    assert.notEqual(style(open.firstElementChild!).filter, "grayscale(1)");
    assert.equal(parked.querySelector(`[title="${parkReason}"]`)?.textContent, "Parked");
    assert.doesNotMatch(parked.textContent ?? "", /Paused until/);
  };
  const filterState = async (name: string, from: string, to: string) => {
    await click(`Filter ${name} by state, ${from}`);
    await click(`Filter ${name} by state: ${to}`);
  };
  const expectLeadBadge = (title: string, badgeTitle: string) => {
    const card = selector(`Lead: ${title}, Status: Unchecked · awaiting a check`);
    assert.ok(card, title);
    const badge = generatedProjectBadge(badgeTitle);
    const mark = [...card.querySelectorAll("div")].find((node) => node.textContent === badge.monogram);
    assert.ok(mark, `badge for ${badgeTitle}`);
    assert.equal(style(mark).color, projectBadgeWebStyle(badge, true).color);
    const text = card.querySelector(`[title="${title}"]`);
    assert.ok(text, "full native title");
    assert.equal(style(text).whiteSpace, "nowrap");
    assert.equal(style(text).textOverflow, "ellipsis");
    header(card, "Unchecked", "36m ago");
    assert.equal(card.querySelector('[title="awaiting a check"]')?.textContent, "Unchecked");
  };
  expectLeadBadge(longLead, "Fixture project");
  expectLeadBadge("Lead with a saved T3 title", boundTitle);
  expectLeadBadge("Lead spanning mixed bindings", "Fixture project");
  const leadOrder = triageTitles("Leads", "Lead");
  assert.deepEqual(leadOrder.slice(0, 3), [longLead, parkedLead, "Lead with a saved T3 title"]);
  expectParked("Lead", parkedLead, `Lead: ${longLead}, Status: Unchecked · awaiting a check`);
  const beforeFilters = planningReads().length;
  await filterState("leads", "All", "Open");
  await eventually(() => !triageTitles("Leads", "Lead").includes(parkedLead), "open leads exclude parked");
  assert.deepEqual(triageTitles("Leads", "Lead"), leadOrder.filter((name) => name !== parkedLead));
  await filterState("leads", "Open", "Parked");
  await eventually(() => triageTitles("Leads", "Lead").length === 1, "parked leads filter settles");
  assert.deepEqual(triageTitles("Leads", "Lead"), [parkedLead]);
  await filterState("leads", "Parked", "All");
  await eventually(() => triageTitles("Leads", "Lead").length === leadOrder.length, "all leads restored");
  assert.equal(planningReads().length, beforeFilters, "state filters do not read the API");
  await click(`Lead: ${parkedLead}, Status: Parked · ${parkReason}`);
  await eventually(() => selector("Parked lead")?.textContent?.includes(parkReason) ?? false,
    "the parked lead detail shows the reason");
  await click(`Lead: ${longLead}, Status: Unchecked · awaiting a check`);
  await eventually(() => selector("Lead detail")?.querySelector('[role="heading"]')?.textContent === longLead,
    "the entire lead title is shown in detail");
  const leadHeading = selector("Lead detail")!.querySelector('[role="heading"]')!;
  assert.notEqual(style(leadHeading).whiteSpace, "nowrap");
  assert.equal(style(leadHeading).getPropertyValue("-webkit-line-clamp"), "");
  await click("Papercuts, 2");
  await eventually(() => triageTitles("Papercuts", "Papercut").length === 3, "all papercuts shown");
  assert.deepEqual(triageTitles("Papercuts", "Papercut"), [papercut, parkedCut, secondCut]);
  expectParked("Papercut", parkedCut, `Papercut: ${papercut}, Status: Open`);
  await filterState("papercuts", "All", "Parked");
  await eventually(() => triageTitles("Papercuts", "Papercut").length === 1, "parked papercuts filter settles");
  assert.deepEqual(triageTitles("Papercuts", "Papercut"), [parkedCut]);
  await filterState("papercuts", "Parked", "Open");
  await eventually(() => triageTitles("Papercuts", "Papercut").length === 2, "open papercuts filter settles");
  assert.deepEqual(triageTitles("Papercuts", "Papercut"), [papercut, secondCut]);
  const cutCard = selector(`Papercut: ${papercut}, Status: Open`);
  assert.ok(cutCard);
  header(cutCard, "Open", "4h ago");
  const cutTitle = cutCard.querySelector(`[title="${papercut}"]`);
  assert.ok(cutTitle);
  assert.equal(style(cutTitle).textOverflow, "ellipsis");
  await click(`Papercut: ${secondCut}, Status: Open`);
  await click("Edit");
  const editField = (label: string, value: string) => {
    const field = selector(label) as HTMLInputElement | HTMLTextAreaElement;
    const prototype = field instanceof dom.window.HTMLTextAreaElement
      ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    return field;
  };
  const editedTitle = "Revised papercut";
  const editedBody = "    first line is an indented code block\n";
  assert.ok(!selector("Impact"), "the Rust editor has title and Markdown body fields");
  editField("Title", editedTitle);
  editField("What happened", editedBody);
  await click("Save changes");
  await eventually(() => text().includes("Saved version 12"), "uses the saved Rust item version");
  assert.deepEqual(papercutWrites, [{
    path: "/api/engine/planning/fixture/items/second-cut",
    body: { version: 11, title: editedTitle, body: editedBody, lanes: ["delivery"] },
  }]);
  await eventually(() => Boolean(selector(`Papercut: ${editedTitle}, Status: Open`)), "list shows the saved title");
  await click("Edit");
  const draft = "Keep my draft after a conflict";
  const draftField = editField("What happened", draft);
  editableCut = { ...editableCut, title: "Concurrent papercut title", version: 13 };
  emit("planning");
  await eventually(() => Boolean(selector("Papercut detail")?.textContent?.includes(editableCut.title)), "detail refreshes during editing");
  await click("Save changes");
  await eventually(() => text().includes("The papercut changed since you started editing."), "refuses the version that opened the form");
  assert.equal(draftField.value, draft);
  assert.equal(papercutWrites.length, 1, "a stale draft writes neither item");
  await click("Working, 1");

  // Dispatch hold writes the Rust Dispatch mode through Settings.
  await click("Queue controls menu");
  await click("Dispatch hold");
  await eventually(() => writes.length === 1, "the hold is written to the Dispatch domain");
  assert.equal(writes[0]!.path, "/api/engine/settings/dispatch");
  assert.equal(writes[0]!.body.value.mode, "held");
  const beforeSettings = planningReads().length;
  await click("Settings");
  assert.equal(dom.window.location.pathname, "/settings");
  await eventually(() => text().includes("Usage level"), "the shared Limits section renders");
  const settings = selector("Standalone Nucleus settings");
  const back = selector("Back to board");
  assert.ok(settings && back);
  assert.equal(back.getAttribute("role"), "button");
  assert.equal(back.tabIndex, 0);
  assert.equal(style(settings).paddingLeft, "24px");
  hostThemeAvailable = false;
  emit("theme");
  await eventually(() => style(back).backgroundColor === "rgb(37, 41, 50)",
    "Settings uses the dark system palette when the host has no theme");
  systemTheme.matches = false;
  systemTheme.dispatchEvent(new dom.window.Event("change"));
  await eventually(() => style(back).backgroundColor === "rgb(231, 235, 240)",
    "open Settings follows a system appearance change");
  hostThemeAvailable = true;
  emit("theme");
  assert.doesNotMatch(text(), /Concurrent host calls|Advanced limits/);
  assert.ok(!text().includes("Telemetry"), "retired sections stay hidden");
  await click("Storage");
  await eventually(() => Boolean(selector("Placement, Internal")), "Storage shows Internal placement");
  const pathField = (label: string) => {
    const inputs = dom.window.document.querySelectorAll<HTMLInputElement>(`input[aria-label="${label}"]`);
    assert.equal(inputs.length, 1, label + " has one path control");
    return inputs[0]!;
  };
  assert.match(selector("Placement in force")!.textContent!, /^In force: Internal ·/);
  assert.equal(pathField("Worktrees").placeholder, "/e/work");
  assert.equal(pathField("Build output").placeholder, "/e/builds");
  await eventually(() => pathField("Run scratch").value === scratchOverride, "the saved scratch override is restored");
  assert.ok(!selector("Storage help text"), "the explanation opens from the help control");
  await click("Storage help");
  const storageHelp = () => selector("Storage help text")?.textContent ?? "";
  await eventually(() => storageHelp().includes("With Barge, each default comes from its storage class."), "Storage help opens in the bundle");
  assert.match(storageHelp(), /defaults for worktrees, scratch and build output/);
  assert.match(storageHelp(), /Internal uses the platform defaults/);
  assert.match(storageHelp(), /absolute path to override a default/);
  assert.match(storageHelp(), /clears individual path overrides and keeps Worktrees/);
  await click("Storage help");
  await click("Placement, Internal");
  await click("Placement: Barge");
  await eventually(() => Boolean(selector("Placement, Barge")), "Storage shows the saved Barge placement");
  assert.match(selector("Placement in force")!.textContent!, /^In force: Internal ·/);
  const storageWrite = writes.find(({ path }) => path.endsWith("/settings/storage"));
  assert.equal(storageWrite?.body.value.placement, "barge");
  assert.equal(storageWrite?.body.value.scratchRoot, scratchOverride);
  activePlacement = "barge";
  emit("storage");
  await eventually(() => selector("Placement in force")?.textContent?.startsWith("In force: Barge ·") === true,
    "the board refreshes the active placement");
  assert.equal(pathField("Worktrees").placeholder, "/pool/worktrees/nucleus");
  assert.equal(pathField("Build output").placeholder, "/pool/builds/nucleus");
  assert.equal(pathField("Run scratch").placeholder, scratchOverride);
  assert.equal(pathField("Run scratch").value, scratchOverride);
  t.diagnostic("Storage help covered Internal defaults, saved and active Barge placement, and the retained scratch override.");

  assert.equal(githubCalls.length, 0, "GitHub account status is read only when its settings open");
  await click("GitHub");
  await eventually(() => Boolean(selector("Reviewer, Installed gh")), "the default reviewer uses Installed gh");
  assert.match(text(), /GitHub sign-in is unavailable/);
  assert.equal(selector("Sign in"), null);
  assert.equal(selector("Import existing reviewer"), null);

  const refreshGitHub = async () => {
    await click("Storage");
    await click("GitHub");
  };
  githubSettings = { ...githubSettings, canSignIn: true, canImportReviewer: true };
  await refreshGitHub();
  await click("Sign in");
  await eventually(() => text().includes("Starting GitHub sign-in"), "sign-in shows progress before the code arrives");
  githubFlow = "waiting";
  await eventually(() => selector("GitHub device code")?.textContent === "ABCD-EFGH", "the device code arrives");
  const verificationLink = dom.window.document.querySelector<HTMLAnchorElement>('a[href="https://github.com/login/device"]');
  assert.equal(verificationLink?.target, "_blank");
  assert.equal(verificationLink?.rel, "noreferrer");
  assert.match(text(), /Expires at/);
  await click("Cancel");
  await eventually(() => !selector("GitHub device code") && Boolean(selector("Sign in")), "cancellation clears the code");
  assert.equal(githubCalls.filter(({ method }) => method === "DELETE").length, 1);
  assert.equal(githubSettings.reviewerAccountId, null);

  await click("Sign in");
  await eventually(() => githubFlowCount === 2, "the second sign-in starts");
  githubFlow = "failed";
  await eventually(() => text().includes("GitHub sign-in expired."), "expired sign-in is actionable");
  assert.equal(selector("GitHub device code"), null);
  await click("Dismiss");

  await click("Sign in");
  await eventually(() => githubFlowCount === 3, "the third sign-in starts");
  githubFlow = "confirm";
  await eventually(() => text().includes("Use @fixture-reviewer for reviews?"), "confirmation names the verified account");
  assert.equal(githubSettings.reviewerAccountId, null, "sign-in does not select until confirmed");
  await click("Use account");
  await eventually(() => Boolean(selector("Reviewer, @fixture-reviewer, Saved sign-in")), "confirmed reviewer is connected");
  assert.equal(githubSettings.reviewerAccountId, reviewerId);
  await click("Reviewer, @fixture-reviewer, Saved sign-in");
  await click("Reviewer: Installed gh");
  await eventually(() => Boolean(selector("Reviewer, Installed gh")), "Installed gh unlinks reviewer selection");
  assert.equal(githubSettings.accounts.length, 1, "unlink keeps the saved account");

  githubSettings = { ...githubSettings, accounts: [{ ...reviewer, presence: "missing" }] };
  await refreshGitHub();
  await click("Reviewer, Installed gh");
  await click("Reviewer: @fixture-reviewer, Sign-in required");
  await eventually(() => Boolean(selector("Reconnect")), "missing credentials offer reconnect for the selected reviewer");
  await click("Reconnect");
  await eventually(() => githubFlowCount === 4, "reconnect starts a new sign-in");
  await click("Cancel");
  await eventually(() => Boolean(selector("Import existing reviewer")), "cancel returns to accounts");

  githubSettings = { ...githubSettings, accounts: [{ ...reviewer, presence: "unavailable" }] };
  await refreshGitHub();
  await eventually(() => Boolean(selector("Reviewer, @fixture-reviewer, Account storage unavailable")),
    "an unavailable grant keeps its selected reviewer visible");
  assert.ok(selector("Reconnect"), "unavailable credentials offer an explicit reconnect");
  assert.equal(selector("Reviewer, Installed gh"), null, "unavailable credentials never select Installed gh");

  await click("Import existing reviewer");
  await eventually(() => Boolean(selector("Organization")), "legacy import asks for an organization");
  assert.equal(githubCalls.filter(({ route }) => route === "/import-reviewer").length, 0,
    "opening the import form does not look up a legacy item");
  const organization = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Organization"]');
  assert.ok(organization);
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set?.call(organization, "fixture-org");
  organization.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await eventually(() => selector("Look up reviewer")?.getAttribute("aria-disabled") !== "true", "organization enables lookup");
  await click("Look up reviewer");
  await eventually(() => text().includes("Use @fixture-reviewer for reviews?"), "legacy import shows the verified login before saving");
  await click("Use account");
  await eventually(() => Boolean(selector("Reviewer, @fixture-reviewer, Saved sign-in")), "confirmed import reconnects the reviewer");
  assert.ok(githubCalls.every(({ body }) => !JSON.stringify(body)?.includes("fixture-unexpected-secret")));

  invalidGitHubResponse = true;
  await refreshGitHub();
  await eventually(() => text().includes("The task engine returned an invalid response."), "the browser rejects a response outside the public shape");
  assert.ok(!text().includes("fixture-unexpected-secret"));
  assert.equal(selector("Reviewer, @fixture-reviewer, Saved sign-in"), null);
  invalidGitHubResponse = false;
  await click("Retry GitHub accounts");
  await eventually(() => Boolean(selector("Reviewer, @fixture-reviewer, Saved sign-in")), "the public response restores Settings");
  const githubReads = () => githubCalls.filter(({ method, route }) => method === "GET" && route === "").length;
  const priorReads = githubReads();
  githubSettings = { ...githubSettings, workerAccountId: reviewerId };
  await refreshGitHub();
  await eventually(() => githubReads() > priorReads && Boolean(selector("Reviewer, @fixture-reviewer, Saved sign-in")) && !selector("Sign out"),
    "an account still selected by the worker cannot be signed out");
  githubSettings = { ...githubSettings, workerAccountId: null };
  await refreshGitHub();
  await click("Sign out");
  await eventually(() => text().includes("Sign out of @fixture-reviewer and use Installed gh for reviews?"), "sign-out confirms the named account");
  assert.ok(!githubCalls.some(({ route }) => route.endsWith("/sign-out")));
  assert.equal(githubSettings.reviewerAccountId, reviewerId);
  assert.equal(selector("Reviewer, Installed gh"), null, "the UI waits for confirmed sign-out");
  await click("Sign out");
  await eventually(() => Boolean(selector("Reviewer, Installed gh")), "sign-out clears the reviewer selection");
  assert.equal(githubSettings.accounts.length, 0);
  t.diagnostic("GitHub Settings covered default and configured reviewers, device sign-in, cancel, expiry, reconnect, import, explicit sign-out and public fields.");

  await click("Profiles");
  await eventually(() => Boolean(selector("Fixture worker, all roles: 49 of 49 recent assignments")), "profile usage renders");
  const toggle = selector("Disable Fixture worker");
  assert.ok(toggle && toggle.getAttribute("aria-disabled") !== "true");
  assert.ok(text().includes("Unavailable"), "the subscription pause renders");
  assert.doesNotMatch(text(), /Reading subscriptions/);
  await click("Reset fixture team");
  await eventually(() => pausedGroups.length === 0 && !selector("Reset fixture team"), "manual subscription reset renders");
  const beforeUsage = routes.map(count);
  usageCount = 50;
  resetAt = now + 60_000;
  emit("profile-usage");
  await eventually(() => text().includes("Unavailable until"), "runtime subscription pause renders");
  assert.ok(selector("Fixture worker, all roles: 50 of 50 recent assignments"));
  assert.deepEqual(routes.map((route, i) => count(route) - beforeUsage[i]!), [0, 1, 0, 0]);

  const beforeReconnect = routes.map(count);
  assert.ok(closeStream);
  closeStream();
  await eventually(() => count("/events") === 2 && count("/profiles/usage") > beforeReconnect[1]!,
    "a reconnected stream refreshes visible Settings", 5500);
  assert.deepEqual(routes.map((route, i) => count(route) - beforeReconnect[i]!), [0, 1, 1, 1]);
  assert.equal(planningReads().length, beforeSettings, "operator Settings makes no planning requests, including on reconnect");

  await click("Back to board");
  // Advance the record polling interval in the browser without disturbing
  // reconnect timers or the rendering clock.
  const setInterval = dom.window.setInterval.bind(dom.window);
  const clearInterval = dom.window.clearInterval.bind(dom.window);
  const recordTimers = new Map<number, { next: number; run: () => void }>();
  let intervalId = 0;
  let intervalClock = 0;
  t.mock.method(dom.window, "setInterval",
    (run: () => void, delay?: number) => {
      if (delay !== 4000) return setInterval(run, delay);
      const id = --intervalId;
      recordTimers.set(id, { next: intervalClock + delay, run });
      return id;
    },
  );
  t.mock.method(dom.window, "clearInterval", (id: number) => {
    if (id < 0) recordTimers.delete(id);
    else clearInterval(id);
  });
  const advanceRecordClock = async () => {
    intervalClock += 4100;
    for (const timer of recordTimers.values()) {
      if (timer.next > intervalClock) continue;
      timer.next += 4000;
      timer.run();
    }
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  };

  decisionOpen = true;
  emit("decisions");
  await eventually(() => Boolean(selector("Needs you, 1")), "the decision is back on the board");
  const decisionCard = () => dom.window.document.querySelector<HTMLElement>('[aria-label^="Decision: Which route should we take?"]');
  const itemRoute = "/planning/fixture/items";
  const decisionRoute = "/planning/fixture/decisions";
  const records = [
    {
      detail: "Lead detail", view: "Leads, 3", event: "planning", route: itemRoute,
      card: () => selector(`Lead: ${longLead}, Status: Unchecked · awaiting a check`),
    },
    {
      detail: "Papercut detail", view: "Papercuts, 2", event: "planning", route: itemRoute,
      card: () => selector(`Papercut: ${papercut}, Status: Open`),
    },
    {
      detail: "Decision detail", view: "Needs you, 1", event: "decisions", route: decisionRoute,
      card: decisionCard,
    },
  ];
  for (const { detail, view, event, route, card } of records) {
    await click(view);
    await eventually(() => Boolean(card()), detail + " card is available");
    const beforeOpen = count(route);
    card()!.click();
    const current = event === "planning" ? itemBody : decisionQuestion;
    await eventually(() => selector(detail)?.textContent?.includes(current) === true, detail + " initial read");
    assert.equal(count(route) - beforeOpen, 1, detail + " reads once on opening");

    const beforeIdle = count(route);
    await advanceRecordClock();
    assert.equal(count(route) - beforeIdle, 0, detail + " has no interval reads on a healthy stream");

    const changed = detail + " from a push";
    if (event === "planning") itemBody = changed;
    else decisionQuestion = changed;
    emit(event);
    await eventually(() => selector(detail)?.textContent?.includes(changed) === true, detail + " refreshes on its event");
    assert.equal(count(route) - beforeIdle, 2, detail + " and its collection each refresh once");
  }

  let resumeEvents!: () => void;
  reconnectGate = new Promise<void>((resolve) => { resumeEvents = resolve; });
  t.after(() => resumeEvents());
  closeStream!();
  const channel = (state: string) => dom.window.document.querySelector(`[data-live-channel="${state}"]`);
  await eventually(() => Boolean(channel("disconnected")) && recordTimers.size === 1,
    "the open decision starts its fallback read interval when the stream drops");
  const beforeFallback = count(decisionRoute);
  decisionQuestion = "Decision detail during disconnection";
  await advanceRecordClock();
  await eventually(() => selector("Decision detail")?.textContent?.includes(decisionQuestion) === true,
    "the open decision refreshes during disconnection");
  assert.equal(count(decisionRoute) - beforeFallback, 1);

  const beforeRecovery = count(decisionRoute);
  decisionQuestion = "Decision detail after reconnect";
  resumeEvents();
  reconnectGate = undefined;
  await eventually(() => Boolean(channel("connected")) &&
    selector("Decision detail")?.textContent?.includes(decisionQuestion) === true,
    "stream reconnection refreshes the open decision");
  assert.equal(count(decisionRoute) - beforeRecovery, 2);

  const afterRecovery = count(decisionRoute);
  await advanceRecordClock();
  assert.equal(count(decisionRoute) - afterRecovery, 0, "reconnection stops the fallback interval");
  await click("Use option: Same label (first)");
  assert.equal(answeredOption, null, "selecting a choice waits for confirmation");
  await click("Use option: Same label (second)");
  assert.ok(selector("Use option: Third") && selector("Use option: Fourth"));
  await click("Answer");
  await eventually(() => answeredOption === "second", "the board posts the second duplicate's ID");
  await click("Working, 1");
  decisionOpen = false;
  emit("decisions");
  await click("Projects, All projects");
  const projectRow = () => selector("Project selector")?.querySelector<HTMLElement>(
    '[role="checkbox"][aria-label^="Project Fixture project,"]',
  );
  await eventually(() => Boolean(projectRow()), "the picker shows the active project");
  const picker = selector("Project selector")!.parentElement!;
  const project = projectRow()!;
  const frame = project.parentElement!.parentElement!;
  const name = [...project.querySelectorAll("*")].find(
    node => node.childElementCount === 0 && node.textContent === "Fixture project",
  );
  assert.ok(name);
  const activeName = "rgb(245, 245, 245)";
  assert.equal(style(name).color, "rgba(245, 245, 245, 0.75)");
  assert.equal(style(name).fontWeight, "400");
  const popoverFill = style(picker).backgroundColor;
  assert.equal(popoverFill, "rgb(17, 17, 17)");
  assert.equal(style(picker).borderTopColor, "rgba(245, 245, 245, 0.08)");
  const pointer = (element: Element, kind: "pointerenter" | "pointerleave") =>
    element.dispatchEvent(new dom.window.PointerEvent(kind, { pointerType: "mouse" }));
  pointer(project, "pointerenter");
  const hover = "rgba(245, 245, 245, 0.06)";
  await eventually(() => style(frame).backgroundColor === hover, "hover uses the popover tint");
  assert.equal(style(name).color, activeName);
  pointer(project, "pointerleave");
  project.focus();
  await eventually(() => style(frame).backgroundColor === hover, "focus uses the popover tint");
  assert.equal(style(name).color, activeName);
  project.blur();
  project.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, shiftKey: true }));
  const selected = "rgba(245, 245, 245, 0.1)";
  await eventually(() => style(frame).backgroundColor === selected, "the checked row uses a stronger tint");
  assert.equal(style(name).color, activeName);
  await click("Clear project selection");
  await click("Project actions for Fixture project");
  const actions = selector("Actions for Fixture project")!;
  const archive = selector("Archive Fixture project")!;
  assert.ok(archive && frame.contains(actions));
  assert.equal(style(frame).backgroundColor, hover, "open row and panel share a single tinted frame");
  assert.equal(style(name).color, activeName);
  assert.equal(style(actions).backgroundColor, "rgba(0, 0, 0, 0)");
  assert.equal(style(archive).backgroundColor, "rgba(0, 0, 0, 0)");
  assert.ok(selector("Remove Fixture project from Nucleus"), "Remove is separate from Archive");
  pointer(archive, "pointerenter");
  await eventually(() => style(archive).backgroundColor === hover, "action hover adds a tint to the open panel");
  const grey = (color: string) => Number(color.match(/[\d.]+/)?.[0]);
  const blend = (color: string, background: number) => {
    const channels = color.match(/[\d.]+/g)!.map(Number);
    return channels[0]! * channels[3]! + background * (1 - channels[3]!);
  };
  const base = grey(popoverFill);
  const hoverGrey = blend(style(frame).backgroundColor, base);
  const selectedGrey = blend(selected, base);
  const actionGrey = blend(style(archive).backgroundColor, hoverGrey);
  assert.ok(base < hoverGrey && hoverGrey < selectedGrey && selectedGrey < actionGrey);
  const luminance = (channel: number) => ((channel / 255 + 0.055) / 1.055) ** 2.4;
  const actionText = grey(style(archive.lastElementChild!).color);
  assert.ok((luminance(actionText) + 0.05) / (luminance(actionGrey) + 0.05) >= 4.5,
    "action text stays readable over the strongest tint");

  const archiveWrites = () => writes.filter(({ path }) => path === "/api/engine/settings/projects");
  await click("Archive Fixture project");
  await eventually(() => projectArchived && !projectRow() && Boolean(selector("Leads, 0")),
    "archive removes the project from the picker and refreshes the menu counts");
  assert.equal(archiveWrites().length, 1);
  assert.ok(selector("Project selector"), "archive leaves the picker open");
  await click("Project settings");
  assert.equal(dom.window.location.pathname, "/settings");
  await click("Restore Fixture project");
  await eventually(() => !projectArchived && Boolean(selector("Archive Fixture project")),
    "Settings restores the project using the same domain write");
  assert.equal(archiveWrites().length, 2);
  await click("Back to board");
  await eventually(() => Boolean(selector("Leads, 3")), "restored project is counted on the board");
  await click("Projects, All projects");
  await eventually(() => Boolean(projectRow()), "the restored project is in the picker");
  await click("Project settings");
  await click("Profiles");
  await eventually(() => Boolean(selector("Disable Fixture worker")), "operator controls are visible before the session changes");
  const afterProjectSettings = planningReads().length;

  operator = false;
  emit("refresh");
  await eventually(() => !selector("Disable Fixture worker"), "a new planner session clears operator controls");
  await click("Profiles");
  await eventually(() => Boolean(selector("Fixture worker: On")), "the scoped planner sees the stored profile");
  assert.equal(selector("Fixture worker: On")?.getAttribute("aria-disabled"), "true");
  assert.equal(selector("GitHub"), null, "a planner session never has the GitHub Settings tab");
  await eventually(() => Boolean(selector("Fixture worker, all roles: 50 of 50 recent assignments")), "the planner also sees recorded usage");
  assert.equal(planningReads().length, afterProjectSettings);

  const plannerStream = stream;
  operator = true;
  emit("refresh");
  await eventually(() => stream !== plannerStream, "the operator session resubscribed");
  await click("Profiles");
  await eventually(() => Boolean(selector("Disable Fixture worker")), "the operator session is restored");
  await click("Back to board");
  await click("Projects, All projects");
  await click("Project actions for Fixture project");
  await click("Remove Fixture project from Nucleus");
  await eventually(() => Boolean(selector("Remove Fixture project dialog")) && text().includes("No open work"),
    "the shared dialog parsed the native preview");
  const reason = selector("Reason") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(reason, "Fixture retired");
  reason.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await click("Delete project");
  assert.equal(projectRemoved, false, "a preview and the first click do not delete");
  await click("Delete project Fixture project");
  await eventually(() => projectRemoved && !selector("Remove Fixture project dialog"),
    "the board parsed the durable removal receipt and closed the dialog");
  assert.equal(removalWrites, 1);
  if (!selector("Project selector")) await click("Projects, All projects");
  await eventually(() => text().includes("No projects yet."), "the removed project is absent from the refreshed selector");
  assert.ok(requests.every((path) => path.startsWith("/api/engine/")));
});
