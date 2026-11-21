import type { PipelineBoard, PipelineCard, PipelineColumn } from './pipeline-board';
import { triageKind } from './pipeline-board';

/**
 * The inbox board (Tom, 2026-11-21): a menu, a list and a detail pane replace the
 * kanban columns. Each menu view reads the same one-card-once pipeline projection,
 * so a card's place is still decided by `pipelineColumn`; the inbox only groups the
 * columns under the operator's five destinations.
 */
export const inboxViews = [
  { id: 'needs', label: 'Needs you', icon: 'TriangleAlert' },
  { id: 'planning', label: 'Planning', icon: 'Map' },
  { id: 'leads', label: 'Leads', icon: 'Lightbulb' },
  { id: 'queue', label: 'Queue', icon: 'ListOrdered' },
  { id: 'active', label: 'Active', icon: 'Activity' },
] as const;
export type InboxView = typeof inboxViews[number]['id'];

/** Active's three sections, each also a menu entry of its own. */
export const activeSections = [
  { id: 'working', label: 'Working', column: 'Working' },
  { id: 'review', label: 'In review', column: 'Review' },
  { id: 'closing', label: 'Closing', column: 'Closing' },
] as const;
export type ActiveSection = typeof activeSections[number]['id'];

/** Leads splits into leads and papercuts. */
export type LeadsTab = 'leads' | 'papercuts';

export type InboxSection = { id: string; label: string; cards: PipelineCard[] };

/**
 * Milestone QA is retired as a board surface (Tom, 2026-11-21): QA runs as an
 * ordinary task, so a leftover QA card is not listed anywhere.
 */
const listed = (cards: readonly PipelineCard[]) => cards.filter(card => card.kind !== 'qa');

/** Leads and papercuts: the Triage column split by kind. */
export function leadsCards(board: PipelineBoard, tab: LeadsTab): PipelineCard[] {
  return board.cards.Triage.filter(card => card.kind === 'lead' && (triageKind(card.value) === 'papercut') === (tab === 'papercuts'));
}

/** The sections a menu view lists, in order. Planning has its own panes and lists none. */
export function inboxSections(board: PipelineBoard, view: InboxView, options: { active?: ActiveSection | null; leads?: LeadsTab } = {}): InboxSection[] {
  const column = (id: string, label: string, name: PipelineColumn): InboxSection => ({ id, label, cards: listed(board.cards[name]) });
  switch (view) {
    case 'needs': return [column('decisions', 'Decisions', 'Decisions'), column('attention', 'Tasks needing attention', 'Attention')];
    case 'leads': return [{ id: options.leads ?? 'leads', label: options.leads === 'papercuts' ? 'Papercuts' : 'Leads', cards: leadsCards(board, options.leads ?? 'leads') }];
    case 'queue': return [column('queued', 'Queued', 'Queued')];
    case 'active': return activeSections.filter(section => !options.active || section.id === options.active).map(section => column(section.id, section.label, section.column));
    case 'planning': return [];
  }
}

/**
 * The menu counts. Queue adds the queued tasks the board holds back behind its
 * "…and N more" rows, so the count is the real total, never the loaded page.
 */
export function inboxCounts(board: PipelineBoard, hiddenQueued = 0) {
  const n = (name: PipelineColumn) => listed(board.cards[name]).length;
  return {
    needs: n('Decisions') + n('Attention'),
    leads: leadsCards(board, 'leads').length + leadsCards(board, 'papercuts').length,
    leadsByTab: { leads: leadsCards(board, 'leads').length, papercuts: leadsCards(board, 'papercuts').length },
    queue: n('Queued') + hiddenQueued,
    active: n('Working') + n('Review') + n('Closing'),
    activeBySection: { working: n('Working'), review: n('Review'), closing: n('Closing') },
  };
}

/**
 * The layout for a panel width: three panes when wide; menu and list with the
 * detail in a modal when medium; the menu as a drawer when narrow. A host that
 * reports a compact layout is never wide.
 */
export type InboxLayout = 'wide' | 'medium' | 'narrow';
export const inboxWideMin = 1100;
export const inboxMediumMin = 720;
export function inboxLayout(width: number, hostCompact = false): InboxLayout {
  if (width > 0 && width < inboxMediumMin) return 'narrow';
  if (hostCompact || (width > 0 && width < inboxWideMin)) return 'medium';
  return 'wide';
}
/** Pane widths: the menu and the list are fixed; the detail takes the rest. */
export const inboxMenuWidth = { wide: 220, medium: 200 } as const;
export const inboxListWidth = 420;
