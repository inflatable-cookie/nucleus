import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as api from "../../shared/contracts";
import {
  type DecisionView,
  type BoardLead,
  type BoardLeadLink,
  type LaneView,
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
  leadsCards,
  type InboxView,
} from "../../shared/inbox-board";
import { useRpc } from "../shell";
import { Button, DropdownSelect, muted, row, type Colors } from "../controls";
import { projectName } from "./text";
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
import type { BoardAct } from "./use-board-data";
import { space, type as typeScale } from "../design";

type Project = UiQueueState["projects"][number];

/**
 * The list's view state: the Leads tag filter, the pages of Leads and Papercuts, and
 * the open queued-more page and its read. The shell holds it, so leaving a view and
 * coming back keeps them.
 */
export function usePipelineState() {
  const fetchQueuedPage = useRpc(api.queuePage);
  const [queueRepo, setQueueRepo] = useState<string | null>(null);
  const [queueOffset, setQueueOffset] = useState(0);
  const [triageTag, setTriageTag] = useState<string | null>(null);
  // Leads and papercuts load in pages of eight as the list approaches its end.
  const [triageShown, setTriageShown] = useState(triagePageSize);
  const [papercutShown, setPapercutShown] = useState(triagePageSize);
  const queuedPage = useQuery({
    queryKey: ["nucleus", "queued-page", queueRepo, queueOffset],
    queryFn: () =>
      fetchQueuedPage({ repoPath: queueRepo!, offset: queueOffset, limit: 25 }),
    enabled: Boolean(queueRepo),
    refetchInterval: 4000,
  });
  return {
    queueRepo,
    setQueueRepo,
    queueOffset,
    setQueueOffset,
    queuedPage,
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
        lanes: state?.lanes ?? [],
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
      state?.lanes,
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
  const scopeLeads = leadsCards(columns).flatMap((card) =>
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
  // The menu counts ignore the tag filter: it narrows the list, not the inbox. The list's
  // own header counts what it shows.
  const counts = useMemo(
    () => inboxCounts(columns, hiddenQueued),
    [columns, hiddenQueued],
  );
  const listCounts = triageTag ? inboxCounts(board, hiddenQueued) : counts;
  return { board, counts, listCounts, triageTagOptions };
}
export type InboxBoard = ReturnType<typeof useInboxBoard>;

export type InboxListProps = {
  c: Colors;
  state: UiQueueState | undefined;
  stateError: unknown;
  inbox: InboxBoard;
  view: Exclude<InboxView, "planning">;
  leadsLoading: boolean;
  decisions: DecisionView[] | undefined;
  /** Per project, the queued tasks the board holds back for its "…and N more" row. */
  queuedHidden: Array<{ repoPath: string; hidden: number }>;
  projectForRepository: (
    repoPath: string,
    origin?: string | null,
  ) => Project | undefined;
  selected: string | null;
  selectedLeadId: string | null;
  openPapercutId: string | null;
  openDecisionId: string | null;
  onSelectTask: (id: string) => void;
  onSelectDecision: (id: string) => void;
  onSelectLead: (id: string, lane: null) => void;
  onSelectPapercut: (id: string) => void;
  /** Opens a lane in the plan view, the drained-lane card's press (nucleus#1511). */
  onOpenLane: (key: string) => void;
  busy: boolean;
  act: BoardAct;
  /** The list's view state the shell keeps across views (`usePipelineState`). */
  pipeline: PipelineState;
};

const viewTitles: Record<Exclude<InboxView, "planning">, string> = {
  needs: "Needs you",
  leads: "Leads",
  papercuts: "Papercuts",
  queue: "Queue",
  working: "Working",
  review: "In review",
  closing: "Closing",
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
  view,
  leadsLoading,
  decisions,
  queuedHidden,
  projectForRepository,
  selected,
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
}: InboxListProps) {
  const setTask = useRpc(api.taskControl);
  const changeLaneStatus = useRpc(api.laneStatus);
  const keepLaneRpc = useRpc(api.laneKeep);
  const {
    queueRepo,
    setQueueRepo,
    queueOffset,
    setQueueOffset,
    queuedPage,
    triageTag,
    setTriageTag,
    triageShown,
    setTriageShown,
    papercutShown,
    setPapercutShown,
  } = pipeline;
  const { board, listCounts: counts, triageTagOptions } = inbox;
  const sections = inboxSections(board, view);
  const listMeasurements = useRef<{
    view: typeof view;
    viewportHeight: number;
    contentHeight: number | null;
  }>({ view, viewportHeight: 0, contentHeight: null });
  const loadedPage = useRef({ view, count: triagePageSize });
  const isTriageList = view === "leads" || view === "papercuts";
  const shown = view === "papercuts" ? papercutShown : triageShown;
  const setShown = view === "papercuts" ? setPapercutShown : setTriageShown;
  const totalInList = sections.reduce(
    (total, section) => total + section.cards.length,
    0,
  );
  useEffect(() => {
    // Switching views keeps the measured viewport height: the ScrollView does
    // not resize, so its layout event never refires and only a content-size
    // change can fill a short list. Only the content height resets.
    listMeasurements.current = {
      view,
      viewportHeight: listMeasurements.current.viewportHeight,
      contentHeight: null,
    };
    loadedPage.current = { view, count: triagePageSize };
    setTriageShown(triagePageSize);
    setPapercutShown(triagePageSize);
  }, [view]);
  const loadNextPage = () => {
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
  const fillIfNotScrollable = (
    viewportHeight: number,
    contentHeight: number,
  ) => {
    if (
      isTriageList &&
      viewportHeight > 0 &&
      contentHeight <= viewportHeight &&
      shown < totalInList
    )
      loadNextPage();
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
  const closeDrainedLane = (lane: LaneView) =>
    void act(() => changeLaneStatus({ key: lane.key, status: "done" }));
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
    const key = `${card.kind}:${card.id}`;
    const badgeFor = (task: TaskSummary) =>
      task.hostId
        ? (state?.projectBadges?.[task.hostId]?.[task.repoPath] ?? null)
        : null;
    // Line 1 names the project by its display name (nucleus#1515), not the checkout's.
    const projectLabel = (repoPath: string, origin?: string | null) =>
      projectForRepository(repoPath, origin)?.name;
    switch (card.kind) {
      case "decision":
        return (
          <DecisionCard
            key={key}
            decision={card.value}
            projectBadge={
              card.value.askedBy.project
                ? (state?.repositoryBadges?.[card.value.askedBy.project.path] ??
                  null)
                : null
            }
            projectLabel={
              card.value.askedBy.project
                ? projectLabel(
                    card.value.askedBy.project.path,
                    card.value.askedBy.project.origin,
                  )
                : undefined
            }
            c={c}
            selected={openDecisionId === card.id}
            onPress={() => onSelectDecision(card.id)}
          />
        );
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
            onPress={() => onOpenLane(card.value.key)}
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
            onClose={() => closeDrainedLane(card.value)}
            onKeep={(reason) => keepDrainedLane(card.value, reason)}
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
            selected={selectedLeadId === card.id || openPapercutId === card.id}
            onSelectLead={(id) => onSelectLead(id, null)}
            onSelectPapercut={onSelectPapercut}
            // The Leads and Papercuts views list one kind, so line 1 starts
            // with the project; mixed lists keep the kind word.
            showKindWord={view !== "leads" && view !== "papercuts"}
          />
        );
      default:
        return null;
    }
  };
  const moreRow = (
    key: string,
    label: string,
    title: string,
    onPress: () => void,
    selectedRow = false,
  ) => (
    <BoardCard
      key={key}
      label={label}
      selected={selectedRow}
      c={c}
      onPress={onPress}
      title={title}
    />
  );
  const queuedMore =
    view === "queue"
      ? queuedHidden.map((item) => (
          <View key={item.repoPath}>
            {moreRow(
              item.repoPath,
              `${item.hidden} more queued in ${projectName(item)}`,
              `…and ${item.hidden} more in ${projectName(item)}`,
              () => {
                setQueueRepo(
                  queueRepo === item.repoPath ? null : item.repoPath,
                );
                setQueueOffset(0);
              },
              queueRepo === item.repoPath,
            )}
            {queueRepo === item.repoPath && (
              <View
                style={{
                  gap: space.xxs,
                  padding: space.md,
                  marginHorizontal: space.xs,
                }}
              >
                {queuedPage.isLoading && (
                  <Text style={{ color: c.foregroundMuted }}>
                    Loading queued tasks…
                  </Text>
                )}
                {queuedPage.error && (
                  <Text style={{ color: c.foreground }}>
                    Could not load queued tasks. Try again.
                  </Text>
                )}
                {(queuedPage.data?.tasks ?? [])
                  .filter(
                    (page) => !state?.tasks.some((task) => task.id === page.id),
                  )
                  .map((page) => (
                    <Pressable
                      key={page.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${page.title}`}
                      onPress={() => onSelectTask(page.id)}
                    >
                      <Text numberOfLines={1} style={{ color: c.foreground }}>
                        {page.reference ?? ""} {page.title} · {page.reason}
                      </Text>
                    </Pressable>
                  ))}
                <View style={{ ...row, gap: space.xs }}>
                  <Button
                    small
                    c={c}
                    text="Previous"
                    disabled={queueOffset === 0}
                    onPress={() =>
                      setQueueOffset(Math.max(0, queueOffset - 25))
                    }
                  />
                  <Button
                    small
                    c={c}
                    text="Next"
                    disabled={queuedPage.data?.nextOffset == null}
                    onPress={() => setQueueOffset(queuedPage.data!.nextOffset!)}
                  />
                </View>
              </View>
            )}
          </View>
        ))
      : null;
  const viewCount = counts[view];
  const title = viewTitles[view];
  const total =
    sections.reduce((sum, section) => sum + section.cards.length, 0) +
    (view === "queue" ? queuedHidden.length : 0);
  const countText =
    boardRead === "loaded"
      ? `${viewCount} item${viewCount === 1 ? "" : "s"}`
      : boardRead === "failed"
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
                  listMeasurements.current.contentHeight = null;
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
        onLayout={(event) => {
          const height = event.nativeEvent.layout.height;
          const current = listMeasurements.current;
          listMeasurements.current = {
            ...current,
            view,
            viewportHeight: height,
          };
          if (current.view === view && current.contentHeight !== null)
            fillIfNotScrollable(height, current.contentHeight);
        }}
        onContentSizeChange={(_width, height) => {
          const current = listMeasurements.current;
          listMeasurements.current = {
            ...current,
            view,
            contentHeight: height,
          };
          fillIfNotScrollable(
            current.view === view ? current.viewportHeight : 0,
            height,
          );
        }}
        onScroll={(event) => {
          if (!isTriageList) return;
          const { contentOffset, contentSize, layoutMeasurement } =
            event.nativeEvent;
          if (
            contentOffset.y + layoutMeasurement.height >=
            contentSize.height - layoutMeasurement.height
          )
            loadNextPage();
        }}
        scrollEventThrottle={16}
      >
        <BoardCardVariantContext.Provider value="row">
          {sections.map((section) => {
            const visible =
              isTriageList && section.cards.length > shown
                ? section.cards.slice(0, shown)
                : section.cards;
            return (
              <View key={section.id} style={{ gap: space.xxs }}>
                {visible.map(renderCard)}
              </View>
            );
          })}
          {queuedMore}
        </BoardCardVariantContext.Provider>
        {/* A loading or failed read is never shown as empty (nucleus-ui finding 1). One list has one empty state. */}
        {(boardRead !== "loaded" || total === 0) && (
          <Text style={{ ...muted(c), textAlign: "center", padding: space.xl }}>
            {boardRead === "failed"
              ? "The board could not be read; see the error above."
              : boardRead === "loading" ||
                  ((view === "leads" || view === "papercuts") && leadsLoading)
                ? "Loading…"
                : view === "leads" &&
                    triageTag &&
                    leadsCards(board).length === 0
                  ? "No records carry this tag."
                  : "Nothing here."}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
