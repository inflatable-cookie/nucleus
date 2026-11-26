import { laneProjects } from "../../shared/lane-finder";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as api from "../../shared/contracts";
import {
  type DecisionView,
  type BoardLead,
  type BoardLeadLink,
  type LaneView,
  type ProjectPlan,
  type TaskSummary,
  type UiQueueState,
} from "../../shared/contracts";
import {
  decisionAge,
  pipelineBoard,
  triageKind,
  triagePageSize,
  type PipelineCard,
} from "../../shared/pipeline-board";
import {
  inboxCounts,
  inboxSections,
  triageCards,
  rustTriageStates,
  triageStates,
  type TriageFilter,
  type InboxView,
} from "../../shared/inbox-board";
import { openScopeLanes } from "../../shared/project-scope";
import type { ProjectBadge } from "../../shared/t3/project-badge";
import { useRpc } from "../shell";
import { useEngineFeatures } from "../engine-features";
import {
  Button,
  DropdownSelect,
  muted,
  row,
  type Colors,
} from "../controls";
import { projectName } from "./text";
import { useTick } from "../use-tick";
import { relativeAge } from "../../shared/pipeline-board";
import { Badge } from "./badges";
import {
  BoardCard,
  BoardCardVariantContext,
  CardProject,
  TaskCard,
  DecisionCard,
  HoldPromptCard,
  LaneDrainCard,
} from "./cards";
import { LeadProjectEyebrow, TriageLeadCard } from "./triage-lead-card";
import { PageSentinel, pageLabel } from "./page-sentinel";
import type { BoardAct } from "./use-board-data";
import { space, type as typeScale } from "../design";
import type { BoardView } from "./inbox-menu";
import { RustTaskProgress } from "../task/rust-progress";
import { rustCardAgeAt, rustQuestionText, rustTaskLabel, rustWaitDetail, type RustCommand, type RustTask } from "../web/rust-board";

type Project = UiQueueState["projects"][number];

/** The page size `queue.queued-page` reads, and so one fill step of the Queue list. */
const queuedPageSize = 25;
/** One project's held-back queued tasks: the cards read so far and the next offset, or null at its end. */
type QueuedPages = Record<
  string,
  { tasks: TaskSummary[]; nextOffset: number | null }
>;

/**
 * The list's view state: the Leads tag filter, the pages of Leads and Papercuts, and
 * the Queue list's held-back pages. The shell holds it, so leaving a view and coming
 * back keeps them.
 */
export function usePipelineState() {
  const fetchQueuedPage = useRpc(api.queuePage);
  const [triageTag, setTriageTag] = useState<string | null>(null);
  // Leads and papercuts load in pages of eight as the list approaches its end.
  const [triageShown, setTriageShown] = useState(triagePageSize);
  const [papercutShown, setPapercutShown] = useState(triagePageSize);
  // The Queue list reads each project's held-back tasks a page at a time as it nears
  // its end (nucleus#1532); the wanted page count per project names what to read.
  const [queuedWanted, setQueuedWanted] = useState<Record<string, number>>({});
  const queuedKey = Object.entries(queuedWanted)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repoPath, pages]) => `${repoPath}:${pages}`)
    .join("|");
  const queuedPages = useQuery({
    queryKey: ["nucleus", "queued-pages", queuedKey],
    queryFn: async () => {
      const read = await Promise.all(
        Object.entries(queuedWanted)
          .filter(([, pages]) => pages > 0)
          .map(async ([repoPath, pages]) => {
            const tasks: TaskSummary[] = [];
            let offset = 0;
            let nextOffset: number | null = null;
            for (let page = 0; page < pages; page++) {
              const answer = await fetchQueuedPage({
                repoPath,
                offset,
                limit: queuedPageSize,
              });
              tasks.push(...answer.tasks);
              nextOffset = answer.nextOffset;
              if (nextOffset === null) break;
              offset = nextOffset;
            }
            return [repoPath, { tasks, nextOffset }] as const;
          }),
      );
      return Object.fromEntries(read) as QueuedPages;
    },
    enabled: Boolean(queuedKey),
    // A new page keeps the cards already read until its own read lands.
    placeholderData: (previous: QueuedPages | undefined) => previous,
    refetchInterval: 4000,
  });
  // The last read each project answered, so a failed page leaves the cards already read
  // on screen instead of emptying the list behind its retry row.
  const queuedLastRead = useRef<QueuedPages>({});
  useEffect(() => {
    if (queuedPages.data) queuedLastRead.current = queuedPages.data;
  }, [queuedPages.data]);
  /**
   * Whether a held-back read is settled: not on its way, not showing another key's
   * cards, and not failed. A scroll or fill step that arrives meanwhile waits; only the
   * retry row asks again after a failure.
   */
  const queuedSettled = () =>
    !queuedPages.isFetching &&
    !queuedPages.isPlaceholderData &&
    !queuedPages.error;
  /**
   * Reads the next held-back page of every project that still has one, so a fill step
   * advances them together. A project is asked for its first page as soon as it has
   * held-back tasks, and for another only while its last read said more remain. Repeated
   * scroll events while a page is on its way ask for nothing.
   */
  const loadQueued = (
    hidden: ReadonlyArray<{ repoPath: string; hidden: number }>,
  ) => {
    if (!queuedSettled()) return;
    const wanted: Record<string, number> = {};
    for (const item of hidden) {
      const pages = queuedWanted[item.repoPath] ?? 0;
      if (pages === 0) wanted[item.repoPath] = 1;
      else if (queuedPages.data?.[item.repoPath]?.nextOffset != null)
        wanted[item.repoPath] = pages + 1;
    }
    if (Object.keys(wanted).length)
      setQueuedWanted((current) => ({ ...current, ...wanted }));
  };
  /** The held-back cards to draw: the query's own read, or the last one it answered. */
  const queuedTasks = queuedPages.data ?? queuedLastRead.current;
  return {
    queuedPages,
    queuedTasks,
    queuedSettled,
    queuedWanted,
    loadQueued,
    triageTag,
    setTriageTag,
    triageShown,
    setTriageShown,
    papercutShown,
    setPapercutShown,
  };
}
export type PipelineState = ReturnType<typeof usePipelineState>;

export type InboxBoardInput = {
  state: UiQueueState | undefined;
  selection: string[];
  lanes?: UiQueueState["lanes"];
  boardLeads: readonly BoardLead[];
  leadLinks: readonly BoardLeadLink[];
  decisions: DecisionView[] | undefined;
  hiddenQueued: number;
  triageTag: string | null;
};

/**
 * The one card-once projection the menu counts and the list read, derived only
 * when an input changes (a counter-only poll keeps these references). The Leads
 * tag filter applies to a copy, never to the memoised board.
 */
export function useInboxBoard({
  state,
  selection,
  lanes = state?.lanes,
  boardLeads,
  leadLinks,
  decisions,
  hiddenQueued,
  triageTag,
}: InboxBoardInput) {
  const selectionKey = selection.join("\n");
  const columns = useMemo(
    () =>
      pipelineBoard({
        projects: state?.projects ?? [],
        lanes: lanes ?? [],
        selection,
        leads: boardLeads,
        linkedLeads: leadLinks,
        tasks: state?.tasks ?? [],
        decisions: decisions ?? [],
        pendingSubmissions: state?.pendingSubmissions ?? [],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state?.projects,
      lanes,
      state?.tasks,
      state?.pendingSubmissions,
      selectionKey,
      boardLeads,
      leadLinks,
      decisions,
    ],
  );
  // The tag filter narrows Leads only: papercuts are their own list with no filter (Tom, 2026-11-21).
  const board = {
    counts: columns.counts,
    cards: {
      ...columns.cards,
      Triage: columns.cards.Triage.filter(
        (card) =>
          card.kind !== "lead" ||
          triageKind(card.value) === "papercut" ||
          !triageTag ||
          card.value.tags.includes(triageTag),
      ),
    },
  };
  const scopeLeads = triageCards(columns, "leads", "All").flatMap((card) =>
    card.kind === "lead" ? [card.value] : [],
  );
  // The tag filter lists only tags on leads in the current scope, with counts;
  // tags from other projects or briefed leads matched nothing (Tom, 2026-10-15).
  // A papercut-tagged lead is never in this list, so the reserved papercut tag is not offered.
  const tagCounts = new Map<string, number>();
  for (const lead of scopeLeads)
    for (const tag of lead.tags)
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  if (triageTag && !tagCounts.has(triageTag)) tagCounts.set(triageTag, 0);
  // Reserved tags lead under their display names; free-form tags follow alphabetically.
  const triageTagOptions = [
    { value: "", label: `All tags (${scopeLeads.length})` },
    ...[...tagCounts]
      .sort(
        ([a], [b]) =>
          Number(!api.RESERVED_LEAD_TAGS[a]) -
            Number(!api.RESERVED_LEAD_TAGS[b]) || a.localeCompare(b),
      )
      .map(([tag, count]) => ({
        value: tag,
        label: `${api.RESERVED_LEAD_TAGS[tag] ?? tag} (${count})`,
        group: api.RESERVED_LEAD_TAGS[tag] ? "Reserved" : "Tags",
      })),
  ];
  // The open-lane count is not cards: every active lane a selected project
  // lists, counted once (nucleus#1546). The tag filter never narrows it,
  // like the rest of the menu counts.
  const planning = useMemo(
    () =>
      openScopeLanes(state?.projects ?? [], lanes ?? [], selection)
        .length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state?.projects, lanes, selectionKey],
  );
  // The menu counts ignore the tag filter: it narrows the list, not the inbox. The list's
  // own header counts what it shows.
  const counts = useMemo(
    () => ({ ...inboxCounts(columns, hiddenQueued), planning }),
    [columns, hiddenQueued, planning],
  );
  const listCounts = triageTag
    ? { ...inboxCounts(board, hiddenQueued), planning }
    : counts;
  return { board, counts, listCounts, triageTagOptions };
}
export type InboxBoard = ReturnType<typeof useInboxBoard>;

export type InboxListProps = {
  c: Colors;
  state: UiQueueState | undefined;
  stateError: unknown;
  inbox: InboxBoard;
  /** The selected project keys; empty shows every project. Closed rows follow it like the cards. */
  scope?: readonly string[];
  view: Exclude<BoardView, "planning">;
  rust?: {
    tasks: RustTask[] | undefined;
    error: unknown;
    retry: () => void;
    selected: string | null;
    onSelect: (id: string) => void;
    project: (task: RustTask) => { name: string; key?: string; badge: ProjectBadge | null };
    busy?: boolean;
    onCommand?: (id: string, command: RustCommand) => void;
  };
  leadsLoading: boolean;
  decisions: DecisionView[] | undefined;
  decisionsError?: unknown;
  /** Per project, the queued tasks the board holds back; the Queue list reads them as pages. */
  queuedHidden: Array<{ repoPath: string; hidden: number }>;
  projectForRepository: (
    repoPath: string,
    origin?: string | null,
  ) => Project | undefined;
  selected: string | null;
  recordProject?: string;
  selectedLeadId: string | null;
  openPapercutId: string | null;
  openDecisionId: string | null;
  onSelectTask: (id: string) => void;
  onSelectDecision: (id: string, project?: string) => void;
  onSelectLead: (id: string, lane: null, project?: string) => void;
  onSelectPapercut: (id: string, project?: string) => void;
  /** Opens a lane in the plan view, the drained-lane card's press (nucleus#1511). */
  onOpenLane: (key: string, project?: string) => void;
  /** Every project plan, so the drained lane's mark-done confirmation names each plan that lists it. */
  plans?: ProjectPlan[];
  busy: boolean;
  act: BoardAct;
  /** The list's view state the shell keeps across views (`usePipelineState`). */
  pipeline: PipelineState;
};

const viewTitles: Record<Exclude<BoardView, "planning">, string> = {
  needs: "Needs you",
  leads: "Leads",
  papercuts: "Papercuts",
  queue: "Queue",
  working: "Working",
  review: "In review",
  merging: "Merging",
  closing: "Closing",
  history: "History",
};
/**
 * The inbox list (Tom, 2026-11-21): the open menu view's cards in one scrolling
 * list, each card drawn as a row. Every view is one list with no section headers.
 * A card's own content and actions are unchanged from the kanban board.
 */
export function InboxList({
  c,
  state,
  stateError,
  inbox,
  scope = [],
  view,
  rust,
  leadsLoading,
  decisions,
  decisionsError,
  queuedHidden,
  projectForRepository,
  selected,
  recordProject,
  selectedLeadId,
  openPapercutId,
  openDecisionId,
  onSelectTask,
  onSelectDecision,
  onSelectLead,
  onSelectPapercut,
  onOpenLane,
  busy,
  act,
  pipeline,
  plans = [],
}: InboxListProps) {
  const setTask = useRpc(api.taskControl);
  const changeLaneStatus = useRpc(api.laneStatus);
  const keepLaneRpc = useRpc(api.laneKeep);
  const {
    queuedPages,
    queuedTasks,
    queuedSettled,
    queuedWanted,
    loadQueued,
    triageTag,
    setTriageTag,
    triageShown,
    setTriageShown,
    papercutShown,
    setPapercutShown,
  } = pipeline;
  const { board, listCounts: counts, triageTagOptions } = inbox;
  const legacyView = view === "merging" || view === "history" ? null : view;
  const [triageFilters, setTriageFilters] = useState<Record<"leads" | "papercuts", TriageFilter>>({
    leads: "All", papercuts: "All",
  });
  const triageView = view === "leads" || view === "papercuts" ? view : null;
  const rustEngine = useEngineFeatures().engine === "rust";
  const stateOptions = rustEngine ? rustTriageStates : triageStates;
  // Closed (Rust only): promoted and dropped items, read apart from the board's cards.
  const closedFilter = rustEngine && triageView !== null && triageFilters[triageView] === "Closed";
  const readClosed = useRpc(api.itemClosed);
  const closedKind = view === "papercuts" ? "papercut" : "lead";
  const closedQuery = useQuery({
    queryKey: ["nucleus", "leads", "closed", closedKind],
    queryFn: () => readClosed({ kind: closedKind }),
    enabled: closedFilter,
  });
  const closedItems = useMemo(
    () => closedQuery.data?.filter((item) => scope.length === 0 || scope.includes(item.projectKey)),
    [closedQuery.data, scope],
  );
  const sections = legacyView
    ? inboxSections(board, legacyView, triageView ? triageFilters[triageView] : undefined)
    : [];
  const loadedPage = useRef({ view, count: triagePageSize });
  const isTriageList = triageView !== null;
  const shown = view === "papercuts" ? papercutShown : triageShown;
  const setShown = view === "papercuts" ? setPapercutShown : setTriageShown;
  const totalInList = sections.reduce(
    (total, section) => total + section.cards.length,
    0,
  );
  /**
   * A project's held-back queued tasks, without the ones the board already ships: the
   * page's first cards repeat the shipped queue heads.
   */
  const heldQueued = (repoPath: string) =>
    (queuedTasks[repoPath]?.tasks ?? []).filter(
      (task) => !(state?.tasks ?? []).some((shipped) => shipped.id === task.id),
    );
  /** The held-back queued cards the list has read and drawn. */
  const heldShown = queuedHidden.reduce(
    (total, item) => total + heldQueued(item.repoPath).length,
    0,
  );
  /**
   * Whether any project's held-back queue still has a page to read (nucleus#1532). A
   * read on its way, another key's placeholder cards, or a failure asks for nothing:
   * the list waits, and only the retry row reads again after a failure.
   */
  const queuedMore =
    view === "queue" &&
    queuedSettled() &&
    queuedHidden.some((item) => {
      const pages = queuedWanted[item.repoPath] ?? 0;
      // Nothing read yet, so a page is owed; after that only the last read says.
      if (pages === 0) return true;
      const read = queuedPages.data?.[item.repoPath];
      return read ? read.nextOffset !== null : false;
    });
  /** Held-back queued cards not yet drawn, for the next page's name. */
  const queuedLeft = Math.max(
    0,
    queuedHidden.reduce((total, item) => total + item.hidden, 0) - heldShown,
  );
  /** A page on its way: the list says so at its end rather than going quiet. */
  const queuedPending =
    view === "queue" &&
    queuedPages.isFetching &&
    heldShown < queuedHidden.reduce((total, item) => total + item.hidden, 0);
  useEffect(() => {
    loadedPage.current = { view, count: triagePageSize };
    setTriageShown(triagePageSize);
    setPapercutShown(triagePageSize);
  }, [view]);
  const loadNextPage = () => {
    if (view === "queue") {
      loadQueued(queuedHidden);
      return;
    }
    const loaded = loadedPage.current;
    if (loaded.view !== view) {
      loadedPage.current = { view, count: triagePageSize };
    }
    const current = loadedPage.current;
    if (current.count >= totalInList) return;
    const next = Math.min(current.count + triagePageSize, totalInList);
    current.count = next;
    setShown(next);
  };
  const boardRead = state ? "loaded" : stateError ? "failed" : "loading";
  const releaseHold = (task: TaskSummary) =>
    void act(() =>
      setTask({ taskId: task.id, version: task.version, action: "release" }),
    );
  const keepHold = (task: TaskSummary, reason: string) =>
    void act(() =>
      setTask({
        taskId: task.id,
        version: task.version,
        action: "keep_hold",
        reason,
      }),
    );
  // Close finishes the drained step; Keep records the operator's reason and ends the episode.
  const drainedLaneProject = (lane: LaneView) => {
    const owners = laneProjects(lane, state?.projects ?? []);
    return owners.length === 1 ? owners[0]?.key : undefined;
  };
  const closeDrainedLane = (lane: LaneView, note: string) =>
    void act(async () => {
      const project = drainedLaneProject(lane);
      if (!project) throw new Error("Select a project before closing this lane.");
      return changeLaneStatus({ key: lane.key, project, status: "done", note });
    });
  const keepDrainedLane = (lane: LaneView, reason: string) =>
    void act(() =>
      keepLaneRpc({ key: lane.key, reason, author: "operator (board)" }),
    );
  const decisionTitle = (task: TaskSummary) => {
    const id = task.waitState?.decisionId;
    if (!id) return null;
    const decision = (decisions ?? []).find((item) => item.id === id);
    return decision?.headline ?? decision?.question;
  };
  const renderCard = (card: PipelineCard) => {
    const projectKey = card.kind === "decision" || card.kind === "lead" ? card.value.projectKey ?? undefined : undefined;
    const key = JSON.stringify([card.kind, projectKey, card.id]);
    const badgeFor = (task: TaskSummary) =>
      task.hostId
        ? (state?.projectBadges?.[task.hostId]?.[task.repoPath] ?? null)
        : null;
    // Line 1 names the project by its display name (nucleus#1515), not the checkout's.
    const projectLabel = (repoPath: string, origin?: string | null) =>
      projectForRepository(repoPath, origin)?.name;
    switch (card.kind) {
      case "decision": {
        const asking = card.value.askedBy.project;
        const project = asking && projectForRepository(asking.path, asking.origin);
        return (
          <DecisionCard
            key={key}
            decision={card.value}
            projectBadge={asking ? (state?.repositoryBadges?.[asking.path] ?? null) : null}
            projectLabel={project?.name}
            projectKey={project?.key}
            c={c}
            selected={openDecisionId === card.id && recordProject === projectKey}
            onPress={() => onSelectDecision(card.id, projectKey)}
          />
        );
      }
      case "raised":
        return (
          <HoldPromptCard
            key={key}
            busy={busy}
            onRelease={() => releaseHold(card.value)}
            onKeep={(reason) => keepHold(card.value, reason)}
            task={card.value}
            projectBadge={badgeFor(card.value)}
            projectLabel={projectLabel(
              card.value.repoPath,
              card.value.repository,
            )}
            c={c}
            selected={selected === card.id}
            onPress={() => onSelectTask(card.id)}
          />
        );
      case "lane_drain":
        return (
          <LaneDrainCard
            key={key}
            lane={card.value}
            c={c}
            busy={busy}
            selected={false}
            onPress={() => onOpenLane(card.value.key, drainedLaneProject(card.value))}
            project={
              card.value.repositories.length ? (
                <LeadProjectEyebrow
                  repositories={card.value.repositories}
                  projectForRepository={projectForRepository}
                  repositoryBadges={state?.repositoryBadges}
                  c={c}
                />
              ) : undefined
            }
            onClose={(note) => closeDrainedLane(card.value, note)}
            onKeep={(reason) => keepDrainedLane(card.value, reason)}
            projects={state?.projects ?? []}
            plans={plans}
          />
        );
      case "task":
        return (
          <TaskCard
            key={key}
            task={card.value}
            defaultHostId={state?.hostId}
            projectBadge={badgeFor(card.value)}
            projectLabel={projectLabel(
              card.value.repoPath,
              card.value.repository,
            )}
            board
            selected={selected === card.id}
            onPress={() => onSelectTask(card.id)}
            prState={state?.prStates[card.id]}
            c={c}
            decisionTitle={decisionTitle(card.value)}
          />
        );
      // Spec 026: an accepted submission with no task yet shows queued as "submitting" until its task appears.
      case "submission":
        return (
          <BoardCard
            key={key}
            c={c}
            label={`Queued: ${card.value.title}, Status: Submitting · accepted; creating its task`}
            kind="task"
            meta="Submitting"
            project={
              <CardProject
                name={
                  projectLabel(card.value.repoPath, card.value.repository) ??
                  projectName(card.value)
                }
                badge={state?.repositoryBadges?.[card.value.repoPath] ?? null}
                c={c}
              />
            }
            age={decisionAge(card.value.createdAt)}
            title={card.value.title}
            status={{
              tone: "muted",
              state: "Submitting",
              detail: "accepted; creating its task",
            }}
            selected={false}
            onPress={() => {}}
          />
        );
      case "lead":
        return (
          <TriageLeadCard
            key={key}
            lead={card.value}
            c={c}
            projectForRepository={projectForRepository}
            repositoryBadges={state?.repositoryBadges}
            selected={recordProject === projectKey && (selectedLeadId === card.id || openPapercutId === card.id)}
            onSelectLead={(id) => onSelectLead(id, null, projectKey)}
            onSelectPapercut={id => onSelectPapercut(id, projectKey)}
            // The Leads and Papercuts views list one kind, so line 1 starts
            // with the project; mixed lists keep the kind word.
            showKindWord={view !== "leads" && view !== "papercuts"}
          />
        );
      default:
        return null;
    }
  };
  /**
   * The Queue list (nucleus#1532): every queued task as one card, each project's
   * held-back tasks right after its shipped queued cards, in queue order. A project
   * with no shipped card before it ends the list.
   */
  const queuedList = () => {
    const cards = sections.flatMap((section) => section.cards);
    const repoPathOf = (card: PipelineCard) =>
      card.kind === "task" || card.kind === "submission"
        ? card.value.repoPath
        : null;
    const rows: React.ReactNode[] = [];
    const placed = new Set<string>();
    const placeHeld = (repoPath: string) => {
      if (placed.has(repoPath)) return;
      placed.add(repoPath);
      rows.push(
        ...heldQueued(repoPath).map((task) =>
          renderCard({
            kind: "task",
            id: task.id,
            lanes: task.lanes,
            value: task,
          }),
        ),
      );
    };
    cards.forEach((card, index) => {
      rows.push(renderCard(card));
      const repoPath = repoPathOf(card);
      if (!repoPath) return;
      if (
        !cards.slice(index + 1).some((later) => repoPathOf(later) === repoPath)
      )
        placeHeld(repoPath);
    });
    for (const item of queuedHidden) placeHeld(item.repoPath);
    return rows;
  };
  const viewCount = isTriageList ? totalInList : (legacyView ? counts[legacyView] : 0) + (rust?.tasks?.length ?? 0);
  const title = viewTitles[view];
  const total =
    sections.reduce((sum, section) => sum + section.cards.length, 0) +
    (view === "queue"
      ? queuedHidden.reduce((sum, item) => sum + item.hidden, 0)
      : 0);
  const readState = rust && !rust.tasks
    ? (rust.error ? "failed" : "loading")
    : rust && view === "needs" && state && !decisions
      ? (decisionsError ? "failed" : "loading")
      : legacyView ? boardRead : "loaded";
  const closedCount = closedItems?.length ?? 0;
  const countText = closedFilter
    ? closedItems
      ? `${closedCount} item${closedCount === 1 ? "" : "s"}`
      : closedQuery.error
        ? "Not loaded"
        : "Loading…"
    : readState === "loaded"
      ? `${viewCount} item${viewCount === 1 ? "" : "s"}`
      : readState === "failed"
        ? "Not loaded"
        : "Loading…";
  return (
    <View
      accessibilityLabel={`${title} list`}
      style={{ flex: 1, minHeight: 0 }}
    >
      <View
        style={{
          gap: space.sm,
          paddingHorizontal: space.md,
          paddingTop: space.md,
          paddingBottom: space.sm,
        }}
      >
        {/* The header row: the title, then the item count, then the Leads tag filter at the row's end. */}
        <View
          style={{
            ...row,
            flexWrap: "nowrap",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{
              flexShrink: 1,
              color: c.foreground,
              fontSize: typeScale.section.fontSize,
              lineHeight: typeScale.section.lineHeight,
              fontWeight: "600",
            }}
          >
            {title}
          </Text>
          <View
            style={{ ...row, flexWrap: "nowrap", gap: space.sm, flexShrink: 0 }}
          >
            <Text
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              {countText}
            </Text>
            {triageView && (
              <DropdownSelect
                compact
                c={c}
                label={triageView === "leads" ? "Filter leads by state" : "Filter papercuts by state"}
                value={triageFilters[triageView]}
                options={stateOptions.map((state) => ({ value: state, label: state }))}
                onChange={(value) => {
                  const filter = stateOptions.find((state) => state === value);
                  if (!filter) return;
                  setTriageFilters((current) => ({ ...current, [triageView]: filter }));
                  setShown(triagePageSize);
                  loadedPage.current = { view, count: triagePageSize };
                }}
                minWidth={80}
              />
            )}
            {view === "leads" && (
              <DropdownSelect
                compact
                c={c}
                label="Filter leads by tag"
                value={triageTag ?? ""}
                options={triageTagOptions}
                onChange={(value) => {
                  setTriageTag(value || null);
                  setTriageShown(triagePageSize);
                  loadedPage.current = { view: "leads", count: triagePageSize };
                }}
                minWidth={110}
              />
            )}
          </View>
        </View>
      </View>
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingVertical: space.xs }}
      >
        <BoardCardVariantContext.Provider value="row">
          {rust && <RustListRows key={view} view={view} rust={rust} c={c} />}
          {closedFilter && (
            // Closed has no board cards (triageCards returns none), so these rows are the list.
            <View style={{ gap: space.xxs }}>
              {(closedItems ?? []).map((item) => {
                const word = item.kind === "papercut" ? "Papercut" : "Lead";
                const status =
                  item.state === "promoted"
                    ? { tone: "success" as const, state: "Promoted" }
                    : item.disposition === "completed"
                      ? { tone: "success" as const, state: "Dropped · completed" }
                      : { tone: "muted" as const, state: "Dropped · deprecated" };
                const selectedHere =
                  recordProject === item.projectKey &&
                  (item.kind === "papercut" ? openPapercutId : selectedLeadId) === item.id;
                return (
                  <BoardCard
                    key={`${item.projectKey}/${item.id}`}
                    c={c}
                    kind={item.kind}
                    label={`${word}: ${item.title}, Status: ${status.state}`}
                    title={item.title}
                    project={<CardProject c={c} name={item.projectName} projectKey={item.projectKey} />}
                    status={status}
                    age={item.atMs === null ? null : relativeAge(item.atMs)}
                    selected={selectedHere}
                    onPress={() =>
                      item.kind === "papercut"
                        ? onSelectPapercut(item.id, item.projectKey)
                        : onSelectLead(item.id, null, item.projectKey)
                    }
                  />
                );
              })}
              {closedQuery.error ? (
                <BoardCard c={c} selected={false} title="Could not load closed items" label="Retry loading closed items"
                  onPress={() => void closedQuery.refetch()} status={{ state: "Retry", tone: "warning" }} />
              ) : null}
            </View>
          )}
          {view === "queue" ? (
            <View style={{ gap: space.xxs }}>{queuedList()}</View>
          ) : (
            sections.map((section) => {
              const visible =
                isTriageList && section.cards.length > shown
                  ? section.cards.slice(0, shown)
                  : section.cards;
              return (
                <View key={section.id} style={{ gap: space.xxs }}>
                  {visible.map(renderCard)}
                </View>
              );
            })
          )}
          {isTriageList && (
            <PageSentinel
              c={c}
              more={shown < totalInList}
              page={shown}
              label={pageLabel(
                Math.min(triagePageSize, totalInList - shown),
                view === "papercuts" ? "papercut" : "lead",
              )}
              onMore={loadNextPage}
            />
          )}
          {queuedPending && (
            <Text
              style={{ ...muted(c), textAlign: "center", padding: space.md }}
            >
              Loading queued tasks…
            </Text>
          )}
          {view === "queue" && (
            <PageSentinel
              c={c}
              more={queuedMore}
              page={heldShown}
              label={pageLabel(Math.min(queuedPageSize, queuedLeft), "queued task")}
              onMore={loadNextPage}
            />
          )}
          {/* A failed page read never stops the list silently: the end asks to try again.
              While the retry's own read is on its way, the loading row speaks for it. */}
          {view === "queue" && queuedPages.error && !queuedPages.isFetching && (
            <BoardCard
              key="queued-page-retry"
              label="Could not load queued tasks. Try again."
              c={c}
              selected={false}
              onPress={() => void queuedPages.refetch()}
              title="Could not load queued tasks."
              status={{
                tone: "warning",
                state: "Try again",
                detail: "the rest of the queue did not load",
              }}
            />
          )}
        </BoardCardVariantContext.Provider>
        {/* A loading or failed read is never shown as empty (nucleus-ui finding 1). One list has one empty state. */}
        {closedFilter ? (
          closedItems && closedCount === 0 ? (
            <Text style={{ ...muted(c), textAlign: "center", padding: space.xl }}>Nothing here.</Text>
          ) : !closedItems && !closedQuery.error ? (
            <Text style={{ ...muted(c), textAlign: "center", padding: space.xl }}>Loading…</Text>
          ) : null
        ) : ((!rust && boardRead !== "loaded") || (readState === "loaded" && total === 0 && !rust?.tasks?.length)) && (
          <Text style={{ ...muted(c), textAlign: "center", padding: space.xl }}>
            {boardRead === "failed"
              ? "The board could not be read; see the error above."
              : boardRead === "loading" ||
                  ((view === "leads" || view === "papercuts") && leadsLoading)
                ? "Loading…"
                : view === "leads" &&
                    triageTag &&
                    triageCards(board, "leads", "All").length === 0
                  ? "No records carry this tag."
                  : "Nothing here."}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

const rustPageSize = 25;

export function RustListRows({ c, rust, view }: {
  c: Colors;
  rust: NonNullable<InboxListProps["rust"]>;
  view: InboxListProps["view"];
}) {
  const [limit, setLimit] = useState(rustPageSize);
  const tasks = rust.tasks ?? [];
  const remaining = tasks.length - limit;
  // Ages read the clock, as TypeScript cards do; a list without one does not tick.
  useTick(tasks.some((task) => rustCardAgeAt(task) !== null) ? 30_000 : null);
  return <>
    {tasks.slice(0, limit).map((task) => {
      // The task number alone, as on TypeScript cards; the project shows beside it.
      const reference = task.number == null ? rustTaskLabel(task) : `#${task.number}`;
      const question = view === "needs" ? task.question : null;
      const title = question ? rustQuestionText(question) : task.title || reference;
      const detail = task.hold?.reason ?? rustWaitDetail(task);
      const ageAt = rustCardAgeAt(task);
      const project = rust.project(task);
      const canPrioritize = task.phase === "queued" || task.wait === "capacity";
      const promoted = task.queuePriority === "promoted";
      return <BoardCard key={task.identity.id} c={c} kind={question ? "decision" : "task"}
        title={title} label={title === reference ? title : `${reference}, ${title}`} meta={title === reference ? null : reference}
        project={<CardProject c={c} name={project.name} projectKey={project.key} badge={project.badge} />}
        status={{
          tone: task.phase === "done" ? "success" : task.hold || task.attention === "attention" ? "warning" : "muted",
          state: task.stateLabel, detail: question ? null : detail,
        }}
        age={ageAt === null ? null : relativeAge(ageAt)}
        flags={canPrioritize && promoted ? <Badge label="Promoted" tone="accent" c={c} a11y="Promoted" /> : undefined}
        actions={canPrioritize && rust.onCommand ? (
          <View style={{ ...row, gap: space.xs }}>
            <Button
              small
              c={c}
              disabled={rust.busy}
              text={promoted ? "Demote" : "Promote"}
              label={`${promoted ? "Demote" : "Promote"} ${reference}`}
              onPress={() => rust.onCommand?.(task.identity.id, promoted ? { demote: task.version } : { promote: task.version })}
            />
          </View>
        ) : undefined}
        progress={<RustTaskProgress task={task} c={c} />}
        selected={rust.selected === task.identity.id} onPress={() => rust.onSelect(task.identity.id)} />;
    })}
    <PageSentinel c={c} more={remaining > 0} page={limit}
      label={pageLabel(Math.min(rustPageSize, remaining), "task")}
      onMore={() => setLimit((current) => current + rustPageSize)} />
    {Boolean(rust.error) && <BoardCard c={c} selected={false} title="Could not load engine tasks"
      label="Retry loading engine tasks" onPress={rust.retry}
      status={{ state: "Retry", tone: "warning" }} />}
    {!rust.tasks && !rust.error &&
      <Text style={{ ...muted(c), textAlign: "center", padding: space.md }}>Loading engine tasks…</Text>}
  </>;
}
