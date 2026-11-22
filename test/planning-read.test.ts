import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectSchema,
  laneViewSchema,
  type TaskSummary,
} from "../shared/contracts";
import { projectLastActivity, projectStatus } from "../shared/planning-read";

const repo = { origin: "fixture/app", path: "/fixture/app" };
const project = projectSchema.parse({
  key: "app",
  name: "App",
  repositories: [repo],
  primary: repo,
});
const lane = (key: string, lastActivityAt: string | null) =>
  laneViewSchema.parse({
    id: key,
    key,
    title: key,
    aim: `Aim ${key}`,
    status: "active",
    repositories: [repo],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    liveByPhase: {},
    liveByRepository: {},
    terminalCount: 0,
    lastActivityAt,
  });

test("1531 a project row's last activity reaches past the three-day activity read", () => {
  // No recent items at all: the store-wide read is empty, but the lanes remember older work.
  const lanes = [
    lane("old", "2026-09-01T10:00:00.000Z"),
    lane("older", "2026-08-01T10:00:00.000Z"),
  ];
  assert.equal(
    projectLastActivity({
      project,
      activity: { key: "app", items: [] },
      lanes,
      tasks: [],
    }),
    "2026-09-01T10:00:00.000Z",
  );
  // A plan save or a live task newer than the lanes wins; another project's task never counts.
  const tasks = [
    {
      repoPath: "/fixture/app",
      updatedAt: "2026-09-05T10:00:00.000Z",
      phase: "queued",
    },
    {
      repoPath: "/elsewhere",
      updatedAt: "2026-11-20T10:00:00.000Z",
      phase: "working",
    },
  ] as Pick<TaskSummary, "repoPath" | "repository" | "updatedAt" | "phase">[];
  assert.equal(
    projectLastActivity({ project, lanes, tasks }),
    "2026-09-05T10:00:00.000Z",
  );
  assert.equal(
    projectLastActivity({
      project,
      lanes,
      tasks,
      plan: { createdAt: "2026-10-01T00:00:00.000Z" },
    }),
    "2026-10-01T00:00:00.000Z",
  );
  assert.equal(projectLastActivity({ project, lanes: [], tasks: [] }), null);
});

test("1531 a project row counts a task in two lanes once, and adds the queued tasks the board holds back", () => {
  const task = (id: string, phase: string, lanes: string[]) =>
    ({
      id,
      phase,
      lanes,
      repoPath: "/fixture/app",
      repository: "fixture/app",
    }) as unknown as TaskSummary;
  const tasks = [
    task("t1", "working", ["a", "b"]),
    task("t2", "blocked", ["a", "b"]),
    task("t3", "queued", ["a"]),
  ];
  const status = projectStatus({
    project,
    plan: { entries: [{ lane: "a", note: "", horizon: "now" }] },
    tasks,
    queuedCounts: [{ repoPath: "/fixture/app", count: 4 }],
  });
  assert.deepEqual(
    status,
    { attention: 1, inProgress: 1, live: 3 + 3 },
    "three distinct live tasks plus three held-back queued ones",
  );
});
