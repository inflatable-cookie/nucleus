import type * as api from "../../shared/contracts";
import type {
  RustApi,
  RustDecision,
  RustItem,
  RustLane,
  RustPlanView,
  RustProject,
} from "./rust-api";

/**
 * Planning records (Spec 070, planning model) mapped onto the board's planning
 * contracts. The engine keeps them by project; the board reads them across
 * projects. Lane and plan versions are the engine's own, so a stale edit is
 * refused by the engine's version check, never merged here.
 */

type Keys = { key: (id: string) => string; id: (key: string) => string };
type ProjectRow = { id: string; project: RustProject; board: api.Project };

const iso = (ms: number) => new Date(ms).toISOString();
const PREVIEW = 280;

/** The engine's lane disposition as the board's lane status. */
const laneStatus = {
  open: "active",
  done: "done",
  dropped: "abandoned",
} as const;

function repositories(project: RustProject) {
  return project.repositories.map((repo) => ({
    origin: repo.origin,
    path: repo.path,
  }));
}

export function boardLane(
  lane: RustLane,
  project: RustProject,
): api.LaneView | null {
  const repos = repositories(project);
  if (!repos.length || !lane.title.trim() || !lane.aim.trim()) return null;
  return {
    id: lane.key,
    key: lane.key,
    title: lane.title,
    aim: lane.aim,
    status: laneStatus[lane.status],
    note: lane.note ?? "",
    repositories: repos,
    createdAt: "",
    updatedAt: "",
    closedAt: null,
    drain: null,
    keep: null,
    liveByPhase: {},
    liveByRepository: {},
    terminalCount: 0,
    lastActivityAt: null,
    recentOutcomes: [],
  };
}

function boardPlan(key: string, plan: RustPlanView) {
  const entries = plan.lanes.map((entry) => ({
    lane: entry.key,
    note: entry.statusNote,
    horizon: entry.horizon,
    ...(entry.doneWhen ? { doneWhen: entry.doneWhen } : {}),
  }));
  return {
    project: key,
    version: plan.version,
    entries,
    author: null,
    createdAt: null,
  };
}

export function boardItem(
  item: RustItem,
  project: RustProject,
): api.BoardLead | null {
  if (item.state !== "open" && item.state !== "parked") return null;
  return {
    id: item.id,
    title: item.title,
    preview: item.body.slice(0, PREVIEW),
    repositories: repositories(project),
    lanes: item.lanes,
    tags: [],
    papercutArea: item.kind === "papercut" ? "" : null,
    state: "open",
    version: 1,
    check: null,
    approved: false,
    targets: [],
    parked:
      item.state === "parked"
        ? { reason: item.reason ?? "", revisitAt: item.revisitAt ?? null }
        : null,
    recheck: null,
  };
}

export function boardDecision(
  decision: RustDecision,
  key: string,
  project: RustProject,
): api.DecisionView {
  const primary = repositories(project)[0] ?? null;
  const answer = decision.answer;
  const chosen =
    answer && decision.options.find((option) => option.id === answer.optionId);
  const status = decision.withdrawn
    ? "withdrawn"
    : answer
      ? "answered"
      : "open";
  return {
    id: decision.id,
    version: 1,
    question: decision.question,
    choices: decision.options.map((option) => ({
      label: option.label,
      consequence: "",
    })),
    context: null,
    options: decision.options.map((option) => option.label),
    recommendation: null,
    askedBy: { agentId: decision.author, project: primary },
    links: {
      tasks: decision.task ? [decision.task.taskId] : [],
      leads: [],
      papercuts: [],
    },
    status,
    answer:
      answer && chosen
        ? {
            text: chosen.label,
            answeredBy: answer.author,
            answeredAt: iso(answer.answeredAtMs),
            relayed: null,
            note: answer.note ?? "",
          }
        : null,
    withdrawal: null,
    supersededBy: null,
    delivery: null,
    createdAt: iso(decision.createdAtMs),
    updatedAt: iso(answer?.answeredAtMs ?? decision.createdAtMs),
    versions: [],
    stale: false,
    projectKey: key,
    askerLabel: decision.author || "Planner",
  } as api.DecisionView;
}

export function createRustPlanning(rust: RustApi, keys: () => Keys) {
  async function projects(): Promise<ProjectRow[]> {
    const view = await rust.settings();
    return Object.entries(view.projects.settings.value.projects).flatMap(
      ([id, project]) => {
        if (project.archived || !project.repositories[0]) return [];
        const primary = project.repositories[0];
        return [
          {
            id,
            project,
            board: {
              key: keys().key(id),
              name: project.name,
              version: 1,
              repositories: repositories(project),
              primary: { origin: primary.origin, path: primary.path },
              drain: null,
            },
          },
        ];
      },
    );
  }

  async function laneOwner(key: string) {
    for (const row of await projects()) {
      const plan = await rust.plan(row.id);
      const lane = plan.documents.find((document) => document.key === key);
      if (lane) return { row, plan, lane };
    }
    throw new Error(`Lane ${key} is not in any project's plan.`);
  }

  async function decisionOwner(id: string) {
    for (const row of await projects()) {
      const decisions = await rust.decisions(row.id);
      const decision = decisions.find((entry) => entry.id === id);
      if (decision) return { row, decision };
    }
    throw new Error(`Decision ${id} is not in any project.`);
  }

  async function laneViews(rows: ProjectRow[]): Promise<api.LaneView[]> {
    const plans = await Promise.all(
      rows
        .filter(({ project }) => !project.archived)
        .map(async (row) => ({ row, plan: await rust.plan(row.id) })),
    );
    return plans.flatMap(({ row, plan }) =>
      plan.documents.flatMap((lane) => {
        const view = boardLane(lane, row.project);
        return view ? [view] : [];
      }),
    );
  }

  const handlers = {
    "queue.plans": async () =>
      Promise.all(
        (await projects()).map(async (row) => {
          const plan = boardPlan(row.board.key, await rust.plan(row.id));
          return { ...plan, savedEntries: plan.entries };
        }),
      ),
    "plan.get": async (input: { project?: string }) => {
      const row = (await projects()).find(
        (entry) => entry.board.key === input.project,
      );
      if (!row) throw new Error(`Project ${input.project} has no plan.`);
      return boardPlan(row.board.key, await rust.plan(row.id));
    },
    "plan.set": async (input: {
      project?: string;
      version: number;
      entries: Array<{
        lane: string;
        note: string;
        horizon: "now" | "next" | "later";
        doneWhen?: string;
      }>;
    }) => {
      const row = (await projects()).find(
        (entry) => entry.board.key === input.project,
      );
      if (!row) throw new Error(`Project ${input.project} has no plan.`);
      await rust.setPlan(row.id, {
        version: input.version,
        lanes: input.entries.map((entry) => ({
          key: entry.lane,
          horizon: entry.horizon,
          doneWhen: entry.doneWhen ?? "",
          statusNote: entry.note,
        })),
      });
      return boardPlan(row.board.key, await rust.plan(row.id));
    },
    "lane.document.get": async (input: { key: string }) => {
      const { lane } = await laneOwner(input.key);
      if (!lane.version) return null;
      return {
        key: lane.key,
        version: lane.version,
        text: lane.document,
        digest: `sha256:${"0".repeat(64)}`,
        author: "Nucleus",
        createdAt: "",
      };
    },
    "lane.document.edit": async (input: {
      key: string;
      version: number;
      text: string;
    }) => {
      const { row, lane } = await laneOwner(input.key);
      const saved = await rust.putLane(row.id, lane.key, {
        version: input.version,
        title: lane.title,
        aim: lane.aim,
        document: input.text,
      });
      return {
        key: saved.key,
        version: saved.version,
        text: saved.document,
        digest: `sha256:${"0".repeat(64)}`,
        author: "Nucleus",
        createdAt: "",
      };
    },
    "lane.status": async (input: {
      key: string;
      status: "active" | "paused" | "done" | "abandoned";
      note?: string;
    }) => {
      const { row } = await laneOwner(input.key);
      const status =
        input.status === "done"
          ? { status: "done" as const, note: input.note ?? "" }
          : input.status === "abandoned"
            ? { status: "dropped" as const, note: input.note ?? "" }
            : { status: "open" as const };
      const saved = await rust.laneStatus(row.id, input.key, status);
      const view = boardLane(saved, row.project);
      if (!view) throw new Error(`Lane ${input.key} needs a title and aim.`);
      const { liveByPhase, liveByRepository, terminalCount, lastActivityAt, recentOutcomes, ...lane } = view;
      void [liveByPhase, liveByRepository, terminalCount, lastActivityAt, recentOutcomes];
      return lane;
    },
    "lead.board": async () => {
      const rows = await projects();
      const items = await Promise.all(
        rows.map(async (row) => ({ row, items: await rust.items(row.id) })),
      );
      return {
        cards: items.flatMap(({ row, items: list }) =>
          list.flatMap((item) => {
            const card = boardItem(item, row.project);
            return card ? [card] : [];
          }),
        ),
        links: [],
      };
    },
    "decision.list": async (input: { status?: string; project?: string }) => {
      const rows = (await projects()).filter(
        (row) => !input.project || row.board.key === input.project,
      );
      const lists = await Promise.all(
        rows.map(async (row) =>
          (await rust.decisions(row.id)).map((decision) =>
            boardDecision(decision, row.board.key, row.project),
          ),
        ),
      );
      return lists
        .flat()
        .filter((decision) => !input.status || decision.status === input.status);
    },
    "decision.get": async (input: { id: string }) => {
      const { row, decision } = await decisionOwner(input.id);
      return boardDecision(decision, row.board.key, row.project);
    },
    "decision.answer": async (input: {
      id: string;
      answer: string;
      note?: string;
    }) => {
      const { row, decision } = await decisionOwner(input.id);
      const option = decision.options.find(
        (entry) => entry.label === input.answer,
      );
      if (!option) throw new Error("Choose one of the decision's options.");
      const saved = await rust.answerDecision(row.id, decision.id, {
        optionId: option.id,
        note: input.note || null,
      });
      return boardDecision(saved, row.board.key, row.project);
    },
  };

  return { handlers, laneViews };
}
