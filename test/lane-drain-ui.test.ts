import { test } from "node:test";
import { recentProjectActivity } from "./support/project-activity";
import assert from "node:assert/strict";
import React from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs } from "./support/render";
import { laneViewSchema, projectSchema } from "../shared/contracts";
import type { LaneView, Project, ProjectPlan } from "../shared/contracts";
import type { PlanEdit } from "../client/planning-panel";

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const repoA = { origin: "owner/app", path: "/app" };

const plainLaneRecord = (key: string, escalated: boolean) => ({
  id: `lane-${key}`,
  key,
  title: `${key === "alpha" ? "Alpha" : "Beta"} lane`,
  aim: `Done looks like ${key} shipped.`,
  status: "active",
  note: "",
  repositories: [repoA],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  closedAt: null,
  ...(key === "alpha"
    ? {
        drain: {
          since: "2026-10-02T08:00:00.000Z",
          notices: 1,
          lastNoticeAt: "2026-10-02T08:00:00.000Z",
          ...(escalated ? { escalatedAt: "2026-10-03T08:00:00.000Z" } : {}),
        },
        keep: null,
      }
    : {}),
});
const drainedLane = (escalated: boolean) =>
  laneViewSchema.parse({
    id: "lane-1",
    key: "alpha",
    title: "Alpha lane",
    aim: "Done looks like alpha shipped.",
    status: "active",
    note: "",
    repositories: [repoA],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    closedAt: null,
    drain: {
      since: "2026-10-02T08:00:00.000Z",
      notices: 1,
      lastNoticeAt: "2026-10-02T08:00:00.000Z",
      ...(escalated ? { escalatedAt: "2026-10-03T08:00:00.000Z" } : {}),
    },
    keep: null,
    liveByPhase: {},
    liveByRepository: {},
    terminalCount: 3,
    lastActivityAt: "2026-10-02T08:00:00.000Z",
    recentOutcomes: [
      {
        taskId: "t1",
        title: "Finished task",
        outcome: "done",
        prUrl: null,
        prNumber: null,
        finishedAt: "2026-10-02T08:00:00.000Z",
      },
    ],
  });
const plainLane = laneViewSchema.parse({
  id: "lane-2",
  key: "beta",
  title: "Beta lane",
  aim: "Done looks like beta shipped.",
  status: "active",
  note: "",
  repositories: [repoA],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  closedAt: null,
  liveByPhase: { working: 1 },
  liveByRepository: { "/app": 1 },
  terminalCount: 0,
  lastActivityAt: "2026-10-03T00:00:00.000Z",
});
const project = (drain: LaneView["drain"]): Project =>
  projectSchema.parse({
    key: "app",
    name: "App",
    version: 1,
    repositories: [repoA],
    primary: repoA,
    owner: {
      agentId: "thread",
      assignedBy: "operator",
      assignedAt: "2026-10-03T00:00:00.000Z",
      note: "",
    },
    ...(drain ? { drain } : {}),
  });
const plan: ProjectPlan = {
  project: "app",
  version: 1,
  author: "planner-agent",
  createdAt: "2026-10-01T00:00:00.000Z",
  entries: [
    { lane: "alpha", note: "", horizon: "now", doneWhen: "Alpha shipped" },
  ],
};

async function settle(
  probe: () => boolean,
  what = "the surface did not settle",
) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(what);
}

test("041 rendered: a drained plan lane shows the Drained flag with its age in the Now band", async () => {
  const { PlanningTab } = await import("../client/planning-panel");
  function Harness() {
    const [edits, setEdits] = useState<Record<string, PlanEdit>>({});
    return h(PlanningTab, {
      sections: [{ project: project(null), latest: plan, saved: plan }],
      projectActivity: recentProjectActivity([project(null)]),
      lanes: [drainedLane(false), plainLane],
      edits,
      selectedLane: "",
      step: "plan",
      compact: false,
      busy: false,
      lanePanel: null,
      onStep: () => {},
      onOpenLane: () => {},
      onEdit: (p: string, edit: PlanEdit) =>
        setEdits((prev) => ({ ...prev, [p]: edit })),
      onSave: () => {},
      onCancel: () => {},
      c,
    });
  }
  const ui = mount(h(Harness));
  assert.ok(ui.get("Drained alpha"));
  assert.match(ui.text(), /Drained · .* ago/);
});
