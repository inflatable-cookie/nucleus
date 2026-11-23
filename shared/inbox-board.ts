import type {
  PipelineBoard,
  PipelineCard,
  PipelineColumn,
} from "./pipeline-board";
import { triageKind } from "./pipeline-board";

/**
 * The inbox board (Tom, 2026-11-21): a menu, a list and a detail pane replace the
 * kanban columns. Each menu view reads the same one-card-once pipeline projection,
 * so a card's place is still decided by `pipelineColumn`; the inbox only groups the
 * columns under the operator's destinations. Leads and papercuts are separate
 * entries (Tom, 2026-11-21).
 */
export const inboxViews = [
  { id: "needs", label: "Needs you", icon: "TriangleAlert" },
  { id: "planning", label: "Planning", icon: "Map" },
  { id: "leads", label: "Leads", icon: "Lightbulb" },
  { id: "papercuts", label: "Papercuts", icon: "Scissors" },
  { id: "queue", label: "Queue", icon: "ListOrdered" },
  { id: "working", label: "Working", icon: "Hammer", column: "Working" },
  { id: "review", label: "In review", icon: "Eye", column: "Review" },
  { id: "closing", label: "Closing", icon: "Check", column: "Closing" },
] as const;
export type InboxView = (typeof inboxViews)[number]["id"];

export type InboxSection = { id: string; label: string; cards: PipelineCard[] };

/**
 * Leads: the Triage column's leads on the to-do list. A papercut-tagged lead is a papercut, never a
 * lead here, and a parked lead is off the list until it is unparked (Nucleus#1543).
 */
export function leadsCards(board: PipelineBoard): PipelineCard[] {
  return board.cards.Triage.filter(
    (card) =>
      card.kind === "lead" &&
      triageKind(card.value) === "lead" &&
      !card.value.parked,
  );
}

/** Papercuts: the Triage column's papercut-tagged leads on the to-do list, their own list (Tom, 2026-11-21). */
export function papercutCards(board: PipelineBoard): PipelineCard[] {
  return board.cards.Triage.filter(
    (card) =>
      card.kind === "lead" &&
      triageKind(card.value) === "papercut" &&
      !card.value.parked,
  );
}

/** Nucleus#1543: the parked leads or papercuts of one list, shown under Parked at its end. */
export function parkedCards(
  board: PipelineBoard,
  view: "leads" | "papercuts",
): PipelineCard[] {
  const kind = view === "leads" ? "lead" : "papercut";
  return board.cards.Triage.filter(
    (card) =>
      card.kind === "lead" &&
      triageKind(card.value) === kind &&
      Boolean(card.value.parked),
  );
}

/**
 * When a Needs you card began to need the operator: a decision's ask, a drained
 * lane's escalation (or its drain start), a task's hold. A task summary carries no
 * general change time, so an attention task with no hold start sorts after the dated
 * cards (0). Milliseconds, so the sources sort together.
 */
export function needsActionAt(card: PipelineCard): number {
  const at =
    card.kind === "decision"
      ? card.value.createdAt
      : card.kind === "lane_drain"
        ? (card.value.drain?.escalatedAt ?? card.value.drain?.since)
        : card.kind === "task" || card.kind === "raised"
          ? card.value.hold?.since
          : undefined;
  return Date.parse(at ?? "") || 0;
}

/** Needs you: decisions, Nucleus-raised holds, drained-lane prompts and attention tasks in one list, newest needing action first. */
export function needsCards(board: PipelineBoard): PipelineCard[] {
  return [...board.cards.Decisions, ...board.cards.Attention].sort(
    (a, b) => needsActionAt(b) - needsActionAt(a),
  );
}

/** The sections a menu view lists, in order. Planning has its own panes and lists none. */
export function inboxSections(
  board: PipelineBoard,
  view: InboxView,
): InboxSection[] {
  const column = (
    id: string,
    label: string,
    name: PipelineColumn,
  ): InboxSection => ({ id, label, cards: board.cards[name] });
  switch (view) {
    case "needs":
      return [{ id: "needs", label: "Needs you", cards: needsCards(board) }];
    case "leads":
      return [{ id: "leads", label: "Leads", cards: leadsCards(board) }];
    case "papercuts":
      return [
        { id: "papercuts", label: "Papercuts", cards: papercutCards(board) },
      ];
    case "queue":
      return [column("queued", "Queued", "Queued")];
    case "working":
      return [column("working", "Working", "Working")];
    case "review":
      return [column("review", "In review", "Review")];
    case "closing":
      return [column("closing", "Closing", "Closing")];
    case "planning":
      return [];
  }
}

/**
 * The menu counts. Queue adds the queued tasks the board holds back, so the count is
 * the real total, never the pages the list has read.
 */
export function inboxCounts(board: PipelineBoard, hiddenQueued = 0) {
  const n = (name: PipelineColumn) => board.cards[name].length;
  return {
    needs: needsCards(board).length,
    leads: leadsCards(board).length,
    papercuts: papercutCards(board).length,
    queue: n("Queued") + hiddenQueued,
    working: n("Working"),
    review: n("Review"),
    closing: n("Closing"),
  };
}

/**
 * The layout for a panel width: three panes when wide; menu and list with the
 * detail in a modal when medium; the menu as a drawer when narrow. A host that
 * reports a compact layout is never wide.
 */
export type InboxLayout = "wide" | "medium" | "narrow";
export const inboxWideMin = 1100;
export const inboxMediumMin = 720;
export function inboxLayout(width: number, hostCompact = false): InboxLayout {
  if (width > 0 && width < inboxMediumMin) return "narrow";
  if (hostCompact || (width > 0 && width < inboxWideMin)) return "medium";
  return "wide";
}
/** Pane widths: the menu and the list are fixed; the detail takes the rest. */
export const inboxMenuWidth = { wide: 220, medium: 200 } as const;
export const inboxListWidth = 420;
