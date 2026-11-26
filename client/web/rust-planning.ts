import * as api from "../../shared/contracts";
import { z, type output } from "zod";
import { laneDocumentVersionSchema } from "../../shared/schema/lanes";
import { projectPlanSchema } from "../../shared/schema/plans";
import { decision, item, lane, plan, planView } from "./rust-api";
import { errorText } from "../error-text";
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

export function boardProject(key: string, project: RustProject): api.Project {
  const repos = repositories(project);
  return {
    key,
    name: project.name,
    version: 1,
    repositories: repos,
    primary: repos[0] ?? null,
    drain: null,
  };
}

export function boardLane(
  lane: RustLane,
  project: RustProject,
  projectKey: string,
): api.LaneView | null {
  const repos = repositories(project);
  if (!lane.title.trim() || !lane.aim.trim()) return null;
  return {
    id: lane.key,
    key: lane.key,
    project: projectKey,
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

function boardStep(entry: RustPlanView["lanes"][number]) {
  return {
    lane: entry.key,
    note: entry.statusNote,
    horizon: entry.horizon,
    ...(entry.doneWhen ? { doneWhen: entry.doneWhen } : {}),
  };
}

function boardPlan(key: string, plan: Pick<RustPlanView, "lanes" | "version">) {
  return {
    project: key,
    version: plan.version,
    entries: plan.lanes.map(boardStep),
    author: null,
    createdAt: null,
  };
}

export function boardItem(
  item: RustItem,
  project: RustProject,
  projectKey: string,
): api.BoardLead | null {
  if (item.state !== "open" && item.state !== "parked") return null;
  return {
    id: item.id,
    projectKey,
    title: item.title,
    preview: item.body.slice(0, PREVIEW),
    repositories: repositories(project, item.repositories),
    lanes: item.lanes,
    // The board tells papercuts from leads by tag (Spec 070: one surface, a type).
    tags: item.kind === "papercut" ? ["papercut"] : [],
    papercutArea: null,
    state: "open",
    version: item.version ?? 1,
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
      ...option,
      consequence: "",
    })),
    context: null,
    options: [],
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
            optionId: chosen.id,
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
  };
}

type PlanningCollection = "Plans" | "Items" | "Decisions";
type ReportPlanningIssues = (
  collection: PlanningCollection,
  issues: string[],
) => void;
const listeners = new WeakMap<RustApi, ReportPlanningIssues>();

export function listenForPlanningIssues(
  rust: RustApi,
  report: ReportPlanningIssues,
) {
  listeners.set(rust, report);
  return () => {
    listeners.delete(rust);
  };
}

const history = z.array(
  z.object({
    actor: z.string(),
    atMs: z.number().int(),
    action: z.string(),
    snapshot: z.unknown(),
  }),
);
const snapshotVersion = z.object({ version: z.number().int() });
const historySnapshot = z.object({
  note: z.string().optional(),
  disposition: z.enum(["completed", "deprecated"]).optional(),
});

async function laneRevision(
  saved: RustLane,
  author: string,
  createdAt: string,
) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(saved.document),
  );
  const hex = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    key: saved.key,
    version: saved.version,
    text: saved.document,
    digest: `sha256:${hex}`,
    author,
    createdAt,
  };
}

const rawList = z.array(z.unknown());
const rawPlan = planView.extend({ documents: rawList, lanes: rawList });
const address = z.object({
  id: z.string().optional(),
  key: z.string().optional(),
});

function recordLabel(raw: unknown, index: number) {
  const parsed = address.safeParse(raw).data;
  return parsed?.id ?? parsed?.key ?? `#${index + 1}`;
}

function collectRows<T>(
  raw: unknown[],
  label: string,
  issues: string[],
  project: (value: unknown) => T,
): T[] {
  return raw.flatMap((value, index) => {
    try {
      return [project(value)];
    } catch (error) {
      issues.push(`${label} ${recordLabel(value, index)}: ${errorText(error)}`);
      return [];
    }
  });
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
      scope = { denied: new Set() };
      scopes.set(caller, scope);
    }
    const access = scope;
    return Object.entries(view.projects.settings.value.projects).flatMap(
      ([id, project]) => {
        if (
          project.archived ||
          access.denied.has(id) ||
          (caller.planningProjects !== null &&
            !caller.planningProjects.includes(id))
        )
          return [];
        return [
          {
            id,
            project,
            scope: access,
            board: boardProject(keys().key(id), project),
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

  function planningRead<T>(
    row: ProjectRow,
    path: string,
    schema: z.ZodType<T>,
  ) {
    return readProject(row, (id) =>
      rust.board.read(schema, `/planning/${encodeURIComponent(id)}/${path}`),
    );
  }

  async function savedRevision(
    row: ProjectRow,
    kind: "plan" | "lane",
    id: string,
    version: number,
  ) {
    const records = await planningRead(
      row,
      `history/${kind}/${encodeURIComponent(id)}`,
      history,
    );
    const matches = records?.filter(
      (record) =>
        snapshotVersion.safeParse(record.snapshot).data?.version === version,
    );
    // Imports can record the normalized snapshot again. The original version
    // owns its author and timestamp. Native history is ordered by sequence;
    // later disposition changes and re-imports do not create a revision.
    const saved =
      matches?.find((record) => record.action === "legacy_version") ??
      matches?.[0];
    if (!saved)
      throw new Error(`Version ${version} of ${kind} ${id} is unavailable.`);
    return saved;
  }

  // Publish diagnostics with the read that produced them. A late read from
  // an older pairing or an earlier refresh cannot replace the current notice.
  const latestRead = new Map<PlanningCollection, symbol>();
  async function collectProjects<T>(
    collection: PlanningCollection,
    read: (row: ProjectRow, issues: string[]) => Promise<T[]>,
  ) {
    const ticket = Symbol();
    latestRead.set(collection, ticket);
    const [rows, caller] = await Promise.all([projects(), session()]);
    const results = await Promise.all(
      rows.map(async (row) => {
        const issues: string[] = [];
        try {
          return { values: await read(row, issues), issues };
        } catch (error) {
          if (isRustHttpError(error, 401)) throw error;
          issues.push(`${row.id} ${collection}: ${errorText(error)}`);
          return { values: [], issues };
        }
      }),
    );
    if (latestRead.get(collection) === ticket && caller === (await session()))
      listeners.get(rust)?.(
        collection,
        results.flatMap((result) => result.issues),
      );
    return results.flatMap((result) => result.values);
  }

  async function findRecord<T>(
    row: ProjectRow,
    path: string,
    schema: z.ZodType<T>,
    id: string,
  ) {
    const records = await planningRead(row, path, rawList);
    const raw = records?.find(
      (record) => address.safeParse(record).data?.id === id,
    );
    return raw === undefined ? undefined : schema.parse(raw);
  }

  async function projectLane(project: string, key: string) {
    const row = (await projects()).find((entry) => entry.board.key === project);
    if (!row) throw new Error(`Project ${project} has no accessible plan.`);
    const plan = await planningRead(row, "plan", rawPlan);
    const raw = plan?.documents.find(
      (document) => address.safeParse(document).data?.key === key,
    );
    if (raw === undefined)
      throw new Error(
        `Lane ${key} is not in project ${project}'s accessible plan.`,
      );
    return { row, lane: lane.parse(raw) };
  }

  async function recordOwner<T>(
    path: string,
    schema: z.ZodType<T>,
    id: string,
    project?: string,
    matches?: (record: T) => boolean,
  ) {
    let match: { row: ProjectRow; record: T } | undefined;
    for (const row of await projects()) {
      if (project !== undefined && row.board.key !== project) continue;
      const record = await findRecord(row, path, schema, id);
      if (record === undefined || (matches && !matches(record))) continue;
      if (match) throw new Error(`Record ${id} is ambiguous across projects.`);
      match = { row, record };
    }
    if (!match)
      throw new Error(`Could not identify ${id} in the accessible projects.`);
    return match;
  }

  /** An item action addresses the project the view opened it from. */
  function itemOwner(input: { id: string; project: string }) {
    return recordOwner("items", item, input.id, input.project);
  }

  /** The item read back after a write: park and drop answer without its version. */
  async function savedItem(row: ProjectRow, id: string) {
    const record = await findRecord(row, "items", item, id);
    if (!record) throw new Error(`Item ${id} is no longer in ${row.project.name}.`);
    return record;
  }

  /** The item as the detail view reads it, with its history. */
  async function itemDetail(row: ProjectRow, record: RustItem): Promise<api.ItemDetail> {
    const records = await planningRead(row, `history/item/${encodeURIComponent(record.id)}`, history);
    if (record.version === undefined)
      throw new Error("The engine did not supply the item version.");
    const bound = new Set(
      row.project.repositories
        .filter((repo) => repo.hostProject)
        .map((repo) => repo.origin.toLowerCase()),
    );
    return {
      id: record.id,
      kind: record.kind,
      projectKey: row.board.key,
      projectName: row.project.name,
      title: record.title,
      body: record.body,
      lanes: record.lanes,
      repositories: repositories(row.project, record.repositories).map((repo) => ({
        origin: repo.origin,
        bound: bound.has(repo.origin.toLowerCase()),
      })),
      author: record.author,
      state: record.state,
      reason: record.reason ?? null,
      disposition: record.state === "dropped" ? (record.disposition ?? "deprecated") : null,
      briefComplexity: record.kind === "lead" ? (record.complexity ?? null) : null,
      revisitAt: record.state === "parked" ? (record.revisitAt ?? null) : null,
      taskId: record.state === "promoted" ? (record.taskId ?? null) : null,
      version: record.version,
      createdAtMs: record.createdAtMs ?? null,
      updatedAtMs: record.updatedAtMs ?? null,
      history: (records ?? []).map((entry) => {
        const snapshot = historySnapshot.safeParse(entry.snapshot).data;
        return {
          actor: entry.actor,
          atMs: entry.atMs,
          action: entry.action,
          note: snapshot?.note ?? null,
          disposition:
            entry.action === "drop" ? (snapshot?.disposition ?? "deprecated") : null,
        };
      }),
    };
  }

  const handlers = {
    "queue.plans": () =>
      collectProjects("Plans", async (row, issues) => {
        const raw = await planningRead(row, "plan", z.unknown());
        if (raw === undefined) return [];
        try {
          const plan = rawPlan.parse(raw);
          // The saved order is one versioned record. Editing a partial order
          // could erase a step, so withhold that project's plan if a step fails.
          const entries = collectRows(
            plan.lanes,
            `${row.id} plan step`,
            issues,
            (value) => {
              const step = planView.shape.lanes.element.parse(value);
              return api.planEntrySchema.parse(boardStep(step));
            },
          );
          if (entries.length !== plan.lanes.length) return [];
          const laneViews = collectRows(
            plan.documents,
            `${row.id} lane`,
            issues,
            (value) =>
              api.laneViewSchema.parse(
                boardLane(lane.parse(value), row.project, row.board.key),
              ),
          );
          return [
            api.planningPlanSnapshotSchema.parse({
              project: row.board.key,
              version: plan.version,
              entries,
              savedEntries: entries,
              author: null,
              createdAt: null,
              laneViews,
            }),
          ];
        } catch (error) {
          issues.push(`${row.id} plan: ${errorText(error)}`);
          return [];
        }
      }),
    "plan.get": async (input: { project?: string; version?: number }) => {
      const row = (await projects()).find(
        (entry) => entry.board.key === input.project,
      );
      if (!row) throw new Error(`Project ${input.project} has no plan.`);
      if (input.version !== undefined) {
        const saved = await savedRevision(row, "plan", row.id, input.version);
        if (saved.action === "legacy_version") {
          return {
            ...projectPlanSchema.parse(saved.snapshot),
            project: row.board.key,
          };
        }
        return {
          ...boardPlan(row.board.key, plan.parse(saved.snapshot)),
          author: saved.actor,
          createdAt: iso(saved.atMs),
        };
      }
      const current = await readProject(row, rust.plan);
      if (!current)
        throw new Error(`Project ${input.project} has no accessible plan.`);
      return boardPlan(row.board.key, current);
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
    "lane.document.get": async (input: {
      key: string;
      project: string;
      version?: number;
    }) => {
      if (input.version !== undefined) {
        const row = (await projects()).find(
          (entry) => entry.board.key === input.project,
        );
        if (!row)
          throw new Error(`Project ${input.project} has no accessible plan.`);
        const saved = await savedRevision(
          row,
          "lane",
          input.key,
          input.version,
        );
        const document =
          saved.action === "legacy_version"
            ? laneDocumentVersionSchema.parse(saved.snapshot)
            : await laneRevision(
                lane.parse(saved.snapshot),
                saved.actor,
                iso(saved.atMs),
              );
        if (document.key !== input.key)
          throw new Error("The saved lane key differs.");
        return document;
      }
      const { lane: current } = await projectLane(input.project, input.key);
      return current.version ? laneRevision(current, "Nucleus", "") : null;
    },
    "lane.document.edit": async (input: {
      key: string;
      project: string;
      version: number;
      text: string;
    }) => {
      const { row, lane } = await projectLane(input.project, input.key);
      const saved = await rust.putLane(row.id, lane.key, {
        version: input.version,
        title: lane.title,
        aim: lane.aim,
        document: input.text,
      });
      return laneRevision(saved, "Nucleus", "");
    },
    "lane.status": async (input: {
      key: string;
      project: string;
      status: "active" | "paused" | "done" | "abandoned";
      note?: string;
    }) => {
      const { row } = await projectLane(input.project, input.key);
      if (input.status === "paused")
        throw new Error("This engine supports Open, Done and Abandon.");
      const status =
        input.status === "done"
          ? { status: "done" as const, note: input.note ?? "" }
          : input.status === "abandoned"
            ? { status: "dropped" as const, note: input.note ?? "" }
            : { status: "open" as const };
      const saved = await rust.laneStatus(row.id, input.key, status);
      const view = boardLane(saved, row.project, row.board.key);
      if (!view) throw new Error(`Lane ${input.key} needs a title and aim.`);
      const {
        project,
        liveByPhase,
        liveByRepository,
        terminalCount,
        lastActivityAt,
        recentOutcomes,
        ...lane
      } = view;
      void [
        project,
        liveByPhase,
        liveByRepository,
        terminalCount,
        lastActivityAt,
        recentOutcomes,
      ];
      return lane;
    },
    "lead.board": async () => {
      const items = await collectProjects("Items", async (row, issues) => {
        const raw = await planningRead(row, "items", rawList);
        return collectRows(raw ?? [], `${row.id} item`, issues, (value) => {
          const record = item.parse(value);
          const card = boardItem(record, row.project, row.board.key);
          const at = record.updatedAtMs ?? record.createdAtMs;
          return {
            card: card && api.boardLeadSchema.parse(card),
            activity: {
              project: row.board.key,
              id: record.id,
              at: at == null ? null : iso(at),
              taskIds: [
                ...new Set([
                  ...(record.taskLinks ?? []),
                  ...(record.taskId ? [record.taskId] : []),
                ]),
              ],
            },
          };
        });
      });
      return {
        cards: items.flatMap(({ card }) => (card ? [card] : [])),
        activity: items.map(({ activity }) => activity),
        links: [],
      };
    },
    "decision.list": (input: { status?: string; project?: string }) =>
      collectProjects("Decisions", async (row, issues) => {
        if (input.project && input.project !== row.board.key) return [];
        const raw = await planningRead(
          row,
          input.status === "open" ? "decisions?pending=true" : "decisions",
          rawList,
        );
        return collectRows(raw ?? [], `${row.id} decision`, issues, (value) =>
          api.decisionViewSchema.parse(
            boardDecision(decision.parse(value), row.board.key, row.project),
          ),
        ).filter((view) => !input.status || view.status === input.status);
      }),
    "decision.get": async (input: { id: string; project?: string }) => {
      const { row, record } = await recordOwner(
        "decisions",
        decision,
        input.id,
        input.project,
      );
      return boardDecision(record, row.board.key, row.project);
    },
    "decision.answer": async (input: {
      id: string;
      project?: string;
      optionId?: string;
      note?: string;
    }) => {
      const { row, record } = await recordOwner(
        "decisions",
        decision,
        input.id,
        input.project,
      );
      const { optionId } = input;
      if (!optionId || !record.options.some((option) => option.id === optionId))
        throw new Error("Choose one of the decision's options.");
      const saved = await rust.answerDecision(row.id, record.id, {
        optionId,
        note: input.note || null,
      });
      return boardDecision(saved, row.board.key, row.project);
    },
    "item.closed": async (input: { kind: "lead" | "papercut" }) => {
      const closed = await collectProjects("Items", async (row, issues) => {
        const raw = await planningRead(row, "items", rawList);
        return collectRows(raw ?? [], `${row.id} item`, issues, (value) => item.parse(value)).flatMap(
          (record): api.ClosedItem[] =>
            record.kind === input.kind && (record.state === "promoted" || record.state === "dropped")
              ? [
                  {
                    id: record.id,
                    kind: record.kind,
                    projectKey: row.board.key,
                    projectName: row.project.name,
                    title: record.title,
                    state: record.state,
                    disposition: record.state === "dropped" ? (record.disposition ?? "deprecated") : null,
                    atMs: record.updatedAtMs ?? record.createdAtMs ?? null,
                  },
                ]
              : [],
        );
      });
      return closed.sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0));
    },
    "item.get": async (input: { project?: string; id: string }) => {
      const { row, record } = await recordOwner("items", item, input.id, input.project);
      return itemDetail(row, record);
    },
    "item.edit": async (input: output<typeof api.itemEdit.input>) => {
      const { row, record } = await itemOwner(input);
      await rust.editItem(row.id, record.id, {
        version: input.version,
        title: input.title,
        body: input.body,
        lanes: record.lanes,
      });
      return itemDetail(row, await savedItem(row, record.id));
    },
    "item.park": async (input: output<typeof api.itemPark.input>) => {
      const { row, record } = await itemOwner(input);
      await rust.parkItem(row.id, record.id, {
        reason: input.reason,
        revisitAt: input.revisitAt,
      });
      return itemDetail(row, await savedItem(row, record.id));
    },
    "item.drop": async (input: output<typeof api.itemDrop.input>) => {
      const { row, record } = await itemOwner(input);
      await rust.dropItem(
        row.id,
        record.id,
        input.note || null,
        input.disposition,
      );
      return itemDetail(row, await savedItem(row, record.id));
    },
    "item.reopen": async (input: output<typeof api.itemReopen.input>) => {
      const { row, record } = await itemOwner(input);
      await rust.reopenItem(row.id, record.id, { version: input.version });
      return itemDetail(row, await savedItem(row, record.id));
    },
    "item.promote": async (input: output<typeof api.itemPromote.input>) => {
      const { row, record } = await itemOwner(input);
      // One engine operation: it refuses an item past the version the view showed, and a
      // lead's chosen level is written into its brief only together with the admitted task.
      const task = await rust.promoteItem(row.id, record.id, {
        repository: input.repository,
        complexity: input.complexity,
        version: input.version,
      });
      return { taskId: task.identity.id, reference: task.reference };
    },
  };

  return { handlers };
}
