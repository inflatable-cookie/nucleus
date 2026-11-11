import type { BoardLead, BoardLeadLink, BoardQaRun, DecisionView, PendingSubmission, Project, TaskSummary } from './contracts';
import type { LaneView } from './contracts';
import { effectiveSelection } from './project-scope';

/** Spec 026 Board columns as of 87555f7: Attention sits before Queued so it is
 * visible without scrolling when the view opens. Spec 032 adds the Decisions
 * column ahead of Attention for agent decisions and Queue-raised prompts. */
export const pipelineColumns = ['Triage', 'Decisions', 'Attention', 'Queued', 'Working', 'Review', 'Closing'] as const;
export type PipelineColumn = typeof pipelineColumns[number];
export type PipelineCard =
  | { kind: 'lead'; id: string; lanes: string[]; value: BoardLead }
  | { kind: 'submission'; id: string; lanes: string[]; value: PendingSubmission }
  | { kind: 'decision'; id: string; lanes: string[]; value: DecisionView }
  | { kind: 'raised'; id: string; lanes: string[]; value: TaskSummary }
  | { kind: 'lane_drain'; id: string; lanes: string[]; value: LaneView }
  /** Tom, 2026-11-01: a milestone QA run is its own card, not a task. It carries no lanes. */
  | { kind: 'qa'; id: string; lanes: string[]; value: BoardQaRun }
  | { kind: 'task'; id: string; lanes: string[]; value: TaskSummary };

/** Spec 032: a decision card's age, coarse on purpose — the board never
 * re-renders on the minute, so the label avoids minutes-level precision. */
export function decisionAge(createdAt: string, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(createdAt)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}


/** The board's one set of columns: each card once, with per-column totals of the cards loaded. */
export type PipelineBoard = { counts: Record<PipelineColumn, number>; cards: Record<PipelineColumn, PipelineCard[]> };

/** Fallback height of a column's own scroll before the board area has been measured. */
export const pipelineCellMaxHeight = 420;

/** Triage pages (Tom, 2026-11-07): a column shows one page of cards, then an "…and N more" card loads the next. */
export const triagePageSize = 8;
export function triagePage<T>(cards: T[], shown: number): { visible: T[]; hidden: number } {
  return { visible: cards.slice(0, shown), hidden: Math.max(0, cards.length - shown) };
}

/** A Triage card's kind: a lead tagged papercut is a papercut (Spec 024, Spec 026). */
export function triageKind(lead: Pick<BoardLead, 'tags'>): 'papercut' | 'lead' {
  return lead.tags.includes('papercut') ? 'papercut' : 'lead';
}

/** One short line of state for a Triage card: a lead's check and approval, a papercut's area. */
export function triageState(lead: BoardLead): string {
  const promoted = lead.state === 'promoted' ? 'Promoted' : null;
  if (triageKind(lead) === 'papercut') return [promoted ?? 'Open', lead.papercutArea].filter(Boolean).join(' · ');
  const check = lead.check ? (lead.check.ok ? 'Checks passed' : 'Checks failed') : 'Unchecked';
  return [promoted, check, lead.approved ? 'approved' : 'unapproved'].filter(Boolean).join(' · ');
}

/**
 * Operator order for Triage (Tom, 2026-11-07): checked leads awaiting approval first, then
 * other leads awaiting approval, then approved leads waiting on promotion, then papercuts.
 * The sort is stable, so the board's newest-first order holds within a rank.
 */
export function triageRank(lead: BoardLead): number {
  if (triageKind(lead) === 'papercut') return 3;
  if (lead.approved) return 2;
  return lead.check?.ok ? 0 : 1;
}
const byTriageRank = (a: PipelineCard, b: PipelineCard) => (a.kind === 'lead' ? triageRank(a.value) : 0) - (b.kind === 'lead' ? triageRank(b.value) : 0);

/**
 * Finding 1 (nucleus-ui, 2026-11-08): a column with no cards collapses to a slim labelled
 * stub at every width, so populated columns get the space and a narrow board opens on work.
 * The stub shows only its name; its accessible label retains the real count and empty state.
 * It expands as soon as the column holds a card.
 */
export const pipelineStubWidth = 84;
/** Populated columns share the width the stubs leave, but never stretch past a readable card. */
export const pipelineColumnMaxWidth = 420;

/**
 * The columns that collapse: those whose header total is zero and that nothing forces open.
 * The totals are the server's: every non-queued live task, and the queued count the server
 * reports. Triage stays open under a tag filter, so its filter can still be cleared.
 */
export function pipelineStubColumns(totals: Readonly<Record<PipelineColumn, number>>, forcedOpen: readonly PipelineColumn[] = []): ReadonlySet<PipelineColumn> {
  return new Set(pipelineColumns.filter(name => !totals[name] && !forcedOpen.includes(name)));
}

/**
 * Each column's width: a stub, or an equal share of what the stubs leave. A populated
 * column is never narrower than `minWidth` (the grid scrolls sideways past that) nor wider
 * than the cap.
 */
export function pipelineColumnWidths(stubs: ReadonlySet<PipelineColumn>, layout: { available: number; gap: number; minWidth: number }): Record<PipelineColumn, number> {
  const open = pipelineColumns.length - stubs.size;
  const room = layout.available - stubs.size * pipelineStubWidth - (pipelineColumns.length - 1) * layout.gap;
  const share = open ? Math.min(pipelineColumnMaxWidth, Math.max(layout.minWidth, Math.floor(room / open))) : layout.minWidth;
  return Object.fromEntries(pipelineColumns.map(name => [name, stubs.has(name) ? pipelineStubWidth : share])) as Record<PipelineColumn, number>;
}

/** The vertical scroll's gap between the header and the row, and its bottom padding. */
export const pipelineColumnChrome = 10 + 12;
/**
 * Height of each column's own scroll: exactly the pipeline area
 * less its bottom padding, the measured sticky header and the scroll's own gap and
 * padding, so the grid itself never overflows (Tom, 2026-09-28: it scrolled ~40 px).
 */
export function pipelineColumnHeight(areaHeight: number, chrome: { bottomPadding: number; headerHeight: number } = { bottomPadding: 0, headerHeight: 0 }): number {
  if (!(areaHeight > 0)) return pipelineCellMaxHeight;
  return Math.max(240, Math.floor(areaHeight - chrome.bottomPadding - chrome.headerHeight - pipelineColumnChrome));
}

/**
 * Spec 026 Board phase mapping as of 87555f7. Queued is `queued`; Working is
 * `dispatching`, `working` and `changes_requested` (revision, with its "changes
 * requested" chip); Attention is `blocked`, `error` and `needs_attention`;
 * Review is `awaiting_review` and `reviewing`; Closing is `verifying`,
 * `merging`, `syncing` and `closing`. Every task phase is listed so a new
 * phase cannot fall through silently; `done` and `cancelled` leave the board
 * through the row filter below and never reach a bucket.
 */
export function pipelinePhaseColumn(phase: TaskSummary['phase']): PipelineColumn {
  switch (phase) {
    case 'queued': return 'Queued';
    case 'dispatching':
    case 'working':
    case 'changes_requested': return 'Working';
    case 'blocked':
    case 'error':
    case 'needs_attention': return 'Attention';
    case 'awaiting_review':
    case 'report_ready':
    case 'reviewing': return 'Review';
    case 'verifying':
    case 'merging':
    case 'syncing':
    case 'closing': return 'Closing';
    case 'done':
    case 'cancelled': return 'Closing';
  }
}

export function pipelineColumn(card: PipelineCard): PipelineColumn {
  if (card.kind === 'lead') return 'Triage';
  // Spec 032: the Decisions column holds agent decisions and Queue-raised work.
  // Spec 041: a drained lane that outlived its escalation timer joins them.
  if (card.kind === 'decision' || card.kind === 'raised' || card.kind === 'lane_drain') return 'Decisions';
  // Spec 026: an accepted submission shows queued until its task exists.
  if (card.kind === 'submission') return 'Queued';
  // Milestone QA (Tom, 2026-11-01): queued waits in Queued, running works in Working, a passing run
  // finishes in Closing until it fades, and any other finished run needs attention.
  if (card.kind === 'qa') return card.value.state === 'queued' ? 'Queued' : card.value.state === 'running' ? 'Working' : card.value.state === 'passed' ? 'Closing' : 'Attention';
  // Untyped fixtures may omit the phase; live summaries always carry one.
  return pipelinePhaseColumn(card.value.phase ?? 'working');
}

export type PipelineScope = {
  projects: Project[]; selection: readonly string[];
  leads: readonly BoardLead[]; tasks: TaskSummary[];
  /** Spec 032: open decisions; the caller filters by status. */
  decisions?: readonly DecisionView[];
  pendingSubmissions?: PendingSubmission[];
  /** Spec 041: drained lanes and boards escalate into the decisions view. */
  lanes?: readonly LaneView[];
  /** Promoted leads outside the card set, carried so an open decision they link keeps its lanes and scoping. */
  linkedLeads?: readonly BoardLeadLink[];
  /** Milestone QA cards (Tom, 2026-11-01), already projected by the server; the project and lane filters apply. */
  qaRuns?: readonly BoardQaRun[];
};

function collectPipelineCards(input: PipelineScope): PipelineCard[] {
  const { projects } = input;
  const selection = effectiveSelection(projects, input.selection);
  const all = !selection.length;
  const selected = projects.filter(item => selection.includes(item.key));
  const owner = (origin: string, path: string) => projects.find(project => project.repositories.some(repo => origin && repo.origin ? repo.origin === origin : Boolean(repo.path && repo.path === path)));
  const inScope = (origin: string, path: string) => all ? owner(origin, path)?.visibility !== 'parked' : selected.some(item => item.repositories.some(repo => origin && repo.origin ? repo.origin === origin : Boolean(repo.path && repo.path === path)));
  const cards: PipelineCard[] = [
    ...input.leads.filter(lead => (lead.state === 'open' || lead.targets.some(target => target.kind === 'draft' || target.kind === 'task')) && lead.repositories.some(repo => inScope(repo.origin, repo.path) && !lead.targets.some(target => target.repository === repo.origin && (target.kind === 'draft' || target.kind === 'task')))).map(value => ({ kind: 'lead' as const, id: value.id, lanes: value.lanes, value })),
    // An accepted submission with no task yet is the one card that proves the
    // acceptance was received (Spec 026). It leaves the board when the task does.
    ...(input.pendingSubmissions ?? []).filter(card => inScope(card.repository ?? '', card.repoPath))
      .map(value => ({ kind: 'submission' as const, id: value.id, lanes: value.lanes, value })),
  ];
  // Spec 032: open decisions join the board through their links. A decision's
  // lanes are the lanes of its linked tasks, leads and papercuts, so it surfaces
  // where its work lives; an unresolvable-link decision scopes by the asker's
  // project. A General decision follows every project filter even when its
  // linked work belongs elsewhere. They precede Queue-raised cards.
  if (input.decisions?.length) {
    const taskById = new Map(input.tasks.map(task => [task.id, task]));
    const leadById = new Map([...input.leads, ...(input.linkedLeads ?? [])].map(lead => [lead.id, lead]));
    for (const decision of input.decisions) {
      if (decision.status !== 'open') continue;
      const lanes = new Set<string>();
      let linked = false, linkedInScope = false;
      for (const id of decision.links.tasks) {
        const task = taskById.get(id);
        if (!task) continue;
        linked = true;
        for (const lane of task.lanes) lanes.add(lane);
        if (inScope(task.repository ?? '', task.repoPath)) linkedInScope = true;
      }
      for (const id of [...decision.links.leads, ...decision.links.papercuts]) {
        const lead = leadById.get(id);
        if (!lead) continue;
        linked = true;
        for (const lane of lead.lanes) lanes.add(lane);
        if (lead.repositories.some(repo => inScope(repo.origin, repo.path))) linkedInScope = true;
      }
      if (decision.askedBy.project === null || (linked ? linkedInScope : decision.askedBy.project ? inScope(decision.askedBy.project.origin, decision.askedBy.project.path) : true))
        cards.push({ kind: 'decision', id: decision.id, lanes: [...lanes], value: decision });
    }
  }
  // Finished work leaves the board (Tom, 2026-09-27): there is no Done column.
  // Queue-raised work stays in Attention; the decisions column holds agent
  // decisions only (Tom, 2026-09-29). The one exception is Spec 040: a merge hold that
  // has waited past the escalation time is the operator's to release or keep.
  cards.push(...input.tasks.filter(task => task.phase !== 'done' && task.phase !== 'cancelled' && (inScope(task.repository ?? '', task.repoPath) || owner(task.repository ?? '', task.repoPath)?.visibility === 'parked' && (task.held || task.resolution?.attention || Boolean(task.originError || task.originLookupError) || ['blocked', 'error', 'needs_attention', 'changes_requested'].includes(task.phase)))).flatMap(value => {
    const card: PipelineCard = { kind: value.holdEscalated ? 'raised' : 'task', id: value.id, lanes: value.lanes, value };
    return [card];
  }));
  // Spec 041: a drained lane whose escalation timer passed is the plan owner's unanswered
  // prompt; it joins the decisions view with the merge holds. Attention on a parked
  // project stays visible, so its escalations do too. A drained board never joins:
  // it is not an operator decision (Tom, 2026-10-15).
  const laneOwner = (origin: string | null, path: string) => projects.find(project => project.repositories.some(repo => origin && repo.origin ? repo.origin === origin : Boolean(repo.path && repo.path === path)));
  const laneInScope = (lane: LaneView) => lane.repositories.some(repo => inScope(repo.origin, repo.path) || laneOwner(repo.origin, repo.path)?.visibility === 'parked');
  cards.push(...(input.lanes ?? []).filter(lane => lane.drain?.escalatedAt && laneInScope(lane))
    .map(value => ({ kind: 'lane_drain' as const, id: `lane-drain:${value.key}`, lanes: [value.key], value })));
  // A milestone QA run belongs to its repository's project, so the project filter scopes it like a task.
  cards.push(...(input.qaRuns ?? []).filter(run => inScope(run.repository.origin ?? '', run.repository.path))
    .map(value => ({ kind: 'qa' as const, id: `qa:${value.id}`, lanes: [], value })));
  return cards;
}

/**
 * The board (Tom, 2026-11-08: the swim-lane view is retired): one set of columns holding every
 * card in scope, each card once, whatever its lane count. Lane membership stays on the card.
 */
export function pipelineBoard(input: PipelineScope): PipelineBoard {
  const buckets = Object.fromEntries(pipelineColumns.map(name => [name, [] as PipelineCard[]])) as Record<PipelineColumn, PipelineCard[]>;
  for (const card of collectPipelineCards(input)) buckets[pipelineColumn(card)].push(card);
  buckets.Triage.sort(byTriageRank);
  const counts = Object.fromEntries(pipelineColumns.map(name => [name, buckets[name].length])) as Record<PipelineColumn, number>;
  return { counts, cards: buckets };
}
