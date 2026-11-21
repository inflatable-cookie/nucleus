import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as api from "../../shared/contracts";
import {
  taskNumberLabel,
  type DecisionView,
  type BoardLead,
  type BoardLeadLink,
  type LaneView,
  type TaskSummary,
  type UiQueueState,
} from "../../shared/contracts";
import {
  pipelineBoard,
  triagePage,
  triagePageSize,
  type PipelineCard,
} from "../../shared/pipeline-board";
import {
  inboxCounts,
  inboxSections,
  leadsCards,
  type ActiveSection,
  type InboxView,
  type LeadsTab,
} from "../../shared/inbox-board";
import { isGeneralDecision } from "../../shared/decision-project";
import { useRpc, Icon } from "../shell";
import { Button, DropdownSelect, muted, row, type Colors } from "../controls";
import { projectName } from "./text";
import { RecordChips } from "./badges";
import {
  BoardCard,
  BoardCardVariantContext,
  TaskCard,
  DecisionCard,
  HoldPromptCard,
  LaneDrainCard,
} from "./cards";
import { TriageLeadCard } from "./triage-lead-card";
import type { BoardAct } from "./use-board-data";
import { space, type as typeScale, radius } from "../design";

type Project = UiQueueState["projects"][number];

/**
 * The list's view state: the Leads tag filter and page, and the open queued-more
 * page and its read. The shell holds it, so leaving a view and coming back keeps them.
 */
export function usePipelineState() {
  const fetchQueuedPage = useRpc(api.queuePage);
  const [queueRepo, setQueueRepo] = useState<string | null>(null);
  const [queueOffset, setQueueOffset] = useState(0);
  const [triageTag, setTriageTag] = useState<string | null>(null);
  // Leads shown (Tom, 2026-11-07: one page at a time); a tag change starts it back at one page.
  const [triageShown, setTriageShown] = useState(triagePageSize);
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
export function useInboxBoard({ state, selection, boardLeads, leadLinks, decisions, hiddenQueued, triageTag }: InboxBoardInput) {
  const selectionKey = selection.join("\n");
  const columns = useMemo(
    () => pipelineBoard({
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
    [state?.projects, state?.lanes, state?.tasks, state?.pendingSubmissions, selectionKey, boardLeads, leadLinks, decisions],
  );
  const triageScopeLeads = columns.cards.Triage.flatMap((card) => card.kind === "lead" ? [card.value] : []);
  const board = {
    counts: columns.counts,
    cards: { ...columns.cards, Triage: columns.cards.Triage.filter((card) => card.kind !== "lead" || !triageTag || card.value.tags.includes(triageTag)) },
  };
  // The tag filter lists only tags on leads in the current scope, with counts;
  // tags from other projects or briefed leads matched nothing (Tom, 2026-10-15).
  const tagCounts = new Map<string, number>();
  for (const lead of triageScopeLeads) for (const tag of lead.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  if (triageTag && !tagCounts.has(triageTag)) tagCounts.set(triageTag, 0);
  // Reserved tags lead under their display names; free-form tags follow alphabetically.
  const triageTagOptions = [
    { value: "", label: `All tags (${triageScopeLeads.length})` },
    ...[...tagCounts]
      .sort(([a], [b]) => Number(!api.RESERVED_LEAD_TAGS[a]) - Number(!api.RESERVED_LEAD_TAGS[b]) || a.localeCompare(b))
      .map(([tag, count]) => ({ value: tag, label: `${api.RESERVED_LEAD_TAGS[tag] ?? tag} (${count})`, group: api.RESERVED_LEAD_TAGS[tag] ? "Reserved" : "Tags" })),
  ];
  // The menu counts ignore the tag filter: it narrows the list, not the inbox. The list's
  // own header and tabs count what it shows, as the Triage header did.
  const counts = useMemo(() => inboxCounts(columns, hiddenQueued), [columns, hiddenQueued]);
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
  activeSection: ActiveSection | null;
  leadsTab: LeadsTab;
  onLeadsTab: (tab: LeadsTab) => void;
  leadsLoading: boolean;
  decisions: DecisionView[] | undefined;
  /** Per project, the queued tasks the board holds back for its "…and N more" row. */
  queuedHidden: Array<{ repoPath: string; hidden: number }>;
  parkedRepository: (repoPath: string, origin?: string | null) => boolean;
  projectForRepository: (repoPath: string, origin?: string | null) => Project | undefined;
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

const viewTitles: Record<Exclude<InboxView, "planning">, string> = { needs: "Needs you", leads: "Leads", queue: "Queue", active: "Active" };
const sectionTitles: Record<ActiveSection, string> = { working: "Working", review: "In review", closing: "Closing" };

/**
 * The inbox list (Tom, 2026-11-21): the open menu view's cards in one scrolling
 * list, grouped under section headers, each card drawn as a row. A card's own
 * content and actions are unchanged from the kanban board.
 */
export function InboxList({
  c, state, stateError, inbox, view, activeSection, leadsTab, onLeadsTab, leadsLoading, decisions, queuedHidden,
  parkedRepository, projectForRepository, selected, selectedLeadId, openPapercutId, openDecisionId,
  onSelectTask, onSelectDecision, onSelectLead, onSelectPapercut, onOpenLane, busy, act, pipeline,
}: InboxListProps) {
  const setTask = useRpc(api.taskControl);
  const changeLaneStatus = useRpc(api.laneStatus);
  const keepLaneRpc = useRpc(api.laneKeep);
  const { queueRepo, setQueueRepo, queueOffset, setQueueOffset, queuedPage, triageTag, setTriageTag, triageShown, setTriageShown } = pipeline;
  const { board, listCounts: counts, triageTagOptions } = inbox;
  const boardRead = state ? "loaded" : stateError ? "failed" : "loading";
  const sections = inboxSections(board, view, { active: activeSection, leads: leadsTab });
  const releaseHold = (task: TaskSummary) => void act(() => setTask({ taskId: task.id, version: task.version, action: "release" }));
  const keepHold = (task: TaskSummary, reason: string) => void act(() => setTask({ taskId: task.id, version: task.version, action: "keep_hold", reason }));
  // Close finishes the drained step; Keep records the operator's reason and ends the episode.
  const closeDrainedLane = (lane: LaneView) => void act(() => changeLaneStatus({ key: lane.key, status: "done" }));
  const keepDrainedLane = (lane: LaneView, reason: string) => void act(() => keepLaneRpc({ key: lane.key, reason, author: "operator (board)" }));
  const decisionLinkedTaskProjects = (decision: DecisionView) =>
    isGeneralDecision(decision)
      ? [...new Set(decision.links.tasks.flatMap((id) => {
          const task = state?.tasks.find((item) => item.id === id);
          return task ? [projectName(task)] : [];
        }))]
      : [];
  const decisionLinkedTaskLabels = (decision: DecisionView) =>
    decision.links.tasks.map((id) => {
      const task = state?.tasks.find((item) => item.id === id);
      if (!task) return id;
      const reference = task.reference ?? (task.number ? taskNumberLabel(task, true) : null);
      return reference ? `${reference} · ${task.title}` : task.title;
    });
  // One lookup for the decision chip on task, lead and papercut rows: how many open decisions link each record (Spec 032).
  const decisionLinkCounts = new Map<string, number>();
  for (const decision of decisions ?? [])
    for (const id of [...decision.links.tasks, ...decision.links.leads, ...decision.links.papercuts])
      decisionLinkCounts.set(id, (decisionLinkCounts.get(id) ?? 0) + 1);
  const decisionTitle = (task: TaskSummary) => {
    const id = task.waitState?.decisionId;
    if (!id) return null;
    const decision = (decisions ?? []).find((item) => item.id === id);
    return decision?.headline ?? decision?.question;
  };
  const metaText = (text: string, lines = 1) => (
    <Text numberOfLines={lines} ellipsizeMode="tail" style={{ ...muted(c), fontSize: typeScale.metadata.fontSize, lineHeight: typeScale.metadata.lineHeight, flexShrink: 1 }}>{text}</Text>
  );
  const renderCard = (card: PipelineCard) => {
    const key = `${card.kind}:${card.id}`;
    switch (card.kind) {
      case "decision":
        return <DecisionCard key={key} decision={card.value} linkedTaskLabels={decisionLinkedTaskLabels(card.value)}
          linkedTaskProjects={decisionLinkedTaskProjects(card.value)} c={c} selected={openDecisionId === card.id} onPress={() => onSelectDecision(card.id)} />;
      case "raised":
        return <HoldPromptCard key={key} busy={busy} onRelease={() => releaseHold(card.value)} onKeep={(reason) => keepHold(card.value, reason)}
          task={card.value} c={c} selected={selected === card.id} onPress={() => onSelectTask(card.id)} />;
      case "lane_drain":
        return <LaneDrainCard key={key} lane={card.value} c={c} busy={busy} selected={false} onPress={() => onOpenLane(card.value.key)}
          onClose={() => closeDrainedLane(card.value)} onKeep={(reason) => keepDrainedLane(card.value, reason)} />;
      case "task":
        return <TaskCard key={key} task={card.value} defaultHostId={state?.hostId}
          projectBadge={card.value.hostId ? (state?.projectBadges?.[card.value.hostId]?.[card.value.repoPath] ?? null) : null}
          board selected={selected === card.id} onPress={() => onSelectTask(card.id)} prState={state?.prStates[card.id]} c={c}
          parked={parkedRepository(card.value.repoPath, card.value.repository)} decisions={decisionLinkCounts.has(card.id)} decisionTitle={decisionTitle(card.value)} />;
      // Spec 026: an accepted submission with no task yet shows queued as "submitting" until its task appears.
      case "submission":
        return <BoardCard key={key} c={c} label={`Queued: ${card.value.title}`}
          eyebrow={<><Icon name="Folder" size={12} color={c.foregroundMuted} />{metaText(projectName(card.value))}</>}
          title={<Text numberOfLines={2} style={{ color: c.foreground, fontWeight: "600", fontSize: typeScale.body.fontSize }}>{card.value.title}</Text>}
          chips={<RecordChips c={c} chips={["Submitting"]} />} snippet={metaText("Accepted; creating its task", 2)} selected={false} onPress={() => {}} />;
      case "lead":
        // The Leads view's tabs already split leads from papercuts, so the kind chip
        // would repeat the tab on every row (nucleus#1511).
        return <TriageLeadCard key={key} lead={card.value} c={c} showKind={false} projectForRepository={projectForRepository} repositoryBadges={state?.repositoryBadges}
          selected={selectedLeadId === card.id || openPapercutId === card.id} onSelectLead={(id) => onSelectLead(id, null)} onSelectPapercut={onSelectPapercut} />;
      default:
        return null;
    }
  };
  const moreRow = (key: string, label: string, title: string, onPress: () => void, selectedRow = false) => (
    <BoardCard key={key} label={label} selected={selectedRow} c={c} onPress={onPress} eyebrow={null}
      title={<Text numberOfLines={1} style={{ color: c.foreground, fontWeight: "600", fontSize: typeScale.body.fontSize }}>{title}</Text>} />
  );
  const queuedMore = view === "queue" ? queuedHidden.map((item) => (
    <View key={item.repoPath}>
      {moreRow(item.repoPath, `${item.hidden} more queued in ${projectName(item)}`, `…and ${item.hidden} more in ${projectName(item)}`, () => {
        setQueueRepo(queueRepo === item.repoPath ? null : item.repoPath);
        setQueueOffset(0);
      }, queueRepo === item.repoPath)}
      {queueRepo === item.repoPath && <View style={{ gap: space.xxs, padding: space.md, borderBottomWidth: 1, borderBottomColor: c.border }}>
        {queuedPage.isLoading && <Text style={{ color: c.foregroundMuted }}>Loading queued tasks…</Text>}
        {queuedPage.error && <Text style={{ color: c.foreground }}>Could not load queued tasks. Try again.</Text>}
        {(queuedPage.data?.tasks ?? []).filter((page) => !state?.tasks.some((task) => task.id === page.id)).map((page) => (
          <Pressable key={page.id} accessibilityRole="button" accessibilityLabel={`Open ${page.title}`} onPress={() => onSelectTask(page.id)}>
            <Text numberOfLines={1} style={{ color: c.foreground }}>{page.reference ?? ""} {page.title} · {page.reason}</Text>
          </Pressable>
        ))}
        <View style={{ ...row, gap: space.xs }}>
          <Button small c={c} text="Previous" disabled={queueOffset === 0} onPress={() => setQueueOffset(Math.max(0, queueOffset - 25))} />
          <Button small c={c} text="Next" disabled={queuedPage.data?.nextOffset == null} onPress={() => setQueueOffset(queuedPage.data!.nextOffset!)} />
        </View>
      </View>}
    </View>
  )) : null;
  const viewCount = view === "needs" ? counts.needs : view === "leads" ? counts.leads : view === "queue" ? counts.queue
    : activeSection ? counts.activeBySection[activeSection] : counts.active;
  const title = view === "active" && activeSection ? sectionTitles[activeSection] : viewTitles[view];
  const total = sections.reduce((sum, section) => sum + section.cards.length, 0) + (view === "queue" ? queuedHidden.length : 0);
  const grouped = sections.length > 1;
  return (
    <View accessibilityLabel={`${title} list`} style={{ flex: 1, minHeight: 0 }}>
      <View style={{ gap: space.sm, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.sm }}>
        <View style={{ ...row, flexWrap: "nowrap", justifyContent: "space-between" }}>
          <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: typeScale.section.fontSize, lineHeight: typeScale.section.lineHeight, fontWeight: "600" }}>{title}</Text>
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            {boardRead === "loaded" ? `${viewCount} item${viewCount === 1 ? "" : "s"}` : boardRead === "failed" ? "Not loaded" : "Loading…"}
          </Text>
        </View>
        {view === "leads" && <View style={{ ...row, flexWrap: "nowrap", gap: space.xs }}>
          <View accessibilityRole="tablist" accessibilityLabel="Leads and papercuts" style={{ flexDirection: "row", flex: 1, padding: 2, gap: 2, borderRadius: radius.control, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}>
            {(["leads", "papercuts"] as const).map((tab) => {
              const on = leadsTab === tab;
              return <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={`${tab === "leads" ? "Leads" : "Papercuts"} tab, ${counts.leadsByTab[tab]}`}
                onPress={() => { onLeadsTab(tab); setTriageShown(triagePageSize); }}
                style={{ flex: 1, minHeight: 28, alignItems: "center", justifyContent: "center", borderRadius: radius.control - 2, backgroundColor: on ? c.surface2 : "transparent" }}>
                <Text style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: typeScale.metadata.fontSize, fontWeight: on ? "600" : "400" }}>{`${tab === "leads" ? "Leads" : "Papercuts"} ${counts.leadsByTab[tab]}`}</Text>
              </Pressable>;
            })}
          </View>
          <DropdownSelect compact c={c} label="Filter leads by tag" value={triageTag ?? ""} options={triageTagOptions}
            onChange={(value) => { setTriageTag(value || null); setTriageShown(triagePageSize); }} minWidth={110} />
        </View>}
      </View>
      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ borderTopWidth: 1, borderTopColor: c.border }}>
        <BoardCardVariantContext.Provider value="row">
          {sections.map((section) => {
            // Leads show one page at a time; the "…and N more" row loads the next.
            const page = view === "leads" ? triagePage(section.cards, triageShown) : null;
            const visible = page ? page.visible : section.cards;
            return <View key={section.id} accessibilityLabel={`${section.label} section, ${section.cards.length}`}>
              {grouped && <View style={{ ...row, flexWrap: "nowrap", justifyContent: "space-between", paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.xxs, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface0 }}>
                <Text accessibilityRole="header" style={{ ...muted(c), fontSize: typeScale.metadata.fontSize, fontWeight: "600", letterSpacing: 0.4, textTransform: "uppercase" }}>{section.label}</Text>
                <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>{boardRead === "loaded" ? section.cards.length : "…"}</Text>
              </View>}
              {visible.map(renderCard)}
              {page && page.hidden > 0 && moreRow(`${section.id}-more`, `Show ${page.hidden} more ${section.label.toLowerCase()}`, `…and ${page.hidden} more`, () => setTriageShown(triageShown + triagePageSize))}
              {grouped && boardRead === "loaded" && !section.cards.length && <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize, paddingHorizontal: space.md, paddingVertical: space.sm }}>Nothing here.</Text>}
            </View>;
          })}
          {queuedMore}
        </BoardCardVariantContext.Provider>
        {/* A loading or failed read is never shown as empty (nucleus-ui finding 1). */}
        {(boardRead !== "loaded" || (!grouped && total === 0)) && <Text style={{ ...muted(c), textAlign: "center", padding: space.xl }}>
          {boardRead === "failed"
            ? "The board could not be read; see the error above."
            : boardRead === "loading" || (view === "leads" && leadsLoading)
              ? "Loading…"
              : view === "leads" && triageTag && leadsCards(board, leadsTab).length === 0
                ? "No records carry this tag."
                : "Nothing here."}
        </Text>}
      </ScrollView>
    </View>
  );
}
