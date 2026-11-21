import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import {
  socketFixtureDirectory,
  assertSocketPathWithinBound,
} from "./support/socket-fixture";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { QueueService } from "../service/transport/server";
import { ServiceClient } from "../shared/service/client";
import { readServiceInfo } from "../service/transport/identity";
import { Store } from "../core/store/store";
import { finishedThreadCleanupKeyPrefix } from "../core/store/store-core";
import { submissionSchema } from "../shared/contracts";
import type { ExecutorRequestTiming } from "../service/executor/executor";

useNativeStubs();
const h = React.createElement;

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
    cookie?: string;
    authorization?: string;
    body?: unknown;
    settings?: boolean;
  } = {},
): Promise<Http> {
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
  };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.authorization) headers.authorization = options.authorization;
  if (options.settings) headers["x-nucleus-surface"] = "settings";
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  if (payload !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function pairedRpc<T = unknown>(
  port: number,
  cookie: string,
  method: string,
  input: unknown = {},
  settings = true,
): Promise<{
  status: number;
  body: { result?: T; error?: { message?: string } };
  elapsedMs: number;
}> {
  const started = performance.now();
  const res = await http(port, "/api/rpc", {
    method: "POST",
    cookie,
    settings,
    body: { method, input },
  });
  return {
    status: res.status,
    body: JSON.parse(res.body) as { result?: T; error?: { message?: string } },
    elapsedMs: performance.now() - started,
  };
}

test("paired board Settings RPCs keep cheap reads and override removal responsive under concurrent host.list and backup.list load (nucleus#1495)", async (t) => {
  const dataDir = socketFixtureDirectory("queue-service.sock");
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  // Seed persisted history (settled tasks, released runs, hosts, project + slot override 5, default 4)
  // before starting the service so the executor opens a representative store.
  const store = new Store(join(dataDir, "queue.sqlite"));
  try {
    const pad = "x".repeat(2048);
    const rpad = "y".repeat(1024);
    const insTask = store.db.prepare(
      "INSERT INTO tasks(id,submission,input_hash,data) VALUES(?,?,?,?)",
    );
    const insRun = store.db.prepare(
      "INSERT INTO runs(id,taskId,data) VALUES(?,?,?)",
    );
    const insMeta = store.db.prepare(
      "INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",
    );
    // One valid live task + unreleased run on a secondary host so host.list reports real dependents.
    // We also clone its schema-valid shape for the settled history rows below.
    const liveTask = store.insert(
      submissionSchema.parse({
        submissionId: "sub-live",
        title: "Live secondary-host task",
        repoPath: join(dataDir, "demo-repo"),
        planningCommit: "0".repeat(40),
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      "t3code:env-1",
      "handoff",
      "0".repeat(40),
    );
    const baseRun = {
      id: "run-live",
      taskId: liveTask.id,
      role: "revision",
      generation: 1,
      head: "0".repeat(40),
      base: "0".repeat(40),
      hostId: "t3code:env-1",
      agentId: "ag-live",
      workspaceId: "ws-live",
      profile: null,
      status: "running",
      createdAt: "2026-11-21T00:00:00.000Z",
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    };
    store.putRun(baseRun as never);

    store.db.exec("BEGIN");
    for (let i = 0; i < 600; i++) {
      const hostId = i < 200 ? "" : i < 500 ? "t3code:env-1" : "paseo:primary";
      const id = `settled-${i}`;
      insTask.run(
        id,
        `sub-${i}`,
        "h",
        JSON.stringify({
          ...liveTask,
          id,
          submissionId: `sub-${i}`,
          phase: "done",
          hostId,
          agentId: `ag-${i}`,
          retiredWorkers: [],
          resolution: { mergedCommit: "abc123", summary: pad },
        }),
      );
      insMeta.run(
        `${finishedThreadCleanupKeyPrefix}${id}`,
        JSON.stringify({ at: "2026-11-20T00:00:00.000Z" }),
      );
      for (let j = 0; j < 2; j++) {
        insRun.run(
          `run-${i}-${j}`,
          id,
          JSON.stringify({
            ...baseRun,
            id: `run-${i}-${j}`,
            taskId: id,
            role: j === 0 ? "revision" : "reviewer",
            status: "finished",
            active: false,
            released: true,
            hostId,
            agentId: `ag-${i}-${j}`,
            detail: rpad,
          }),
        );
      }
    }
    store.db.exec("COMMIT");

    store.setMeta("hostRegistry", [
      {
        id: "paseo:primary",
        endpoint: "ws://127.0.0.1:6767",
        lastSeenAt: "2026-11-21T00:00:00.000Z",
      },
      {
        id: "t3code:env-1",
        endpoint: "http://127.0.0.1:3773",
        lastSeenAt: "2026-11-21T00:00:00.000Z",
      },
      {
        id: "bb:local",
        endpoint: "local",
        lastSeenAt: "2026-11-21T00:00:00.000Z",
      },
    ]);
    store.setMeta("projectLimit", 4);
    store.upsertProject({
      key: "demo-project",
      name: "Demo Project",
      repositories: [
        {
          origin: "https://example.invalid/demo/repo.git",
          path: join(dataDir, "demo-repo"),
        },
      ],
    });
    store.setProjectDispatchLimitOverride("demo-project", 5);
  } finally {
    store.close();
  }

  // Seed retained backup snapshot files in the isolated fixture backup directory.
  const backupDir = join(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  for (let i = 0; i < 24; i++) {
    const hour = String(i).padStart(2, "0");
    writeFileSync(
      join(
        backupDir,
        `2026-11-20T${hour}-00-00-000Z-00000000-0000-4000-8000-${String(i).padStart(12, "0")}.hourly.sqlite.gz`,
      ),
      "synthetic-snapshot",
    );
  }

  const service = new QueueService({
    owner: { dataDir },
    fixture: "fake",
    debug: true,
    webBoard: { bundleDir: null, port: 0 },
  });
  await service.start();
  t.after(() => service.stop());

  const info = readServiceInfo(dataDir);
  assert.ok(info?.httpPort, "service publishes loopback web board port");
  assertSocketPathWithinBound(info.socketPath);
  const client = new ServiceClient({
    socketPath: info.socketPath,
    credential: info.credential,
  });
  await client.connect();
  t.after(() => client.close());

  const issued = (await client.request("service.ui-link", {})) as {
    url: string;
  };
  const token = new URLSearchParams(new URL(issued.url).hash.slice(1)).get(
    "token",
  );
  assert.ok(token);
  const paired = await http(info.httpPort, "/api/pair", {
    method: "POST",
    authorization: `Bearer ${token}`,
  });
  assert.equal(paired.status, 200, paired.body);
  const cookie = paired.headers["set-cookie"]?.[0]?.split(";")[0];
  assert.ok(cookie);

  // Confirm initial override of 5 before removal.
  const beforeProjects = await pairedRpc<{
    defaultSlots: number;
    projects: Array<{
      project: { key: string };
      slots: { override: number | null; value: number };
    }>;
  }>(info.httpPort, cookie, "project.settings", {});
  assert.equal(beforeProjects.status, 200);
  const beforeDemo = beforeProjects.body.result?.projects.find(
    (p) => p.project.key === "demo-project",
  );
  assert.deepEqual(beforeDemo?.slots, {
    override: 5,
    value: 5,
  });

  // Exercise concurrent heavy Settings reads alongside cheap reads and override removal.
  const [
    hostsRes,
    backupsRes,
    capacityRes,
    profilesRes,
    compatRes,
    settingsRes,
    removeRes,
  ] = await Promise.all([
    pairedRpc<{
      hosts: Array<{
        id: string;
        dependents: Array<{ kind: string; names: string[] }>;
      }>;
    }>(info.httpPort, cookie, "host.list", {}),
    pairedRpc<{ snapshots: unknown[] }>(
      info.httpPort,
      cookie,
      "backup.list",
      {},
    ),
    pairedRpc(info.httpPort, cookie, "queue.capacity-state", {}),
    pairedRpc(info.httpPort, cookie, "profile.list", {}),
    pairedRpc(info.httpPort, cookie, "profile.compatibility", {}),
    pairedRpc(info.httpPort, cookie, "project.settings", {}),
    pairedRpc<{ ok: true }>(
      info.httpPort,
      cookie,
      "queue.project-dispatch-limit",
      { projectKey: "demo-project", limit: null },
    ),
  ]);

  for (const [name, res] of [
    ["host.list", hostsRes],
    ["backup.list", backupsRes],
    ["queue.capacity-state", capacityRes],
    ["profile.list", profilesRes],
    ["profile.compatibility", compatRes],
    ["project.settings", settingsRes],
    ["queue.project-dispatch-limit", removeRes],
  ] as const) {
    assert.equal(
      res.status,
      200,
      `${name} failed: ${JSON.stringify(res.body)}`,
    );
  }

  const t3Host = hostsRes.body.result?.hosts.find(
    (entry) => entry.id === "t3code:env-1",
  );
  assert.ok(t3Host, "t3code host is listed");
  assert.deepEqual(
    t3Host.dependents
      .filter((d) => d.kind === "task" || d.kind === "run")
      .map((d) => d.names.length),
    [1, 1],
    "host.list retains exact live task and unreleased run dependents",
  );
  assert.equal(backupsRes.body.result?.snapshots.length, 24);

  // Post-save read-back across both board state and project.settings shows the inherited limit (4 / 8).
  const [afterBoard, afterProjects, health] = await Promise.all([
    pairedRpc<{
      projectLimit: number;
      projectLimitOverrides: Record<string, number>;
      projectCapacities: Array<{
        projectKey: string;
        slotLimit: number;
        inFlightLimit: number;
      }>;
    }>(info.httpPort, cookie, "queue.ui-snapshot", {}),
    pairedRpc<{
      defaultSlots: number;
      projects: Array<{
        project: { key: string };
        slots: { override: number | null; value: number };
      }>;
    }>(info.httpPort, cookie, "project.settings", {}),
    client.request("service.health", {}) as Promise<{
      requestTimings: { recent: ExecutorRequestTiming[] };
    }>,
  ]);
  assert.equal(afterBoard.status, 200);
  assert.equal(afterProjects.status, 200);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      afterBoard.body.result?.projectLimitOverrides ?? {},
      "demo-project",
    ),
    false,
    "board snapshot confirms override removal",
  );
  const afterCap = afterBoard.body.result?.projectCapacities.find(
    (entry) => entry.projectKey === "demo-project",
  );
  assert.equal(afterCap?.slotLimit, 4);
  assert.equal(afterCap?.inFlightLimit, 8);
  const afterDemo = afterProjects.body.result?.projects.find(
    (p) => p.project.key === "demo-project",
  );
  assert.deepEqual(afterDemo?.slots, {
    override: null,
    value: 4,
  });

  // Verify executor timing telemetry separates queue, handler, publication, and return timing.
  const methods = new Set(
    health.requestTimings.recent.map((row) => row.method),
  );
  for (const expected of [
    "host.list",
    "backup.list",
    "queue.capacity-state",
    "project.settings",
    "queue.project-dispatch-limit",
  ]) {
    assert.ok(methods.has(expected), `requestTimings includes ${expected}`);
  }
  for (const row of health.requestTimings.recent) {
    assert.equal(typeof row.queueMs, "number");
    assert.equal(typeof row.handlerMs, "number");
    assert.equal(typeof row.publicationMs, "number");
    assert.equal(typeof row.returnMs, "number");
  }
});

const dark = {
  accent: "#1f6feb",
  accentForeground: "#ffffff",
  surface0: "#0d1117",
  surface1: "#161b22",
  surface2: "#30363d",
  border: "#30363d",
  foreground: "#f0f6fc",
  foregroundMuted: "#8b949e",
  statusWarning: "#f0883e",
  statusDanger: "#f85149",
  statusSuccess: "#3fb950",
} as const;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

async function waitFor(probe: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (probe()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}

function selectSettingsTab(ui: ReturnType<typeof mount>, label: string) {
  const tab = (ui.get("Settings sections") as HostNode).children.find(
    (node): node is HostNode =>
      typeof node !== "string" && node.props.accessibilityLabel === label,
  );
  assert.ok(tab, `expected tab ${label}`);
  tab.props.onPress();
}

test("Settings override removal stays locked across tab switches, distinguishes save vs refresh latency, and surfaces refresh failure without retrying writes (nucleus#1495)", async () => {
  const settings = await import("../client/settings-screen");
  const { hintSettingsSection } = await import("../client/settings-hint");
  hintSettingsSection("capacity");

  let override: number | null = 5;
  let revision = 1;
  let writeCount = 0;
  let holdWrite: Promise<void> | null = null;
  let holdRefresh: Promise<void> | null = null;
  let failNextWrite = false;
  let failNextRefresh = false;

  const boardState = () => ({
    revision,
    connected: true,
    hostId: "host",
    paused: false,
    error: "",
    dispatchHeld: false,
    quiet: true,
    activeWorkers: 0,
    unsettled: 0,
    occupiedSlots: 0,
    stoppedThreads: 0,
    resumedThreads: 0,
    globalLimit: 32,
    projectLimit: 4,
    papercutProjectLimit: 2,
    usage: { level: "normal", setLevel: "normal", until: null, expired: false },
    routingGrants: [],
    tasks: [],
    profiles: [],
    pool: [],
    availability: [],
    assignments: {},
    recentAssignments: {},
    lanes: [],
    projects: [
      {
        key: "demo",
        name: "Demo",
        repositories: [{ origin: "owner/demo", path: "/demo" }],
        primary: { origin: "owner/demo", path: "/demo" },
      },
    ],
    projectLimitOverrides: override === null ? {} : { demo: override },
    projectCapacities: [
      {
        projectKey: "demo",
        projectName: "Demo",
        occupiedSlots: 0,
        slotLimit: override ?? 4,
        inFlightTasks: 0,
        inFlightLimit: (override ?? 4) * 2,
      },
    ],
    prStates: {},
    backup: { newestSnapshotAt: new Date().toISOString(), localError: null },
  });

  const projectSettingsPayload = () => ({
    defaultSlots: 4,
    projects: [
      {
        project: {
          key: "demo",
          name: "Demo",
          version: 1,
          visibility: "active",
          repositories: [{ origin: "owner/demo", path: "/demo" }],
          primary: { origin: "owner/demo", path: "/demo" },
          drain: null,
        },
        repositories: [
          {
            repository: { origin: "owner/demo", path: "/demo" },
            primary: true,
            settings: null,
          },
        ],
        slots: {
          override,
          value: override ?? 4,
        },
        plannerLive: null,
        plannerTicket: null,

        problems: [],
      },
    ],
  });

  const invoke = async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") {
      if (holdRefresh) await holdRefresh;
      if (failNextRefresh) {
        failNextRefresh = false;
        throw new Error("board snapshot timed out");
      }
      return boardState();
    }
    if (method === "queue.capacity-state") {
      return {
        effective: {
          globalLimit: 32,
          projectLimit: 4,
          papercutProjectLimit: 2,
          hostCallLimit: 6,
          stallThresholdMinutes: 30,
          holdReminderMinutes: 120,
          holdEscalationMinutes: 240,
          laneDrainMinutes: 120,
          laneDrainEscalationMinutes: 1440,
          hostOutageNoticeMinutes: 120,
          operatorDefaultHostKind: "paseo",
          threadRetentionDays: 3,
        },
        changes: [],
      };
    }
    if (method === "project.settings") return projectSettingsPayload();
    if (method === "backup.list") return { snapshots: [], localError: null };
    if (method === "queue.project-dispatch-limit") {
      writeCount++;
      if (holdWrite) await holdWrite;
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("executor busy");
      }
      const patch = input as { projectKey: string; limit: number | null };
      override = patch.limit;
      revision++;
      return { ok: true };
    }
    return {};
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke,
        children: h(settings.QueueSettingsScreen as never, {
          theme: { colors: dark as never },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    }),
  );

  try {
    const slotsLabel = "Task slots for Demo (0–64; 0 admits nothing)";
    await waitFor(
      () => Boolean(ui.query("Remove the Demo override")),
      "initial override row",
    );

    let releaseWrite!: () => void;
    let releaseRefresh!: () => void;
    holdWrite = new Promise<void>((r) => {
      releaseWrite = r;
    });
    holdRefresh = new Promise<void>((r) => {
      releaseRefresh = r;
    });

    ui.press("Remove the Demo override");
    ui.press("Remove Demo dispatch limit override");

    await waitFor(
      () =>
        ui.query(slotsLabel)?.props.editable === false &&
        ui.text().includes("Removing…"),
      "row locked in saving phase",
    );

    // Switch away to Projects and back to Dispatch limits while write is still in flight.
    selectSettingsTab(ui, "Projects");
    await waitFor(() => ui.text().includes("Demo"), "Projects tab");
    selectSettingsTab(ui, "Dispatch limits");
    await waitFor(
      () => Boolean(ui.query(slotsLabel)),
      "return to Dispatch limits",
    );
    assert.equal(
      ui.get(slotsLabel).props.editable,
      false,
      "returning during in-flight write must not restore a stale interactive row",
    );
    assert.match(ui.text(), /Removing…/);

    // Complete the write while holding the post-write refresh.
    holdWrite = null;
    releaseWrite();
    await waitFor(
      () => ui.text().includes("Removed — refreshing…"),
      "refreshing phase after write commits",
    );

    // Switch tabs again during refresh; row remains locked with refreshing status.
    selectSettingsTab(ui, "Projects");
    selectSettingsTab(ui, "Dispatch limits");
    await waitFor(() => Boolean(ui.query(slotsLabel)), "return during refresh");
    assert.equal(ui.get(slotsLabel).props.editable, false);
    assert.match(ui.text(), /Removed — refreshing…/);

    // Complete refresh: row disappears and Projects tab observes the inherited 4-slot limit.
    holdRefresh = null;
    releaseRefresh();
    await waitFor(
      () => !ui.query("Remove the Demo override"),
      "override row removed after refresh",
    );
    assert.equal(writeCount, 1, "removal wrote exactly once");

    selectSettingsTab(ui, "Projects");
    await waitFor(
      () => ui.text().includes("4 slots") || ui.text().includes("Demo"),
      "Projects tab shows inherited limit",
    );
    assert.equal(override, null);

    // Now re-seed override = 5 to verify refresh-failure feedback without retrying the write.
    override = 5;
    revision++;
    await client.refetchQueries({
      queryKey: ["nucleus", "state"],
      exact: true,
    });
    selectSettingsTab(ui, "Dispatch limits");
    await waitFor(
      () => Boolean(ui.query("Remove the Demo override")),
      "re-seeded override row",
    );

    const beforeRefreshFailWrites = writeCount;
    failNextRefresh = true;
    ui.press("Remove the Demo override");
    ui.press("Remove Demo dispatch limit override");
    await waitFor(
      () =>
        /Override removed, but refresh failed: .*board snapshot timed out/.test(
          ui.text(),
        ),
      "refresh failure alert after committed write",
    );
    assert.equal(
      writeCount,
      beforeRefreshFailWrites + 1,
      "refresh failure never retries the committed write",
    );
    assert.equal(override, null, "the write committed on the server");

    // Re-seed override = 5 to verify write-failure feedback and no automatic retry.
    override = 5;
    revision++;
    await client.refetchQueries({
      queryKey: ["nucleus", "state"],
      exact: true,
    });
    await waitFor(
      () => Boolean(ui.query("Remove the Demo override")),
      "second re-seeded row",
    );
    const beforeWriteFailCount = writeCount;
    failNextWrite = true;
    ui.press("Remove the Demo override");
    ui.press("Remove Demo dispatch limit override");
    await waitFor(
      () => /Not saved: .*executor busy/.test(ui.text()),
      "write failure shown beside row",
    );
    assert.equal(
      writeCount,
      beforeWriteFailCount + 1,
      "failed write is never retried automatically",
    );
    assert.equal(
      ui.get(slotsLabel).props.editable,
      true,
      "failed write returns editing to the row",
    );
  } finally {
    ui.update(h("View", null));
    client.clear();
  }
});
