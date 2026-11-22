import { test } from "node:test";
import assert from "node:assert/strict";
import { projectSchema, type TaskSummary } from "../shared/contracts";
import { projectLastActivity, projectStatus } from "../shared/planning-read";

const repo = { origin: "fixture/app", path: "/fixture/app" };
const project = projectSchema.parse({
  key: "app",
  name: "App",
  repositories: [repo],
  primary: repo,
});
test("1531 a project row's last activity is its own work however old, never a shared lane's", () => {
  // The store's unwindowed lastAt covers work with no lane at all, past the three-day window.
  const activity = {
    key: "app",
    items: [],
    lastAt: "2026-07-01T00:00:00.000Z",
  };
  assert.equal(
    projectLastActivity({ project, activity, tasks: [] }),
    "2026-07-01T00:00:00.000Z",
  );
  // A live task in the project's repository or a plan save newer than that wins; another project's task never counts.
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
    projectLastActivity({ project, activity, tasks }),
    "2026-09-05T10:00:00.000Z",
  );
  assert.equal(
    projectLastActivity({
      project,
      activity,
      tasks,
      plan: { createdAt: "2026-10-01T00:00:00.000Z" },
    }),
    "2026-10-01T00:00:00.000Z",
  );
  assert.equal(projectLastActivity({ project, tasks: [] }), null);
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
