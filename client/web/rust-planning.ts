import type * as api from "../../shared/contracts";
import type {
  RustApi,
  RustAllSettings,
  RustBrowserSession,
  RustDecision,
  RustItem,
  RustLane,
  RustPlanView,
  RustProject,
} from "./rust-api";
import { isRustHttpError } from "./rust-board";

/**
 * Planning records (Spec 070, planning model) mapped onto the board's planning
 * contracts. The engine keeps them by project; the board reads them across
 * projects. Lane and plan versions are the engine's own, so a stale edit is
 * refused by the engine's version check, never merged here.
 */

type Keys = { key: (id: string) => string; id: (key: string) => string };
type PlanningScope = {
  denied: Set<string>;
  laneProjects: Map<string, string>;
};
type ProjectRow = {
  id: string;
  project: RustProject;
  board: api.Project;
  scope: PlanningScope;
};

const iso = (ms: number) => new Date(ms).toISOString();
const PREVIEW = 280;

/** The engine's lane disposition as the board's lane status. */
const laneStatus = {
  open: "active",
  done: "done",
  dropped: "abandoned",
} as const;

function repositories(project: RustProject, members?: readonly string[]) {
  const all = project.repositories.map((repo) => ({
    origin: repo.origin,
    path: repo.path,
  }));
  if (!members?.length) return all;
  const wanted = new Set(members.map((origin) => origin.toLowerCase()));
  const chosen = all.filter((repo) => wanted.has(repo.origin.toLowerCase()));
  return chosen.length ? chosen : all;
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
    repositories: repositories(project, item.repositories),
    lanes: item.lanes,
    // The board tells papercuts from leads by tag (Spec 070: one surface, a type).
    tags: item.kind === "papercut" ? ["papercut"] : [],
    papercutArea: null,
    state: "open",
    version: 1,
    check: null,
    approved: false,
    targets: [],
    createdAt: item.createdAtMs == null ? undefined : iso(item.createdAtMs),
    updatedAt: item.updatedAtMs == null ? undefined : iso(item.updatedAtMs),
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


const RUST_ONLY = "Not part of the Rust engine (Spec 070 planning model).";

/** A Rust item as the board's lead record. Both kinds keep their names (ruling 12). */
export function boardLeadRecord(item: RustItem, project: RustProject) {
  const repos = repositories(project, item.repositories);
  const base = project.repositories[0]?.base ?? "main";
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    repositories: repos,
    lanes: item.lanes,
    tags: item.kind === "papercut" ? ["papercut"] : [],
    papercut: null,
    closure: null,
    author: item.author || "Nucleus",
    state:
      item.state === "promoted"
        ? ("promoted" as const)
        : item.state === "dropped"
          ? ("dropped" as const)
          : ("open" as const),
    version: 1,
    check: null,
    checkOperationId: null,
    approval: null,
    baseBranch: base,
    dropReason: item.state === "dropped" ? (item.reason ?? null) : null,
    reopens: [],
    parked:
      item.state === "parked"
        ? { reason: item.reason || "Parked", revisitAt: item.revisitAt ?? null, by: item.author || "Nucleus", at: "" }
        : null,
    recheck: null,
    targets:
      item.state === "promoted" && item.taskId
        ? [{ kind: "task" as const, repository: repos[0]?.origin ?? null, reference: item.taskId, at: "" }]
        : [],
    source: null,
    createdAt: item.createdAtMs == null ? "" : iso(item.createdAtMs),
    updatedAt: item.updatedAtMs == null ? "" : iso(item.updatedAtMs),
    closedAt: null,
  };
}

function leadDetail(item: RustItem, project: RustProject) {
  const open = item.state === "open";
  return {
    ...boardLeadRecord(item, project),
    actions: {
      check: RUST_ONLY,
      approve: RUST_ONLY,
      drop: open || item.state === "parked" ? null : "Only an open item can be dropped.",
      reopen: RUST_ONLY,
      park: open ? null : "Only an open item can be parked.",
      unpark: RUST_ONLY,
      promoteTo: RUST_ONLY,
      promote: repositories(project, item.repositories).map((repo) => ({
        origin: repo.origin,
        reason: open ? null : "Only an open item can be promoted.",
      })),
    },
    versions: [],
    promotedTaskId: item.state === "promoted" ? (item.taskId ?? null) : null,
  };
}

function boardPapercut(item: RustItem, project: RustProject) {
  const repo = repositories(project, item.repositories)[0]!;
  return {
    id: item.id,
    repository: repo,
    area: null,
    title: item.title,
    happened: item.body,
    impact: "",
    fix: null,
    filedBy: item.author || "Nucleus",
    filedAt: "",
    state:
      item.state === "promoted"
        ? ("promoted" as const)
        : item.state === "dropped"
          ? ("closed" as const)
          : ("open" as const),
    version: 1,
    taskId: item.state === "promoted" ? (item.taskId ?? null) : null,
    closedReason: item.state === "dropped" ? ("deprecated" as const) : null,
    draftId: null,
    note: item.state === "dropped" ? (item.reason ?? null) : null,
    closedAt: null,
    source: null,
    lanes: item.lanes,
    parked:
      item.state === "parked"
        ? { reason: item.reason || "Parked", revisitAt: item.revisitAt ?? null, by: item.author || "Nucleus", at: "" }
        : null,
  };
}

export function createRustPlanning(
  rust: RustApi,
  settings: () => Promise<RustAllSettings>,
  keys: () => Keys,
  session: () => Promise<RustBrowserSession>,
) {
  // A read may finish after a new pairing. Its result belongs to the old session.
  const scopes = new WeakMap<RustBrowserSession, PlanningScope>();

  async function projects(): Promise<ProjectRow[]> {
    const [caller, view] = await Promise.all([session(), settings()]);
    let scope = scopes.get(caller);
    if (!scope) {
      scope = { denied: new Set(), laneProjects: new Map() };
      scopes.set(caller, scope);
    }
    const access = scope;
    return Object.entries(view.projects.settings.value.projects).flatMap(
      ([id, project]) => {
        if (
          project.archived ||
          !project.repositories[0] ||
          access.denied.has(id) ||
          (caller.planningProjects !== null && !caller.planningProjects.includes(id))
        ) return [];
        const primary = project.repositories[0];
        return [
          {
            id,
            project,
            scope: access,
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

  async function readProject<T>(
    { id, scope }: ProjectRow,
    read: (id: string) => Promise<T>,
  ) {
    if (scope.denied.has(id)) return undefined;
    try {
      return await read(id);
    } catch (error) {
      if (!isRustHttpError(error, 403)) throw error;
      scope.denied.add(id);
      return undefined;
    }
  }

  async function laneOwner(key: string) {
    const rows = await projects();
    for (const row of rows) {
      const owner = row.scope.laneProjects.get(key);
      if (owner && row.id !== owner) continue;
      const plan = await readProject(row, rust.plan);
      const lane = plan?.documents.find((document) => document.key === key);
      if (lane) return { row, lane };
    }
    throw new Error(`Lane ${key} is not in any project's plan.`);
  }

  async function decisionOwner(id: string) {
    for (const row of await projects()) {
      const decisions = await readProject(row, rust.decisions);
      const decision = decisions?.find((entry) => entry.id === id);
      if (decision) return { row, decision };
    }
    throw new Error(`Decision ${id} is not in any project.`);
  }

  async function itemOwner(id: string) {
    for (const row of await projects()) {
      const items = await readProject(row, rust.items);
      const item = items?.find((entry) => entry.id === id);
      if (item) return { row, item };
    }
    throw new Error(`${id} is not in any project.`);
  }

  async function promote(input: { id: string; complexity?: api.CapabilityLevel }) {
    const { row } = await itemOwner(input.id);
    const task = await rust.promoteItem(row.id, input.id, input.complexity);
    return { taskId: task.identity.id, reference: String((task as { identity: { reference?: string } }).identity.reference ?? task.identity.id) };
  }

  const handlers = {
    "queue.plans": async () => {
      const rows = await projects();
      const plans = await Promise.all(
        rows.map(async (row) => ({ row, current: await readProject(row, rust.plan) })),
      );
      return plans.flatMap(({ row, current }) => {
        if (!current) return [];
        const plan = boardPlan(row.board.key, current);
        const laneViews = current.documents.flatMap((lane) => {
          const view = boardLane(lane, row.project);
          if (!view) return [];
          if (!row.scope.laneProjects.has(lane.key)) row.scope.laneProjects.set(lane.key, row.id);
          return [view];
        });
        return [{ ...plan, savedEntries: plan.entries, laneViews }];
      });
    },
    "plan.get": async (input: { project?: string }) => {
      const row = (await projects()).find(
        (entry) => entry.board.key === input.project,
      );
      if (!row) throw new Error(`Project ${input.project} has no plan.`);
      const plan = await readProject(row, rust.plan);
      if (!plan) throw new Error(`Project ${input.project} has no accessible plan.`);
      return boardPlan(row.board.key, plan);
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
        rows.map(async (row) => ({ row, items: await readProject(row, rust.items) ?? [] })),
      );
      return {
        cards: items.flatMap(({ row, items: list }) =>
          list.flatMap((item) => {
            const card = boardItem(item, row.project);
            return card ? [card] : [];
          }),
        ),
        activity: items.flatMap(({ row, items: list }) => list.map(item => {
          const at = item.updatedAtMs ?? item.createdAtMs;
          return {
            project: row.board.key, id: item.id, at: at == null ? null : iso(at),
            taskIds: [...new Set([...(item.taskLinks ?? []), ...(item.taskId ? [item.taskId] : [])])],
          };
        })),
        links: [],
      };
    },
    "decision.list": async (input: { status?: string; project?: string }) => {
      const rows = (await projects()).filter(
        (row) => !input.project || row.board.key === input.project,
      );
      const lists = await Promise.all(
        rows.map(async (row) =>
          (await readProject(row, rust.decisions) ?? []).map((decision) =>
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
    "lead.get": async (input: { id: string }) => {
      const { row, item } = await itemOwner(input.id);
      return leadDetail(item, row.project);
    },
    "papercut.get": async (input: { id: string }) => {
      const { row, item } = await itemOwner(input.id);
      return boardPapercut(item, row.project);
    },
    "lead.promote-task": promote,
    "papercut.promote-task": promote,
    "lead.park": async (input: { id: string; reason: string; revisitAt?: string | null }) => {
      const { row } = await itemOwner(input.id);
      const item = await rust.parkItem(row.id, input.id, { reason: input.reason, revisitAt: input.revisitAt ?? null });
      return boardLeadRecord(item, row.project);
    },
    "lead.drop": async (input: { id: string; reason: string }) => {
      const { row } = await itemOwner(input.id);
      const item = await rust.dropItem(row.id, input.id, input.reason);
      return boardLeadRecord(item, row.project);
    },
    "papercut.close": async (input: { id: string; note?: string }) => {
      const { row } = await itemOwner(input.id);
      const item = await rust.dropItem(row.id, input.id, input.note || null);
      return boardPapercut(item, row.project);
    },
  };

  return { handlers };
}
