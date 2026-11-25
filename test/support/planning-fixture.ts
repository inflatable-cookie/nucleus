import {
  laneTaskPage,
  laneViewSchema,
  leadBoard,
  outcomeSearch,
  planGet,
  plans,
  taskSummarySchema,
  uiSnapshot,
  type LaneUpsertInput,
  type LaneView,
  type ProjectPlan,
  type TaskSummary,
} from "../../shared/contracts";
import { recentProjectActivity } from "./project-activity";

const projectNames = { roadmap: "roadmap", idle: "idle", dormant: "dormant" };
const repo = (name: string) => ({ origin: `fixture/${name}`, path: `/fixture/${name}` });
const roadmap = repo(projectNames.roadmap);
const idle = repo(projectNames.idle);
const projects = Object.values(projectNames).map((name) => ({
  key: name,
  name,
  version: 1,
  primary: repo(name),
  repositories: [repo(name)],
}));

/** Contract-shaped RPC replies for Planning's read views. */
export function planningFixture() {
  const at = new Date().toISOString();
  const liveTask = (
    number: number,
    title: string,
    phase: TaskSummary["phase"],
    lanes: string[],
    reason = "Waiting for dispatch",
  ) => taskSummarySchema.parse({
    id: `task-${number}`,
    number,
    reference: `roadmap#${String(number).padStart(3, "0")}`,
    title,
    repoPath: roadmap.path,
    hostId: "host",
    version: 1,
    updatedAt: at,
    entrypoint: "worker",
    phase,
    reason,
    held: false,
    parked: false,
    dependsOn: [],
    queuePriority: 0,
    lanes,
    resolution: {},
  });
  // One live task in two lanes is counted once by the project's summary.
  const tasks = [
    liveTask(8, "Shared host and reliability probe", "working", ["reliability", "host"]),
    liveTask(3, "Spec 067 batch 4: escalations bound to the task version", "blocked", ["reliability"], "The reviewer asked for an operator ruling"),
    liveTask(2, "Spec 067 batch 3: turns and merge.now", "queued", ["reliability"]),
    liveTask(1, "Spec 067 batch 2: run.start and phase.set", "reviewing", ["reliability"]),
  ];

  const finished = (title: string, lane: string, prNumber: number | null) => ({
    taskId: `finished-${title}`,
    reference: null,
    title,
    repository: roadmap.path,
    outcome: prNumber === null ? "cancelled" as const : "done" as const,
    lanes: [lane],
    prNumber,
    prUrl: null,
    mergeCommit: null,
    finishedAt: at,
    backfilled: false,
    replacementTaskId: null,
    excerpt: null,
  });
  const outcomes = [
    finished("Abandoned host probe", "host", null),
    ...Array.from({ length: 11 }, (_, offset) => {
      const number = 11 - offset;
      return finished(`Host follow-up ${number}`, "host", 500 + number);
    }),
    finished("Sibling and callback parity for BB", "host", 370),
    finished("Remove the retired QA supervisor", "reliability", 419),
    finished("Spec 067 batch 1: typed decision fields", "reliability", 416),
    finished("Retire the old board columns", "board-ui", 300),
  ];
  const lane = (input: LaneUpsertInput, facts: Partial<LaneView> = {}) =>
    laneViewSchema.parse({
      id: input.key,
      status: "active",
      createdAt: at,
      updatedAt: at,
      lastActivityAt: at,
      liveByPhase: {},
      liveByRepository: {},
      terminalCount: 0,
      ...input,
      ...facts,
    });
  const fixtureLane = (key: string, title: string, aim: string, facts: Partial<LaneView> = {}) => {
    const recentlyFinished = outcomes.filter((outcome) => outcome.lanes.includes(key));
    return lane({ key, title, aim, repositories: [roadmap] }, {
      terminalCount: recentlyFinished.length,
      recentOutcomes: recentlyFinished.slice(0, 10).map(({ taskId, title, outcome, prUrl, prNumber, finishedAt }) =>
        ({ taskId, title, outcome, prUrl, prNumber, finishedAt })),
      ...facts,
    });
  };
  const lanes = [
    fixtureLane("reliability", "Queue reliability", "Queue stops stalling or misreporting work silently: every stuck state has a visible cause and an exit.", {
      liveByPhase: { reviewing: 1, blocked: 1, working: 1, queued: 1 },
      liveByRepository: { [roadmap.path]: 4 },
      keep: {
        at,
        by: "operator",
        reason: "The recovery fixes have landed, but the launch batch still needed a manual restart after the last roll.",
      },
    }),
    fixtureLane("host", "BB as a host", "Nucleus runs tasks in BB beside the other hosts, opt-in per repository.", {
      liveByPhase: { working: 1 },
      liveByRepository: { [roadmap.path]: 1 },
    }),
    fixtureLane("activities", "Activity types", "Implement the planned widget templates, New Story first."),
    fixtureLane("containers", "Native containers", "A native containers backend beside Docker."),
    fixtureLane("board-ui", "Board UI", "The board reads as an inbox.", { status: "done", closedAt: at }),
    fixtureLane("spike", "Containers spike", "Decide go or no-go on native containers.", { status: "done", closedAt: at }),
    lane({ key: "benchmark", title: "Benchmark", aim: "Benchmark the consumers.", repositories: [idle] }),
  ];

  const firstEntries: ProjectPlan["entries"] = [
    {
      lane: "reliability",
      horizon: "now",
      note: "Spec 067 is landing in six batches: batch 1 merged, batch 2 in review.",
      doneWhen: "Milestone QA passes and one observed week needs no manual unsticking.",
    },
    {
      lane: "host",
      horizon: "now",
      note: "Waiting for the next real opt-in task.",
      doneWhen: "An opt-in task runs dispatch to closeout with no owner help.",
    },
    { lane: "activities", horizon: "next", note: "", doneWhen: "All planned widget templates ship." },
    { lane: "containers", horizon: "later", note: "After the release. Spike first." },
    { lane: "board-ui", horizon: "later", note: "" },
    { lane: "spike", horizon: "later", note: "Two days, then decide.", doneWhen: "The spike says go or no-go." },
  ];
  const savedEntries = firstEntries.filter(({ lane }) => lane !== "board-ui").map((entry) =>
    entry.lane === "host"
      ? { ...entry, note: "The pilot finished. Waiting for the next real opt-in task." }
      : entry);
  const secondSave = { project: projectNames.roadmap, author: "the roadmap planner", createdAt: at, version: 2, entries: savedEntries };
  const idleEntries: ProjectPlan["entries"] = [{ lane: "benchmark", horizon: "later", note: "" }];
  const planReplies = plans.output.parse([
    {
      ...secondSave,
      entries: savedEntries.filter(({ lane }) => lane !== "spike"),
      savedEntries,
      done: [firstEntries[5], firstEntries[4]].map((entry) => ({ ...entry, status: "done", closedAt: at })),
    },
    {
      project: projectNames.idle,
      version: 1,
      author: "the idle planner",
      createdAt: at,
      entries: idleEntries,
      savedEntries: idleEntries,
      idle: { reason: "Benchmark roadmap complete. Waiting for your next direction.", at },
    },
    { project: projectNames.dormant, version: 0, createdAt: null, author: null, entries: [], savedEntries: [] },
  ]);

  const lead = (id: string, title: string, preview: string, lane: string) => ({
    id,
    title,
    preview,
    repositories: [roadmap],
    lanes: [lane],
    tags: [],
    papercutArea: null,
    state: "open",
    version: 1,
    check: null,
    approved: false,
    targets: [],
    createdAt: at,
    updatedAt: at,
    parked: null,
    recheck: null,
  });
  const leadReplies = leadBoard.output.parse({
    cards: [
      lead("lead-host", "Name the host on the lane page", "Say which host runs it.", "host"),
      lead("lead-reliability", "Show the stuck cause on every card", "Every stuck card should say why.", "reliability"),
    ],
    links: [],
  });
  const projectActivity = [
    ...recentProjectActivity([projects[0]], at).map((row) => ({ ...row, lastAt: at })),
    { key: projectNames.idle, items: [], lastAt: null },
    { key: projectNames.dormant, items: [], lastAt: null },
  ];

  return {
    projectNames,
    addLane(input: LaneUpsertInput) {
      lanes.push(lane(input));
    },
    invoke: async (method: string, input: unknown) => {
      if (method === "queue.ui-snapshot") return uiSnapshot.output.parse({
        revision: 1,
        connected: true,
        hostId: "host",
        paused: false,
        error: "",
        quiet: true,
        activeWorkers: 0,
        unsettled: 0,
        globalLimit: 32,
        projectLimit: 5,
        tasks,
        profiles: [],
        pool: [],
        availability: [],
        assignments: {},
        recentAssignments: {},
        projects,
        projectActivity,
        lanes,
      });
      if (method === "queue.plans") return planReplies;
      if (method === "lead.board") return leadReplies;
      if (method === "lane.task-page") {
        const { lane, offset, limit } = laneTaskPage.input.parse(input);
        const matching = tasks.filter(({ lanes }) => lanes.includes(lane));
        return laneTaskPage.output.parse({
          tasks: matching.slice(offset, offset + limit),
          total: matching.length,
          nextOffset: offset + limit < matching.length ? offset + limit : null,
        });
      }
      if (method === "lane.document.get") return null;
      if (method === "plan.get") {
        const { version } = planGet.input.parse(input);
        return planGet.output.parse(version === 1
          ? { ...secondSave, version: 1, entries: firstEntries }
          : secondSave);
      }
      if (method === "queue.outcome-search") {
        const { lane, outcome: kind = "done" } = outcomeSearch.input.parse(input);
        const results = outcomes.filter((outcome) =>
          outcome.lanes.includes(lane ?? "") && (kind === "any" || outcome.outcome === kind));
        return outcomeSearch.output.parse({ results, cursor: null, hasMore: false });
      }
      return [];
    },
  };
}
