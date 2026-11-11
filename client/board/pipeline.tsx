import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as api from "../../shared/contracts";
import { taskNumberLabel, type DecisionView, type BoardLead, type BoardLeadLink, type LaneView, type TaskSummary, type UiQueueState } from "../../shared/contracts";
import { pipelineBoard, pipelineColumnHeight, pipelineColumnWidths, pipelineColumns, pipelineStubColumns, triageKind, triagePage, triagePageSize, triageState, type PipelineColumn } from "../../shared/pipeline-board";
import { isGeneralDecision } from "../../shared/decision-project";
import { useRpc, Icon } from "../shell";
import { Button, DropdownSelect, muted, row, type Colors } from "../controls";
import { projectName } from "./text";
import { RecordChips } from "./badges";
import { BoardCard, QaRunCard, TaskCard, DecisionCard, HoldPromptCard, LaneDrainCard } from "./cards";
import type { BoardAct } from "./use-board-data";

function newQaRequestId() { return `board-qa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
type Project = UiQueueState["projects"][number];

export type PipelineBoardProps = {
  c: Colors;
  state: UiQueueState | undefined;
  stateError: unknown;
  compact: boolean;
  inset: number;
  panelWidth: number;
  pipelineFilterSelection: string[];
  boardLeads: readonly BoardLead[];
  leadLinks: readonly BoardLeadLink[];
  leadsLoading: boolean;
  decisions: DecisionView[] | undefined;
  /** Per project, the queued tasks the board holds back for its "…and N more" card. */
  queuedHidden: Array<{ repoPath: string; hidden: number }>;
  parkedRepository: (repoPath: string, origin?: string | null) => boolean;
  projectForRepository: (repoPath: string, origin?: string | null) => Project | undefined;
  selected: string | null;
  selectedLeadId: string | null;
  openPapercutId: string | null;
  openDecisionId: string | null;
  onSelectTask: (id: string) => void;
  /** A queued-page row opens its task without closing the open record. */
  onOpenQueuedTask: (id: string) => void;
  onSelectDecision: (id: string) => void;
  onSelectLead: (id: string, lane: null) => void;
  onSelectPapercut: (id: string) => void;
  onOpenQaRun: (id: string) => void;
  busy: boolean;
  act: BoardAct;
  refetchQa: () => Promise<unknown>;
  /** The view state the shell keeps across tab switches (`usePipelineState`). */
  view: PipelineState;
};

/**
 * The Pipeline's view state: the Triage tag and page, the open queued-more page and its
 * read, and the measured heights. The shell holds it, so leaving Tasks for Planning or QA
 * and coming back keeps them, as when they lived in MainSurface.
 */
export function usePipelineState() {
  const fetchQueuedPage = useRpc(api.queuePage);
  const [queueRepo, setQueueRepo] = useState<string | null>(null);
  const [queueOffset, setQueueOffset] = useState(0);
  const [triageTag, setTriageTag] = useState<string | null>(null);
  // Cards shown in Triage (Tom, 2026-11-07); a tag change starts it back at one page.
  const [triageShown, setTriageShown] = useState(triagePageSize);
  const [pipelineAreaHeight, setPipelineAreaHeight] = useState(0);
  const [pipelineHeaderHeight, setPipelineHeaderHeight] = useState(0);
  const queuedPage = useQuery({ queryKey: ["nucleus", "queued-page", queueRepo, queueOffset], queryFn: () => fetchQueuedPage({ repoPath: queueRepo!, offset: queueOffset, limit: 25 }), enabled: Boolean(queueRepo), refetchInterval: 4000 });
  return { queueRepo, setQueueRepo, queueOffset, setQueueOffset, queuedPage, triageTag, setTriageTag, triageShown, setTriageShown, pipelineAreaHeight, setPipelineAreaHeight, pipelineHeaderHeight, setPipelineHeaderHeight };
}
export type PipelineState = ReturnType<typeof usePipelineState>;

/**
 * The Pipeline view: one set of columns, each card once (Tom, 2026-11-08: the
 * swim-lane view is retired). It owns the Triage tag filter and page, the
 * queued-more page and the column width math.
 */
export function PipelineBoard({ c, state, stateError, compact, inset, panelWidth, pipelineFilterSelection, boardLeads, leadLinks, leadsLoading, decisions, queuedHidden, parkedRepository, projectForRepository,
  selected, selectedLeadId, openPapercutId, openDecisionId, onSelectTask, onOpenQueuedTask, onSelectDecision, onSelectLead, onSelectPapercut, onOpenQaRun, busy, act, refetchQa, view }: PipelineBoardProps) {
  const runQa = useRpc(api.projectQaRun), cancelQa = useRpc(api.projectQaCancel), dismissQa = useRpc(api.projectQaDismiss);
  const setTask = useRpc(api.taskControl);
  const changeLaneStatus = useRpc(api.laneStatus);
  const keepLaneRpc = useRpc(api.laneKeep);
  const { queueRepo, setQueueRepo, queueOffset, setQueueOffset, queuedPage, triageTag, setTriageTag, triageShown, setTriageShown, pipelineAreaHeight, setPipelineAreaHeight, pipelineHeaderHeight, setPipelineHeaderHeight } = view;
  const pipelineHorizontal = React.useRef<ScrollView | null>(null);
  const hiddenQueued = queuedHidden.reduce((sum, item) => sum + item.hidden, 0);
const queuedMoreCards = queuedHidden.map(item => <View key={item.repoPath} style={{ gap: 6 }}>
  <BoardCard label={`${item.hidden} more queued in ${projectName(item)}`} selected={queueRepo === item.repoPath} c={c}
    onPress={() => { setQueueRepo(queueRepo === item.repoPath ? null : item.repoPath); setQueueOffset(0); }}
    eyebrow={<><Icon name="Folder" size={12} color={c.foregroundMuted}/><Text numberOfLines={1} ellipsizeMode="tail" style={{ color: c.foregroundMuted, fontSize: 12, flexShrink: 1 }}>{projectName(item)}</Text></>}
    title={`…and ${item.hidden} more`} />
  {queueRepo === item.repoPath && <View style={{ gap: 5 }}>
    {queuedPage.isLoading && <Text style={{ color: c.foregroundMuted }}>Loading queued tasks…</Text>}
    {queuedPage.error && <Text style={{ color: c.foreground }}>Could not load queued tasks. Try again.</Text>}
    {(queuedPage.data?.tasks ?? []).filter(page => !state?.tasks.some(task => task.id === page.id)).map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Open ${item.title}`} onPress={() => onOpenQueuedTask(item.id)}>
                <Text numberOfLines={1} style={{ color: c.foreground }}>{item.reference ?? ''} {item.title} · {item.reason}</Text>
              </Pressable>)}
    <View style={{ ...row, gap: 6 }}>
      <Button small c={c} text="Previous" disabled={queueOffset === 0} onPress={() => setQueueOffset(Math.max(0, queueOffset - 25))} />
      <Button small c={c} text="Next" disabled={queuedPage.data?.nextOffset == null} onPress={() => setQueueOffset(queuedPage.data!.nextOffset!)} />
    </View>
  </View>}
</View>);
  // One lookup for the decision chip on task, lead and papercut cards: how many
  // open decisions link each record (Spec 032).
  // The Pipeline Decisions column follows the project filter, with General decisions visible everywhere.
  const releaseHold = (task: TaskSummary) => void act(() => setTask({ taskId: task.id, version: task.version, action: "release" }));
  const keepHold = (task: TaskSummary, reason: string) => void act(() => setTask({ taskId: task.id, version: task.version, action: "keep_hold", reason }));
  // Close finishes the drained step; Keep records the operator's reason and ends the episode.
  const closeDrainedLane = (lane: LaneView) => void act(() => changeLaneStatus({ key: lane.key, status: "done" }));
  const keepDrainedLane = (lane: LaneView, reason: string) => void act(() => keepLaneRpc({ key: lane.key, reason, author: "operator (board)" }));
  const decisionLinkedTaskProjects = (decision: DecisionView) => isGeneralDecision(decision)
    ? [...new Set(decision.links.tasks.flatMap(id => {
      const task = state?.tasks.find(item => item.id === id);
      return task ? [projectName(task)] : [];
    }))]
    : [];
  const decisionLinkedTaskLabels = (decision: DecisionView) => decision.links.tasks.map(id => {
    const task = state?.tasks.find(item => item.id === id);
    if (!task) return id;
    const reference = task.reference ?? (task.number ? taskNumberLabel(task, true) : null);
    return reference ? `${reference} · ${task.title}` : task.title;
  });
  const decisionLinkCounts = new Map<string, number>();
  for (const decision of decisions ?? []) for (const id of [...decision.links.tasks, ...decision.links.leads, ...decision.links.papercuts]) decisionLinkCounts.set(id, (decisionLinkCounts.get(id) ?? 0) + 1);
  const pipelineInput = {qaRuns:state?.qaRuns??[],projects:state?.projects??[],lanes:state?.lanes??[],selection:pipelineFilterSelection,leads:boardLeads,linkedLeads:leadLinks,tasks:state?.tasks??[],decisions:decisions??[],pendingSubmissions:state?.pendingSubmissions??[]} as const;
  const selectionKey = pipelineFilterSelection.join("\n");
  // One set of columns, each card once, derived only when an input changes (a counter-only poll keeps
  // these references); Triage's tag filter applies to a copy, never to the memoised board.
  const columns = useMemo(() => pipelineBoard(pipelineInput), [state?.qaRuns, state?.projects, state?.lanes, state?.tasks, state?.pendingSubmissions, selectionKey, boardLeads, leadLinks, decisions]);
  const triageScopeLeads = columns.cards.Triage.flatMap(card=>card.kind==='lead'?[card.value]:[]);
  const triageCards = columns.cards.Triage.filter(card=>card.kind!=="lead"||!triageTag||card.value.tags.includes(triageTag));
  const board = { cards: { ...columns.cards, Triage: triageCards }, counts: { ...columns.counts, Triage: triageCards.length } };
  const pipelineCounts = board.counts;
  // The header total: Queued includes the cards the board holds back for its "…and N more" card.
  const pipelineTotals = { ...pipelineCounts, Queued: pipelineCounts.Queued + hiddenQueued };
  const boardTotal = pipelineColumns.reduce((sum, name) => sum + pipelineTotals[name], 0);
  // Totals are zero until a full board read lands, so only a loaded board may collapse a column or
  // read "empty". A loading or failed read keeps every column open and says so (nucleus-ui finding 1).
  const boardRead = state ? "loaded" : stateError ? "failed" : "loading";
  // The tag filter lists only tags on leads Triage shows in the current scope, with counts;
  // tags from other projects or briefed leads matched nothing (Tom, 2026-10-15).
  const triageTagCounts = new Map<string, number>();
  for (const lead of triageScopeLeads) for (const tag of lead.tags) triageTagCounts.set(tag, (triageTagCounts.get(tag) ?? 0) + 1);
  if (triageTag && !triageTagCounts.has(triageTag)) triageTagCounts.set(triageTag, 0);
  // Reserved tags lead under their display names; free-form tags follow alphabetically.
  const triageTagOption = ([tag,count]:[string,number]) => ({value:tag,label:`${api.RESERVED_LEAD_TAGS[tag]??tag} (${count})`,group:api.RESERVED_LEAD_TAGS[tag]?"Reserved":"Tags"});
  const triageTagOptions = [{value:"",label:`All tags (${triageScopeLeads.length})`},...[...triageTagCounts].sort(([a],[b])=>Number(!api.RESERVED_LEAD_TAGS[a])-Number(!api.RESERVED_LEAD_TAGS[b])||a.localeCompare(b)).map(triageTagOption)];
  // Pipeline columns fill the panel, never narrower than a card. An empty column collapses to a
  // labelled stub (nucleus-ui finding 1); Triage stays open under a tag filter so the filter can be cleared.
  const pipelineGap=10;
  const pipelineStubs = boardRead === "loaded" ? pipelineStubColumns(pipelineTotals, triageTag ? ["Triage"] : []) : new Set<PipelineColumn>();
  const pipelineWidths = pipelineColumnWidths(pipelineStubs, { available: panelWidth-2*inset, gap: pipelineGap, minWidth: compact?260:300 });
  return (
      <View
        onLayout={(event) =>
          setPipelineAreaHeight(event.nativeEvent.layout.height)
        }
        style={{ flex: 1, minHeight: 0, paddingBottom: inset }}
      >
        <ScrollView
          ref={pipelineHorizontal}
          horizontal
          style={{ flex: 1, minHeight: compact ? 300 : 0 }}
          contentContainerStyle={{ paddingHorizontal: inset }}
        >
          <View style={{ gap: 10, paddingBottom: 12 }}>
            <View style={{ backgroundColor: c.surface0, zIndex: 3 }}>
              <View
                onLayout={(event) =>
                  setPipelineHeaderHeight(event.nativeEvent.layout.height)
                }
                style={{
                  flexDirection: "row",
                  gap: pipelineGap,
                  paddingVertical: 6,
                }}
              >
                {pipelineColumns.map((name) => {
                  // A stub shows only its name; it has no cards or filter, and expands once it holds one.
                  const stub = pipelineStubs.has(name);
                  return (
                  <View
                    key={name}
                    accessibilityLabel={boardRead !== "loaded" ? `${name}, ${boardRead === "failed" ? "not loaded" : "loading"}` : stub ? `${name}, ${pipelineTotals[name]}, empty` : `${name}, ${pipelineTotals[name]}`}
                    style={{
                      width: pipelineWidths[name],
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <Text
                      style={{
                        color: c.foreground,
                        fontWeight: "600",
                        fontSize: 12,
                      }}
                    >
                      {name}
                    </Text>
                    {!stub && <View
                      style={{
                        minWidth: 20,
                        height: 18,
                        paddingHorizontal: 6,
                        borderRadius: 9,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: c.surface2,
                      }}
                    >
                      <Text
                        style={{ color: c.foregroundMuted, fontSize: 11 }}
                      >
                        {boardRead === "loaded" ? pipelineTotals[name] : boardRead === "failed" ? "—" : "…"}
                      </Text>
                    </View>}
                    {name === "Triage" && !stub && (
                      <DropdownSelect
                        compact
                        c={c}
                        label="Filter Triage by tag"
                        value={triageTag ?? ""}
                        options={triageTagOptions}
                        onChange={(value) => {
                          setTriageTag(value || null);
                          setTriageShown(triagePageSize);
                        }}
                        minWidth={110}
                      />
                    )}
                  </View>
                  );
                })}
              </View>
            </View>
            {boardTotal > 0 && (
              <View style={{ flexDirection: "row", gap: pipelineGap }}>
                {pipelineColumns.map((name) => {
                          // Triage shows one page; its "…and N more" card loads the next.
                          const triage = name === 'Triage' ? triagePage(board.cards[name], triageShown) : null;
                          const visible = triage ? triage.visible : board.cards[name];
                          const triageMore = triage && triage.hidden > 0 ? <BoardCard label={`Show ${triage.hidden} more in Triage`} selected={false} c={c}
                            onPress={() => setTriageShown(triageShown + triagePageSize)}
                            eyebrow={null}
                            title={<Text numberOfLines={1} style={{ color: c.foreground, fontWeight: "600", fontSize: 13 }}>{`…and ${triage.hidden} more`}</Text>} /> : null;
                          const more = name === 'Queued' ? queuedMoreCards : triageMore;
                          const cards = visible.map((card) => {
                            if (card.kind === "decision")
                              return (
                                <DecisionCard
                                  key={`${card.kind}:${card.id}`}
                                  decision={card.value}
                                  linkedTaskLabels={decisionLinkedTaskLabels(card.value)}
                                  linkedTaskProjects={decisionLinkedTaskProjects(
                                    card.value,
                                  )}
                                  c={c}
                                  selected={openDecisionId === card.id}
                                  onPress={() => onSelectDecision(card.id)}
                                />
                              );
                            if (card.kind === "raised")
                              return (
                                <HoldPromptCard
                                  busy={busy}
                                  onRelease={() =>
                                    releaseHold(card.value)
                                  }
                                  onKeep={(reason) =>
                                    keepHold(card.value, reason)
                                  }
                                  key={`${card.kind}:${card.id}`}
                                  task={card.value}
                                  c={c}
                                  selected={selected === card.id}
                                  onPress={() => onSelectTask(card.id)}
                                />
                              );
                            if (card.kind === "lane_drain")
                              return (
                                <LaneDrainCard
                                  key={`${card.kind}:${card.id}`}
                                  lane={card.value}
                                  c={c}
                                  busy={busy}
                                  selected={false}
                                  onPress={() => {}}
                                  onClose={() =>
                                    closeDrainedLane(card.value)
                                  }
                                  onKeep={(reason) =>
                                    keepDrainedLane(card.value, reason)
                                  }
                                />
                              );
                            if (card.kind === "qa")
                              return (
                                <QaRunCard
                                  key={`${card.kind}:${card.id}`}
                                  run={card.value}
                                  busy={busy}
                                  c={c}
                                  onOpen={() => onOpenQaRun(card.value.id)}
                                  onRerun={() =>
                                    void act(async () => {
                                      await runQa({
                                        repository: card.value.repository.origin ?? card.value.repository.path,
                                        baseBranch: card.value.baseBranch,
                                        requestId: newQaRequestId(),
                                      });
                                      await refetchQa();
                                    })
                                  }
                                  onCancel={() =>
                                    void act(async () => {
                                      await cancelQa({ id: card.value.id, reason: "Cancelled from the board card" });
                                      await refetchQa();
                                    })
                                  }
                                  onDismiss={() =>
                                    void act(async () => {
                                      await dismissQa({ id: card.value.id, reason: "Dismissed from the board card", caller: "operator (board)" });
                                      await refetchQa();
                                    })
                                  }
                                />
                              );
                            if (card.kind === "task")
                              return (
                                <TaskCard
                                  key={`${card.kind}:${card.id}`}
                                  task={card.value}
                                  defaultHostId={state?.hostId}
                                  board
                                  selected={selected === card.id}
                                  onPress={() => onSelectTask(card.id)}
                                  prState={state?.prStates[card.id]}
                                  c={c}
                                  parked={parkedRepository(
                                    card.value.repoPath,
                                    card.value.repository,
                                  )}
                                  decisions={decisionLinkCounts.has(
                                    card.id,
                                  )}
                                  decisionTitle={card.value.waitState?.decisionId
                                    ? (decisions ?? []).find(decision => decision.id === card.value.waitState?.decisionId)?.headline
                                      ?? (decisions ?? []).find(decision => decision.id === card.value.waitState?.decisionId)?.question
                                    : null}
                                />
                              );
                            const eyebrow = (text: string) => (
                              <>
                                <Icon
                                  name="Folder"
                                  size={12}
                                  color={c.foregroundMuted}
                                />
                                <Text
                                  numberOfLines={1}
                                  ellipsizeMode="tail"
                                  style={{
                                    ...muted(c),
                                    fontSize: 11,
                                    flexShrink: 1,
                                  }}
                                >
                                  {text}
                                </Text>
                              </>
                            );
                            const title = (text: string) => (
                              <Text
                                numberOfLines={2}
                                style={{
                                  color: c.foreground,
                                  fontWeight: "600",
                                  fontSize: 13,
                                  lineHeight: 17,
                                }}
                              >
                                {text}
                              </Text>
                            );
                            const snippet = (text: string) => (
                              <Text
                                numberOfLines={2}
                                ellipsizeMode="tail"
                                style={{
                                  color: c.foregroundMuted,
                                  fontSize: 12,
                                  lineHeight: 16,
                                }}
                              >
                                {text}
                              </Text>
                            );
                            // Spec 026: an accepted submission with no task yet shows queued as
                            // "submitting" until its task appears.
                            if (card.kind === "submission")
                              return (
                                <BoardCard
                                  key={`${card.kind}:${card.id}`}
                                  c={c}
                                  label={`${name}: ${card.value.title}`}
                                  eyebrow={eyebrow(
                                    projectName(card.value),
                                  )}
                                  title={title(card.value.title)}
                                  chips={
                                    <RecordChips
                                      c={c}
                                      chips={["Submitting"]}
                                    />
                                  }
                                  snippet={snippet(
                                    "Accepted; creating its task",
                                  )}
                                  selected={false}
                                  onPress={() => {}}
                                />
                              );
                            return (
                              <BoardCard
                                key={`${card.kind}:${card.id}`}
                                c={c}
                                label={`${name}: ${card.value.title}`}
                                eyebrow={eyebrow(
                                  // The project's name, not its repository's: a project can be named differently from its repository (Tom, 2026-11-07).
                                  [...new Set(card.value.repositories
                                    .map(
                                      (repo) =>
                                        projectForRepository(repo.path, repo.origin)?.name ??
                                        repo.origin.split("/").at(-1) ??
                                        repo.origin,
                                    ))].join(", "),
                                )}
                                title={<Text numberOfLines={1} style={{ color: c.foreground, fontWeight: "600", fontSize: 13, lineHeight: 17 }}>{card.value.title}</Text>}
                                chips={
                                  <RecordChips
                                    c={c}
                                    chips={[triageKind(card.value) === "papercut" ? api.RESERVED_LEAD_TAGS.papercut : "Lead"]}
                                  />
                                }
                                snippet={<Text numberOfLines={1} ellipsizeMode="tail" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{triageState(card.value)}</Text>}
                                selected={
                                  selectedLeadId === card.id ||
                                  openPapercutId === card.id
                                }
                                onPress={() => {
                                  if (
                                    card.value.tags.includes("papercut")
                                  ) onSelectPapercut(card.id);
                                  else onSelectLead(card.id, null);
                                }}
                              />
                            );
                          });
                          return (
                            <View
                              key={name}
                              style={{
                                width: pipelineWidths[name],
                                gap: 6,
                              }}
                            >
                              <ScrollView
                                nestedScrollEnabled
                                showsVerticalScrollIndicator
                                style={{
                                  height: pipelineColumnHeight(
                                    pipelineAreaHeight,
                                    {
                                      bottomPadding: inset,
                                      headerHeight: pipelineHeaderHeight,
                                    },
                                  ),
                                }}
                                contentContainerStyle={{ gap: 6 }}
                              >
                                {cards}
                                {more}
                              </ScrollView>
                            </View>
                          );
                })}
              </View>
            )}
            {/* A failed board read is named even when lead cards rendered from their own read. */}
            {(!boardTotal || boardRead === "failed") && (
              <Text style={muted(c)}>
                {boardRead === "failed"
                  ? "The board could not be read; see the error above."
                  : boardRead === "loading" || leadsLoading
                    ? "Loading pipeline…"
                    : "No planning records match the selected projects."}
              </Text>
            )}
          </View>
        </ScrollView>
      </View>
  );
}
