import type {
  BoardLead,
  BoardLeadLink,
  DecisionView,
  PendingSubmission,
  Project,
  TaskSummary,
} from "./contracts";
import { effectiveSelection } from "./project-scope";
import { taskAttention } from "./task-attention";

/** Spec 026 Board columns as of 87555f7: Attention sits before Queued so it is
 * visible without scrolling when the view opens. Spec 032 adds the Decisions
 * column ahead of Attention for agent decisions and Queue-raised prompts. */
export const pipelineColumns = [
  "Triage",
  "Decisions",
  "Attention",
  "Queued",
  "Working",
  "Review",
  "Closing",
] as const;
export type PipelineColumn = (typeof pipelineColumns)[number];
export type PipelineCard =
  | { kind: "lead"; id: string; lanes: string[]; value: BoardLead }
  | {
      kind: "submission";
      id: string;
      lanes: string[];
      value: PendingSubmission;
    }
  | { kind: "decision"; id: string; lanes: string[]; value: DecisionView }
  | { kind: "raised"; id: string; lanes: string[]; value: TaskSummary }
  /** Tom, 2026-11-01: a milestone QA run is its own card, not a task. It carries no lanes. */
  | { kind: "task"; id: string; lanes: string[]; value: TaskSummary };

/** Spec 032: a decision card's age, coarse on purpose — the board never
 * re-renders on the minute, so the label avoids minutes-level precision. */
export function decisionAge(
  createdAt: string,
  now: number = Date.now(),
): string {
  return relativeAge(Date.parse(createdAt), now);
}

/** The same coarse age from epoch milliseconds, for records that carry numeric times. */
export function relativeAge(atMs: number, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - atMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

/** The board's one set of columns: each card once, with per-column totals of the cards loaded. */
export type PipelineBoard = {
  counts: Record<PipelineColumn, number>;
  cards: Record<PipelineColumn, PipelineCard[]>;
};

/** Triage pages (Tom, 2026-11-07; 25 since 2026-11-22): a column shows one page of cards, then an "…and N more" card loads the next. */
export const triagePageSize = 25;
export function triagePage<T>(
  cards: T[],
  shown: number,
): { visible: T[]; hidden: number } {
  return {
    visible: cards.slice(0, shown),
    hidden: Math.max(0, cards.length - shown),
  };
}

/** A Triage card's kind: a lead tagged papercut is a papercut (Spec 024, Spec 026). */
export function triageKind(lead: Pick<BoardLead, "tags">): "papercut" | "lead" {
  return lead.tags.includes("papercut") ? "papercut" : "lead";
}

/**
 * A lead's or papercut's row status (nucleus#1515): a tone, the state in words and one
 * detail. A lead's next step comes from its current check first: approval needs a
 * passing check, and a failed recheck can keep an earlier approval, so a failed or
 * missing check is the state whatever the approval says. A papercut names its area.
 */
export type TriageStatus = {
  tone: "accent" | "success" | "warning" | "muted";
  state: string;
  detail: string | null;
};
export function triageStatus(lead: BoardLead): TriageStatus {
  if (lead.state === "promoted")
    return { tone: "success", state: "Promoted", detail: null };
  // A parked card keeps its reason in the status hint and detail.
  if (lead.parked)
    return {
      tone: "muted",
      state: "Parked",
      detail: lead.parked.reason,
    };
  if (lead.recheck)
    return {
      tone: "accent",
      state: "Due for a recheck",
      detail: lead.recheck.reason,
    };
  if (triageKind(lead) === "papercut")
    return { tone: "muted", state: "Open", detail: lead.papercutArea };
  if (!lead.check)
    return { tone: "muted", state: "Unchecked", detail: "awaiting a check" };
  if (!lead.check.ok)
    return {
      tone: "warning",
      state: "Checks failed",
      detail: "brief needs revising",
    };
  return lead.approved
    ? { tone: "accent", state: "Approved", detail: "awaiting promotion" }
    : { tone: "accent", state: "Checked", detail: "awaiting approval" };
}

/**
 * Operator order for Triage (Tom, 2026-11-07): checked leads awaiting approval first, then
 * other leads awaiting approval, then approved leads waiting on promotion, then papercuts.
 * The sort is stable, so the board's newest-first order holds within a rank.
 */
export function triageRank(lead: BoardLead): number {
  if (triageKind(lead) === "papercut") return 3;
  if (lead.approved) return 2;
  return lead.check?.ok ? 0 : 1;
}
const byTriageRank = (a: PipelineCard, b: PipelineCard) =>
  (a.kind === "lead" ? triageRank(a.value) : 0) -
  (b.kind === "lead" ? triageRank(b.value) : 0);

/**
 * Spec 026 Board phase mapping as of 87555f7. Queued is `queued`; Working is
 * `dispatching`, `working` and `changes_requested` (revision, with its "changes
 * requested" chip); Attention is `blocked`, `error` and `needs_attention`;
 * Review is `awaiting_review` and `reviewing`; Closing is `verifying`,
 * `merging`, `syncing` and `closing`. Every task phase is listed so a new
 * phase cannot fall through silently; `done` and `cancelled` leave the board
 * through the row filter below and never reach a bucket.
 */
export function pipelinePhaseColumn(
  phase: TaskSummary["phase"],
): PipelineColumn {
  switch (phase) {
    case "queued":
      return "Queued";
    case "dispatching":
    case "working":
    case "changes_requested":
      return "Working";
    case "blocked":
    case "error":
    case "needs_attention":
      return "Attention";
    case "awaiting_review":
    case "report_ready":
    case "reviewing":
      return "Review";
    case "verifying":
    case "merging":
    case "syncing":
    case "closing":
      return "Closing";
    case "done":
    case "cancelled":
      return "Closing";
  }
}

/** Whether a task phase occupies the board's Attention column. */
export function phaseNeedsAttention(phase: TaskSummary["phase"]): boolean {
  return pipelinePhaseColumn(phase) === "Attention";
}

/**
 * The column a task card belongs to, from the one attention projection
 * (nucleus#1366): a task that waits with a named cause is open work, not
 * attention, so it sits with the work rather than in the Attention column. Its
 * own phase column is kept when that column already says the same thing or the
 * task is further along the lane.
 */
function taskCardColumn(task: TaskSummary): PipelineColumn {
  const column = pipelinePhaseColumn(task.phase);
  if (column !== "Attention") return column;
  const projection = taskAttention({
    phase: task.phase,
    held: task.held,
    holds: task.holds,
    holdKind: task.holdKind,
    attention: task.resolution?.attention,
    originFault: Boolean(task.originError || task.originLookupError),
    prerequisiteWait:
      task.waitState?.state === "waiting_prerequisite" &&
      task.waitState.owner !== "operator",
    prerequisiteOperator:
      task.waitState?.state === "waiting_prerequisite" &&
      task.waitState.owner === "operator",
    waitingOn: task.waitingOn,
    reason: task.reason,
  });
  return projection.state === "attention" ? "Attention" : "Working";
}

export function pipelineColumn(card: PipelineCard): PipelineColumn {
  if (card.kind === "lead") return "Triage";
  // Spec 032: the Decisions column holds agent decisions and Queue-raised work.
  if (
    card.kind === "decision" ||
    card.kind === "raised"
  )
    return "Decisions";
  // Spec 026: an accepted submission shows queued until its task exists.
  if (card.kind === "submission") return "Queued";
  // A plain task card sits where the one attention projection says it does.
  if (card.kind === "task") return taskCardColumn(card.value);
  // Untyped fixtures may omit the phase; live summaries always carry one.
  return pipelinePhaseColumn(
    (card as { value: { phase?: TaskSummary["phase"] } }).value.phase ??
      "working",
  );
}

export type PipelineScope = {
  projects: Project[];
  selection: readonly string[];
  leads: readonly BoardLead[];
  tasks: TaskSummary[];
  /** Spec 032: open decisions; the caller filters by status. */
  decisions?: readonly DecisionView[];
  pendingSubmissions?: PendingSubmission[];
  /** Promoted leads outside the card set, carried so an open decision they link keeps its lanes and scoping. */
  linkedLeads?: readonly BoardLeadLink[];
};

function collectPipelineCards(input: PipelineScope): PipelineCard[] {
  const { projects } = input;
  const selection = effectiveSelection(projects, input.selection);
  const all = !selection.length;
  const selected = projects.filter((item) => selection.includes(item.key));
  const inScope = (origin: string, path: string) =>
    all ||
    selected.some((item) =>
      item.repositories.some((repo) =>
        origin && repo.origin
          ? repo.origin === origin
          : Boolean(repo.path && repo.path === path),
      ),
    );
  const cards: PipelineCard[] = [
    ...input.leads
      .filter(
        (lead) =>
          (lead.state === "open" ||
            lead.targets.some(
              (target) => target.kind === "draft" || target.kind === "task",
            )) &&
          lead.repositories.some(
            (repo) =>
              inScope(repo.origin, repo.path) &&
              !lead.targets.some(
                (target) =>
                  target.repository === repo.origin &&
                  (target.kind === "draft" || target.kind === "task"),
              ),
          ),
      )
      .map((value) => ({
        kind: "lead" as const,
        id: value.id,
        lanes: value.lanes,
        value,
      })),
    // An accepted submission with no task yet is the one card that proves the
    // acceptance was received (Spec 026). It leaves the board when the task does.
    ...(input.pendingSubmissions ?? [])
      .filter((card) => inScope(card.repository ?? "", card.repoPath))
      .map((value) => ({
        kind: "submission" as const,
        id: value.id,
        lanes: value.lanes,
        value,
      })),
  ];
  // Spec 032: open decisions join the board through their links. A decision's
  // lanes are the lanes of its linked tasks, leads and papercuts, so it surfaces
  // where its work lives; an unresolvable-link decision scopes by the asker's
  // project. A General decision follows every project filter even when its
  // linked work belongs elsewhere. They precede Queue-raised cards.
  if (input.decisions?.length) {
    const taskById = new Map(input.tasks.map((task) => [task.id, task]));
    const leadById = new Map(
      [...input.leads, ...(input.linkedLeads ?? [])].map((lead) => [
        lead.id,
        lead,
      ]),
    );
    for (const decision of input.decisions) {
      if (decision.status !== "open") continue;
      const lanes = new Set<string>();
      let linked = false,
        linkedInScope = false;
      for (const id of decision.links.tasks) {
        const task = taskById.get(id);
        if (!task) continue;
        linked = true;
        for (const lane of task.lanes) lanes.add(lane);
        if (inScope(task.repository ?? "", task.repoPath)) linkedInScope = true;
      }
      for (const id of [...decision.links.leads, ...decision.links.papercuts]) {
        const lead = leadById.get(id);
        if (!lead) continue;
        linked = true;
        for (const lane of lead.lanes) lanes.add(lane);
        if (lead.repositories.some((repo) => inScope(repo.origin, repo.path)))
          linkedInScope = true;
      }
      if (
        decision.askedBy.project === null ||
        (linked
          ? linkedInScope
          : decision.askedBy.project
            ? inScope(
                decision.askedBy.project.origin,
                decision.askedBy.project.path,
              )
            : true)
      )
        cards.push({
          kind: "decision",
          id: decision.id,
          lanes: [...lanes],
          value: decision,
        });
    }
  }
  // Finished work leaves the board (Tom, 2026-09-27): there is no Done column.
  // Queue-raised work stays in Attention; the decisions column holds agent
  // decisions only (Tom, 2026-09-29). The one exception is Spec 040: a merge hold that
  // has waited past the escalation time is the operator's to release or keep.
  cards.push(
    ...input.tasks
      .filter(
        (task) =>
          task.phase !== "done" &&
          task.phase !== "cancelled" &&
          inScope(task.repository ?? "", task.repoPath),
      )
      .flatMap((value) => {
        const card: PipelineCard = {
          kind: value.holdEscalated ? "raised" : "task",
          id: value.id,
          lanes: value.lanes,
          value,
        };
        return [card];
      }),
  );
  return cards;
}

/**
 * The board (Tom, 2026-11-08: the swim-lane view is retired): one set of columns holding every
 * card in scope, each card once, whatever its lane count. Lane membership stays on the card.
 */
export function pipelineBoard(input: PipelineScope): PipelineBoard {
  const buckets = Object.fromEntries(
    pipelineColumns.map((name) => [name, [] as PipelineCard[]]),
  ) as Record<PipelineColumn, PipelineCard[]>;
  for (const card of collectPipelineCards(input))
    buckets[pipelineColumn(card)].push(card);
  buckets.Triage.sort(byTriageRank);
  const counts = Object.fromEntries(
    pipelineColumns.map((name) => [name, buckets[name].length]),
  ) as Record<PipelineColumn, number>;
  return { counts, cards: buckets };
}
