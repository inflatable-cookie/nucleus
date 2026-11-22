import { test } from "node:test";
import assert from "node:assert/strict";
import {
  laneViewSchema,
  projectSchema,
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
test("1531 a project row's last activity is its own work however old", () => {
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

test("1531 a project row's last activity keeps its lanes' own record times but not a shared lane's aggregate", () => {
  const other = { origin: "fixture/tool", path: "/fixture/tool" };
  const lane = (
    key: string,
    repositories: (typeof repo)[],
    times: { updatedAt: string; lastActivityAt: string; keepAt?: string },
  ) =>
    laneViewSchema.parse({
      id: key,
      key,
      title: key,
      aim: `Aim ${key}`,
      status: "active",
      repositories,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: times.updatedAt,
      keep: times.keepAt
        ? { reason: "Waiting on a decision.", at: times.keepAt, by: "operator" }
        : null,
      liveByPhase: {},
      liveByRepository: {},
      terminalCount: 0,
      lastActivityAt: times.lastActivityAt,
    });
  // A project with no work at all: its new lane's record is its last activity (review 6010408992).
  const fresh = lane("fresh", [repo], {
    updatedAt: "2026-11-21T09:00:00.000Z",
    lastActivityAt: "2026-11-21T09:00:00.000Z",
  });
  assert.equal(
    projectLastActivity({ project, lanes: [fresh], tasks: [] }),
    "2026-11-21T09:00:00.000Z",
  );
  // A shared lane: its record and keep count, but the other project's newer completion in it does not.
  const shared = lane("shared", [repo, other], {
    updatedAt: "2026-10-01T00:00:00.000Z",
    keepAt: "2026-10-05T00:00:00.000Z",
    lastActivityAt: "2026-11-22T00:00:00.000Z",
  });
  assert.equal(
    projectLastActivity({ project, lanes: [shared], tasks: [] }),
    "2026-10-05T00:00:00.000Z",
  );
  // Another project's lane never counts.
  const theirs = lane("theirs", [other], {
    updatedAt: "2026-11-22T00:00:00.000Z",
    lastActivityAt: "2026-11-22T00:00:00.000Z",
  });
  assert.equal(
    projectLastActivity({ project, lanes: [theirs], tasks: [] }),
    null,
  );
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
