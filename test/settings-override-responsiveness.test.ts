import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs, type HostNode } from "./support/render";
useNativeStubs();
const h = React.createElement;

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
    usage: { level: "normal", setLevel: "normal", until: null, expired: false },
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
          hostCallLimit: 6,
          operatorDefaultHostKind: "paseo",
          threadRetentionDays: 3,
          threadRetentionIntervalHours: 12,
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
