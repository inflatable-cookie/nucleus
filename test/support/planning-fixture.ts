/**
 * A real stored Planning population for the read-view tests (nucleus#1531): projects,
 * lanes, plans, tasks, leads and a papercut written through the runtime's own store, then
 * read back through the same reads the board makes (`queue.ui-snapshot`, `queue.plans`,
 * `lane.tasks`, `lead.board`). Nothing here is a hand-built view shape.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAdapter, submission } from "./fakes";
import { Leads } from "../../core/planning/leads";
import { QueueRuntime } from "../../service/runtime-owner";
import { plans as plansContract } from "../../shared/contracts";

const HEAD = "a".repeat(40);
export const repo = (name: string) => ({
  origin: `fixture/${name}`,
  path: `/fixture/${name}`,
});

export type PlanningFixture = Awaited<ReturnType<typeof planningFixture>>;

export async function planningFixture() {
  const dir = mkdtempSync(join(tmpdir(), "nucleus-planning-read-"));
  const runtime = new QueueRuntime({
    dataDir: dir,
    timers: false,
    adapterFactory: () =>
      fakeAdapter({
        socketPath: join(dir, "callback.sock"),
        helperPath: join(dir, "worker-report.mjs"),
      }),
  });
  await runtime.started;
  const { store } = runtime;
  const roadmap = repo("roadmap"),
    idle = repo("idle"),
    dormant = repo("dormant");
  const keys = {
    roadmap: store.ensureProject(roadmap.path, roadmap.origin).key,
    idle: store.ensureProject(idle.path, idle.origin).key,
    dormant: store.ensureProject(dormant.path, dormant.origin).key,
  };
  const lane = (
    key: string,
    title: string,
    aim: string,
    repository = roadmap,
  ) => store.upsertLane({ key, title, aim, repositories: [repository] });
  lane(
    "reliability",
    "Queue reliability",
    "Queue stops stalling or misreporting work silently: every stuck state has a visible cause and an exit.",
  );
  lane(
    "host",
    "BB as a host",
    "Nucleus runs tasks in BB beside the other hosts, opt-in per repository.",
  );
  lane(
    "activities",
    "Activity types",
    "Implement the planned widget templates, New Story first.",
  );
  lane(
    "containers",
    "Native containers",
    "A native containers backend beside Docker.",
  );
  lane("board-ui", "Board UI", "The board reads as an inbox.");
  lane("benchmark", "Benchmark", "Benchmark the consumers.", idle);

  const task = (
    title: string,
    laneKey: string | string[],
    phase?: string,
    extra: Record<string, unknown> = {},
  ) => {
    const created = store.insert(
      submission({ title, repoPath: roadmap.path, lanes: [laneKey].flat() }),
      "host",
      "brief",
      HEAD,
    );
    if (phase) store.update(created.id, { phase, ...extra } as never);
    return created;
  };
  task("Spec 067 batch 2: run.start and phase.set", "reliability", "reviewing");
  task("Spec 067 batch 3: turns and merge.now", "reliability");
  task(
    "Spec 067 batch 4: escalations bound to the task version",
    "reliability",
    "blocked",
    { reason: "The reviewer asked for an operator ruling" },
  );
  task("Spec 067 batch 1: typed decision fields", "reliability", "done", {
    resumePrNumber: 416,
  });
  task("Remove the retired QA supervisor", "reliability", "done", {
    resumePrNumber: 419,
  });
  task("Sibling and callback parity for BB", "host", "done", {
    resumePrNumber: 370,
  });
  task("Retire the old board columns", "board-ui", "done", {
    resumePrNumber: 300,
  });
  // One live task in two lanes: a project total counts it once (Spec 019).
  task("Shared host and reliability probe", ["reliability", "host"], "working");
  // More finished work than the lane view's latest ten, so See all has to page past them.
  for (let index = 1; index <= 11; index++)
    task(`Host follow-up ${index}`, "host", "done", {
      resumePrNumber: 500 + index,
    });

  const leads = new Leads(store);
  leads.add({
    repositories: [roadmap],
    title: "Name the host on the lane page",
    body: "Say which host runs it.",
    lanes: ["host"],
    tags: [],
    author: "fixture",
  });
  leads.add({
    repositories: [roadmap],
    title: "Show the stuck cause on every card",
    body: "Every stuck card should say why.",
    lanes: ["reliability"],
    tags: [],
    author: "fixture",
  });

  store.keepLane({
    key: "reliability",
    reason:
      "The recovery fixes have landed, but the launch batch still needed a manual restart after the last roll.",
    author: "operator",
  });
  store.setPlan({
    project: keys.roadmap,
    version: 0,
    author: "the roadmap planner",
    entries: [
      {
        lane: "reliability",
        horizon: "now",
        note: "Spec 067 is landing in six batches: batch 1 merged, batch 2 in review.",
        doneWhen:
          "Milestone QA passes and one observed week needs no manual unsticking.",
      },
      {
        lane: "host",
        horizon: "now",
        note: "Waiting for the next real opt-in task.",
        doneWhen:
          "An opt-in task runs dispatch to closeout with no owner help.",
      },
      {
        lane: "activities",
        horizon: "next",
        note: "",
        doneWhen: "All planned widget templates ship.",
      },
      {
        lane: "containers",
        horizon: "later",
        note: "After the release. Spike first.",
      },
      { lane: "board-ui", horizon: "later" },
    ],
  });
  // A finished lane leaves the open plan and shows among its finished lanes.
  store.setLaneStatus("board-ui", "done");
  // A second save, so History has an earlier version to page back to.
  const saved = store.plan({ project: keys.roadmap });
  store.setPlan({
    project: keys.roadmap,
    version: saved.version,
    author: "the roadmap planner",
    entries: saved.entries.map((entry) =>
      entry.lane === "host"
        ? {
            ...entry,
            note: "The pilot finished. Waiting for the next real opt-in task.",
          }
        : entry,
    ),
  });
  store.setPlan({
    project: keys.idle,
    version: 0,
    author: "the idle planner",
    entries: [{ lane: "benchmark", horizon: "later" }],
    idle: "Benchmark roadmap complete. Waiting for your next direction.",
  });

  const readPlans = () => plansContract.output.parse(runtime.listPlans());
  const invoke = async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") return runtime.uiSnapshot();
    if (method === "queue.plans") return readPlans();
    if (method === "lead.board") return runtime.leadBoard();
    if (method === "lane.task-page")
      return runtime.laneTaskPage(
        input as { lane: string; offset: number; limit: number },
      );
    if (method === "lane.document.get") return null;
    if (method === "queue.detail")
      return runtime.detail(input as { taskId: string });
    if (method === "plan.get")
      return runtime.getPlan(input as { project: string; version?: number });
    if (method === "queue.outcome-search")
      return runtime.outcomeSearch(input as { lane: string });
    return [];
  };
  return {
    runtime,
    store,
    keys,
    readPlans,
    invoke,
    async close() {
      await runtime.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
