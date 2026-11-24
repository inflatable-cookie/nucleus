import { useEngineFeatures } from "./engine-features";
import React, { useState, useEffect, useMemo } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import {
  useRpc,
  useWorkspace,
  type BoardSurfaceProps,
  type BoardWorkspacePanelProps,
} from "./shell";
import { muted, type Colors } from "./controls";
import { useBoardState } from "./board-state";
import { PopoverHost } from "./popover";
import { PlanningTab, type PlanEdit } from "./planning-panel";
import {
  ProjectSelector,
  usePanelScope,
  useProjectScope,
} from "./project-scope-controls";
import { useProjectSelectorActions } from "./project-selector-actions";
import { ProjectManagementView } from "./project-management-view";
import { useQueryClient } from "@tanstack/react-query";
import * as api from "../shared/contracts";
import type { TaskSummary } from "../shared/contracts";
import { hiddenQueuedByProject } from "../shared/queued-more";
import { planSaveInput } from "../shared/planning-tab";
import {
  effectiveSelection,
  projectHasRepository,
  scopeContains,
} from "../shared/project-scope";
import { isOpenTask, type SettingsTarget } from "../shared/queue-navigation";
import {
  inboxLayout,
  inboxListWidth,
  inboxMenuWidth,
} from "../shared/inbox-board";
import { normalizeRepositoryOrigin } from "../shared/lanes";
import { errorText, readErrorText, storedBoardErrorText } from "./error-text";
import { LaneScreen, isPapercut, type LaneDraft } from "./lane-screen";
import { projectName } from "./board/text";
import { BoardHeader } from "./board/header";
import { InboxList, useInboxBoard, usePipelineState } from "./board/inbox-list";
import { InboxMenu, type BoardView } from "./board/inbox-menu";
import { useBoardSelection } from "./board/use-board-selection";
import {
  useBoardAct,
  usePlanningData,
  useRecordQueries,
  useTaskDetail,
  type BoardTab,
} from "./board/use-board-data";
import { TaskDialog } from "./task/task-dialog";
import { RustTaskDialog } from "./task/rust-task";
import { groupRustTasks, rustProjectActivity, useRustTasks, type RustInvalidation } from "./web/rust-board";
import { useTaskDraftStore } from "./task/drafts";
import { LeadDialog } from "./records/lead-dialog";
import { PapercutDialog } from "./records/papercut-dialog";
import { DecisionDialog } from "./records/decision-dialog";
import type { RecordNoticeValue } from "./task/parts";
import { overlay, roles, space, type as typeScale } from "./design";
export { TaskCard, DecisionCard } from "./board/cards";
export { TriageLeadCard } from "./board/triage-lead-card";
export {
  taskIdentityFields,
  EventRow,
  type TaskDetailTab,
  TaskDetailTabs,
  TechnicalActivityEvents,
  RunRow,
  MessageRow,
  RawRecords,
  DetailField,
} from "./task/parts";
export { TaskSummaryBlock } from "./task/summary";
export { NextSection } from "./task/next-section";
export {
  ProjectValidationSection,
  CompactTelemetrySummary,
} from "./telemetry-parts";

export type WorkspaceBoardScope = { key: string; name: string };

/** The header's Settings icon opens Queue's native Paseo settings screen; the
 * client entry registers the host's `openSettings` here before any surface renders.
 * A section (the project chooser's settings icon passes Projects) rides as a hint. */
let settingsOpener: ((section?: SettingsTarget) => void) | null = null;
export function registerSettingsOpener(
  open: (section?: SettingsTarget) => void,
): void {
  settingsOpener = open;
}

/**
 * The board shell (Tom, 2026-11-21: an inbox, not kanban columns): the menu on the
 * left, the open view's list in the middle and the open record on the right. A
 * medium panel drops the detail pane and opens records in a modal; a narrow one
 * also folds the menu into a drawer. The header (`board/header.tsx`), the list
 * (`board/inbox-list.tsx`) and the reads (`board/use-board-data.ts`) live in their
 * own modules.
 */
export function MainSurface({
  theme,
  layout,
  navigation,
  workspaceBoard,
  rustBoard,
}: BoardSurfaceProps & { workspaceBoard?: WorkspaceBoardScope; now?: number; rustBoard?: RustInvalidation }) {
  const c = theme.colors;
  const [panelWidth, setPanelWidth] = useState(0);
  const mode = inboxLayout(panelWidth, layout.compact);
  const wide = mode === "wide",
    narrow = mode === "narrow";
  const { canvas, section, navigation: navigationFill, list } = roles(c);
  const listFill = narrow ? canvas : list;
  const menuWidth = inboxMenuWidth[wide ? "wide" : "medium"];
  // The detail pane's room decides whether a record lays out compactly.
  const detailWidth = panelWidth - menuWidth - inboxListWidth;
  const compact = !wide || (detailWidth > 0 && detailWidth < 700);
  const savePlan = useRpc(api.planSet);
  const saveLaneDocument = useRpc(api.laneDocumentEdit);
  const changeLaneStatus = useRpc(api.laneStatus);
  const readPlan = useRpc(api.planGet);
  const searchOutcomes = useRpc(api.outcomeSearch);
  const queryClient = useQueryClient();
  const [view, setView] = useState<BoardView>("needs");
  const [menuOpen, setMenuOpen] = useState(false);
  // The reads still key on the two data shapes: Planning's, and the card lists'.
  const tab: BoardTab = view === "planning" ? "planning" : "queue";
  const [surfaceScope, setSurfaceScope] = useProjectScope();
  // Spec 026 row 14c: the workspace panel's selection is preset to the workspace's
  // project and lives in the panel, never in the main surface's persisted scope.
  const [panelScope, setPanelScope] = usePanelScope(
    workspaceBoard?.key ?? null,
  );
  const scope = workspaceBoard
    ? (panelScope ?? { projects: [workspaceBoard.key] })
    : surfaceScope;
  const setScope = workspaceBoard ? setPanelScope : setSurfaceScope;
  const [scopeOpen, setScopeOpen] = useState(false);
  const {
    selected,
    setSelected,
    rustTaskId,
    setRustTaskId,
    selectedLeadId,
    setSelectedLeadId,
    leadLane,
    setLeadLane,
    openPapercutId,
    setOpenPapercutId,
    openDecisionId,
    setOpenDecisionId,
    selectTask,
    selectRustTask,
    selectDecision,
    selectLead,
    selectPapercut,
    clearSelection,
  } = useBoardSelection();
  // Unsaved plan drafts, one per project section: entries, idle mark and the version they were based on.
  const [planEdits, setPlanEdits] = useState<Record<string, PlanEdit>>({});
  // The last failed save per project. The draft stays; the section says why it was not saved.
  const [planSaveErrors, setPlanSaveErrors] = useState<Record<string, string>>(
    {},
  );
  // The open lane's unsaved document text. Leaving the lane or Planning keeps it until it is saved or discarded.
  const [laneDraft, setLaneDraft] = useState<LaneDraft | null>(null);
  const [recordNotice, setRecordNotice] = useState<RecordNoticeValue | null>(
    null,
  );
  // The revisioned board read (Contract 007) lives in the shared board-state
  // hook, so every surface hydrates from one projection and panel mounts never
  // wait for their own poll.
  const { stateQuery, state } = useBoardState();
  const rustTasks = useRustTasks(Boolean(rustBoard));
  const rustColumns = useMemo(() => {
    if (!rustTasks.data) return undefined;
    const contains = scopeContains(state?.projects ?? [], scope.projects);
    return groupRustTasks(rustTasks.data.filter(({ identity }) =>
      contains(identity.repository, normalizeRepositoryOrigin(identity.repository)),
    ));
  }, [rustTasks.data, state?.projects, scope.projects]);
  const rustView = Boolean(rustBoard) && view !== "planning" && view !== "leads" && view !== "papercuts" ? view : null;
  const features = useEngineFeatures();
  const projectActivity = useMemo(
    () => features.engine === "rust" && state && rustTasks.data
      ? rustProjectActivity(state.projects, rustTasks.data)
      : state?.projectActivity ?? [],
    [features.engine, state?.projects, state?.projectActivity, rustTasks.data],
  );
  // On the Rust engine every task is a Rust task. The project selector counts
  // each project's open tasks through its hidden-count input, keyed by checkout.
  const selectorCounts = useMemo(() => {
    if (features.engine !== "rust" || !rustTasks.data) return state?.queuedCounts ?? [];
    const counts = new Map<string, number>();
    for (const task of rustTasks.data) {
      if (task.phase === "done" || task.phase === "cancelled") continue;
      const origin = normalizeRepositoryOrigin(task.identity.repository);
      const repo = (state?.projects ?? [])
        .flatMap((project) => project.repositories)
        .find((candidate) => candidate.origin && normalizeRepositoryOrigin(candidate.origin) === origin);
      if (repo?.path) counts.set(repo.path, (counts.get(repo.path) ?? 0) + 1);
    }
    return [...counts].map(([repoPath, count]) => ({ repoPath, count }));
  }, [features.engine, rustTasks.data, state?.projects, state?.queuedCounts]);
  // The selector's row actions (nucleus#1430) refresh the board after each save; Remove opens the shared removal dialog below.
  const projectSelector = useProjectSelectorActions(() => stateQuery.refetch());
  const [removingProject, setRemovingProject] = useState<api.Project | null>(
    null,
  );
  const { detailQuery, nextQuery } = useTaskDetail(selected);
  const records = useRecordQueries({ stateQuery, state, tab, scopeOpen });
  const {
    leadsQuery,
    decisionsQuery,
    planQuery,
    staleRead,
    boardLeads,
    leadLinks,
  } = records;
  const {
    lanes,
    planningProjects,
    planningLane,
    setPlanningLane,
    planningStep,
    setPlanningStep,
    setPlanningPin,
    documentQuery,
    laneTasksQuery,
    laneTaskOffset,
    setLaneTaskOffset,
    planningLaneRecord,
    planningLeads,
    fetchLaneDocument,
  } = usePlanningData({
    scope,
    state,
    tab,
    records,
    onLeaveLane: () => setLaneDraft(null),
  });
  // The list's tag filter, pages and held-back queue reads outlive a visit to another view.
  const pipeline = usePipelineState();
  const { act, leadAct, busy, error, setError } = useBoardAct({
    selected,
    selectedLeadId,
    openPapercutId,
    openDecisionId,
    setRecordNotice,
  });
  // Record dialogs own their drafts and remount per record, so they clear when it closes or
  // moves on. Task-detail drafts live in the draft store: the dispose, escalation, replacement,
  // work-disposition and note drafts clear when the task or view changes; the rest persist.
  useEffect(() => {
    setError("");
  }, [selected, view]);
  const taskDrafts = useTaskDraftStore(`${selected ?? ""}|${view}`);
  useEffect(() => {
    setRecordNotice(null);
  }, [selectedLeadId, openPapercutId, openDecisionId]);
  const recordKey = `${selectedLeadId ?? ""}|${openPapercutId ?? ""}|${openDecisionId ?? ""}`;
  const liveTasks = state?.tasks.filter(isOpenTask) ?? [];
  // Stale saved keys (a removed project) drop out, so every view treats them alike.
  // The selection is the only filter state (nucleus#1476): an empty selection shows
  // all projects in every scoped view, and clearing the last project restores them.
  const selection = effectiveSelection(state?.projects ?? [], scope.projects);
  const belongs = scopeContains(state?.projects ?? [], selection);
  const projectForRepository = (repoPath: string, origin?: string | null) =>
    state?.projects.find((project) =>
      projectHasRepository(project, repoPath, origin),
    );
  const queuedCounts = (state?.queuedCounts ?? []).filter((item) =>
    belongs(item.repoPath),
  );
  const queuedHidden = hiddenQueuedByProject(queuedCounts, state?.tasks ?? []);
  const hiddenQueued = queuedHidden.reduce((sum, item) => sum + item.hidden, 0);
  const inbox = useInboxBoard({
    state,
    selection,
    lanes,
    boardLeads,
    leadLinks,
    decisions: decisionsQuery.data,
    hiddenQueued,
    triageTag: pipeline.triageTag,
  });
  const projectForTask = (task: {
    repoPath: string;
    repository?: string | null;
  }) => projectForRepository(task.repoPath, task.repository);
  const multiRepository = (task: {
    repoPath: string;
    repository?: string | null;
  }) => (projectForTask(task)?.repositories.length ?? 1) > 1;
  /** A read or save failure's message; undefined when there was no failure. */
  const planMessage = (error: unknown) =>
    error == null ? undefined : errorText(error);
  const dropPlanEdit = (key: string) => {
    setPlanEdits((edits) =>
      Object.fromEntries(
        Object.entries(edits).filter(([project]) => project !== key),
      ),
    );
    setPlanSaveErrors((errors) =>
      Object.fromEntries(
        Object.entries(errors).filter(([project]) => project !== key),
      ),
    );
  };
  const selectPlanningLane = (key: string) => {
    setPlanningPin(key);
    setPlanningLane(key);
    setLaneDraft(null);
    setPlanningStep("lane");
  };
  /** "Plans it's in" for a project outside Planning's scope: the filter moves to it and the lane stays open. */
  const showLanePlan = (project: string) => {
    setScope({ projects: [project] });
    setPlanningStep("plan");
  };
  /** A menu pick opens that view with nothing selected, so the detail pane never shows a record the list hides. */
  const openView = (next: BoardView) => {
    if (next !== view) clearSelection();
    setView(next);
    setMenuOpen(false);
  };
  /** The drained-lane card's press opens its lane in Planning (nucleus#1511). */
  const openLaneInPlanning = (key: string) => {
    openView("planning");
    selectPlanningLane(key);
  };

  const laneName = (key: string) =>
    lanes.find((lane) => lane.key === key)?.title ?? key;
  const task = detailQuery.data?.task;
  const inset = space.md;
  // The first failed board read, in plain words: which read failed and why.
  // A raw schema dump never reaches the header (nucleus#1141).
  const failedRead = (
    [
      ["Board state", stateQuery.error],
      ["Task detail", detailQuery.error],
      ["Leads", leadsQuery.error],
      ["Decisions", decisionsQuery.error],
      ["Plans", planQuery.error],
      ["Lane document", documentQuery.error],
    ] as Array<[string, unknown]>
  ).find(([, failure]) => failure != null);
  const readError = failedRead
    ? readErrorText(failedRead[0], failedRead[1])
    : state?.error
      ? storedBoardErrorText(state.error)
      : null;
  // Records open in the detail pane on a wide board's lists. Planning's detail pane
  // holds the lane, so a record opened from it is a modal, as on a narrower board.
  const inlineDetail = wide && view !== "planning";
  const anyRecord = Boolean(
    selected || rustTaskId || selectedLeadId || openPapercutId || openDecisionId,
  );
  const detail = rustTaskId && rustBoard ? (
    <RustTaskDialog key={`rust:${rustTaskId}`} id={rustTaskId}
      summary={rustTasks.data?.find(({ identity }) => identity.id === rustTaskId)}
      inline={inlineDetail} compact={compact} c={c}
      onClose={() => setRustTaskId(null)} invalidate={rustBoard} />
  ) : task ? (
    <TaskDialog
      key={`task:${task.id}`}
      task={task}
      detailQuery={detailQuery}
      nextQuery={nextQuery}
      state={state}
      decisions={decisionsQuery.data}
      spansRepositories={multiRepository(task)}
      compact={compact}
      busy={busy}
      act={act}
      drafts={taskDrafts}
      navigation={navigation}
      inline={inlineDetail}
      onClose={() => setSelected(null)}
      onSelectTask={setSelected}
      c={c}
    />
  ) : selectedLeadId ? (
    <LeadDialog
      key={`lead:${selectedLeadId}`}
      id={selectedLeadId}
      lane={leadLane}
      compact={compact}
      busy={busy}
      leadAct={leadAct}
      inline={inlineDetail}
      onClose={() => {
        setLeadLane(null);
        setSelectedLeadId(null);
      }}
      c={c}
    />
  ) : openPapercutId ? (
    // A record dialog remounts when any open record changes, which clears its drafts.
    <PapercutDialog
      key={recordKey}
      id={openPapercutId}
      compact={compact}
      busy={busy}
      act={act}
      recordNotice={recordNotice}
      setRecordNotice={setRecordNotice}
      laneName={laneName}
      inline={inlineDetail}
      onClose={() => setOpenPapercutId(null)}
      c={c}
    />
  ) : openDecisionId ? (
    <DecisionDialog
      key={recordKey}
      id={openDecisionId}
      compact={compact}
      busy={busy}
      act={act}
      recordNotice={recordNotice}
      setRecordNotice={setRecordNotice}
      onOpenDecision={setOpenDecisionId}
      taskLinkLabel={(id) => {
        const task = state?.tasks.find((item) => item.id === id);
        if (!task) return null;
        const reference =
          task.reference ??
          (task.number ? api.taskNumberLabel(task, true) : null);
        const project =
          projectForRepository(task.repoPath, task.repository)?.name ??
          projectName(task);
        return [reference, task.title, project].filter(Boolean).join(" · ");
      }}
      onOpenTask={(id) => {
        setOpenDecisionId(null);
        setSelected(id);
      }}
      inline={inlineDetail}
      onClose={() => setOpenDecisionId(null)}
      c={c}
    />
  ) : null;
  const detailPane = (
    <View
      accessibilityLabel="Detail"
      style={{ flex: 1, minWidth: 0, minHeight: 0, backgroundColor: roles(c).canvas }}
    >
      {detail ?? (
        <View
          accessibilityLabel={anyRecord ? "Loading detail" : "No item selected"}
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: space.lg,
          }}
        >
          <Text style={muted(c)}>
            {anyRecord ? "Loading…" : "Select an item to see its detail."}
          </Text>
        </View>
      )}
    </View>
  );
  const menu = (
    <InboxMenu
      c={c}
      view={view}
      counts={inbox.counts}
      loaded={Boolean(state)}
      pendingCounts={features.engine === "rust" ? [
        ...(!decisionsQuery.data ? ["needs" as const] : []),
        ...(!planQuery.data ? ["planning" as const] : []),
        ...(!leadsQuery.data ? ["leads" as const, "papercuts" as const] : []),
      ] : undefined}
      rust={rustBoard ? { totals: Object.fromEntries(
        Object.entries(rustColumns ?? {}).map(([column, tasks]) => [column, tasks.length]),
      ) } : undefined}
      onSelect={openView}
    />
  );
  const filter = (
    <ProjectSelector
      projects={state?.projects ?? []}
      tasks={state?.tasks ?? []}
      leads={boardLeads}
      queuedCounts={selectorCounts}
      projectActivity={projectActivity}
      value={scope.projects}
      // The picker commits the selection it reports, and an empty pick
      // (Clear, or Shift-clearing the last project) restores all projects.
      onChange={(projects) => setScope({ projects })}
      onSettings={
        settingsOpener ? () => settingsOpener?.("projects") : undefined
      }
      projectActions={{
        ...projectSelector.actions,
        // Rust engine (ruling 8): an archived toggle in Settings replaces removal.
        ...(features.projectAgents ? { remove: setRemovingProject } : {}),
      }}
      onOpenChange={setScopeOpen}
      compact={narrow}
      c={c}
    />
  );
  // Every popover on the board renders in this host's layer, above the panes (Tom, 2026-11-08).
  return (
    <PopoverHost>
      <View
        onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
        style={{ flex: 1, minHeight: 0, backgroundColor: roles(c).canvas }}
      >
        <BoardHeader
          c={c}
          workspaceName={workspaceBoard?.name}
          state={state}
          activeWorkers={
            features.engine === "rust"
              ? rustTasks.data?.filter((task) => task.wait === "running").length ?? null
              : undefined
          }
          refetchState={stateQuery.refetch}
          busy={busy}
          act={act}
          error={error}
          onDismissError={() => setError("")}
          readError={readError}
          staleRead={staleRead}
          inset={inset}
          settingsOpener={settingsOpener}
          filter={filter}
          onMenu={narrow ? () => setMenuOpen(true) : undefined}
        >
          <View
            style={{ flex: 1, minHeight: 0, flexDirection: "row", zIndex: 0 }}
          >
            {!narrow && (
              <View
                style={{
                  width: menuWidth,
                  minHeight: 0,
                  backgroundColor: navigationFill,
                }}
              >
                {menu}
              </View>
            )}
            {view === "planning" ? (
              <PlanningTab
                c={c}
                compact={compact}
                inbox={{
                  listWidth: wide ? inboxListWidth : null,
                  laneModal: !wide,
                  listFill,
                  listSurface: narrow && canvas !== section ? "canvas" : "section",
                }}
                leads={boardLeads}
                onCloseLane={(lane) =>
                  void act(() =>
                    changeLaneStatus({ key: lane, status: "done" }),
                  )
                }
                onReopenLane={(lane) =>
                  void act(() =>
                    changeLaneStatus({ key: lane, status: "active" }),
                  )
                }
                busy={busy}
                step={planningStep}
                onStep={setPlanningStep}
                selectedLane={planningLane}
                onOpenLane={selectPlanningLane}
                lanes={lanes}
                projects={state?.projects ?? []}
                projectActivity={projectActivity}
                selection={scope.projects}
                plans={planQuery.data ?? []}
                plansError={planMessage(planQuery.error)}
                lanesLoading={planQuery.isLoading || (!state && !stateQuery.error)}
                lanesError={planMessage(stateQuery.error)}
                onRetryLanes={() => {
                  void stateQuery.refetch();
                  void planQuery.refetch();
                }}
                onOpenTask={selectTask}
                sections={planningProjects.map((project) => {
                  const latest = planQuery.data?.find(
                    (plan) => plan.project === project.key,
                  );
                  return {
                    project,
                    latest,
                    triage: latest?.triage,
                    saved: latest
                      ? { ...latest, entries: latest.savedEntries }
                      : undefined,
                    error: planMessage(planQuery.error),
                  };
                })}
                edits={planEdits}
                saveErrors={planSaveErrors}
                onRetryPlans={() => {
                  void planQuery.refetch();
                  void stateQuery.refetch();
                }}
                onEdit={(project, edit) =>
                  setPlanEdits((edits) => ({ ...edits, [project]: edit }))
                }
                onSave={(project, edit) =>
                  void act(async () => {
                    try {
                      await savePlan(
                        planSaveInput(project, edit, "operator (board)"),
                      );
                      dropPlanEdit(project);
                    } catch (error) {
                      // The draft stays. act's refresh reads the plans again, so a newer saved version shows as a conflict.
                      setPlanSaveErrors((errors) => ({
                        ...errors,
                        [project]: planMessage(error) ?? "Save failed",
                      }));
                    }
                  })
                }
                onCancel={dropPlanEdit}
                repositoryBadges={state?.repositoryBadges}
                tasks={state?.tasks ?? []}
                queuedCounts={state?.queuedCounts ?? []}
                readPlanVersion={(project, version) =>
                  readPlan({ project, version })
                }
                lanePanel={(laneContext) =>
                  planningLaneRecord ? (
                    <LaneScreen
                      key={planningLaneRecord.key}
                      lane={planningLaneRecord}
                      project={laneContext.project}
                      compact={compact}
                      projects={state?.projects ?? []}
                      plans={planQuery.data ?? []}
                      busy={busy}
                      canEdit
                      doc={{
                        data: documentQuery.data,
                        error: documentQuery.error
                          ? planMessage(documentQuery.error)
                          : undefined,
                      }}
                      draft={laneDraft}
                      onDraft={setLaneDraft}
                      onSaveDocument={async ({ version, text }) => {
                        await saveLaneDocument({
                          key: planningLaneRecord.key,
                          version,
                          text,
                          author: "operator (board)",
                        });
                        setLaneDraft(null);
                        await queryClient.invalidateQueries({
                          queryKey: ["nucleus", "lane-document"],
                        });
                      }}
                      onRetryDocument={() => void documentQuery.refetch()}
                      readVersion={(version) =>
                        fetchLaneDocument({
                          key: planningLaneRecord.key,
                          version,
                        })
                      }
                      tasks={{
                        items: laneTasksQuery.data?.tasks,
                        error: laneTasksQuery.error
                          ? planMessage(laneTasksQuery.error)
                          : undefined,
                        total: laneTasksQuery.data?.total,
                        offset: laneTaskOffset,
                        nextOffset: laneTasksQuery.data?.nextOffset,
                      }}
                      onLoadMoreTasks={(offset) => setLaneTaskOffset(offset)}
                      onLoadPreviousTasks={() =>
                        setLaneTaskOffset(Math.max(0, laneTaskOffset - 25))
                      }
                      onRetryTasks={() => void laneTasksQuery.refetch()}
                      leads={{
                        items: leadsQuery.data
                          ? boardLeads.filter((lead) =>
                              planningLeads.some((item) => item.id === lead.id),
                            )
                          : undefined,
                        error: leadsQuery.error
                          ? planMessage(leadsQuery.error)
                          : undefined,
                      }}
                      onRetryLeads={() => void leadsQuery.refetch()}
                      onOpenTask={selectTask}
                      onOpenLead={(lead) => {
                        if (isPapercut(lead)) selectPapercut(lead.id);
                        else
                          selectLead(lead.id, {
                            key: planningLaneRecord.key,
                            title: planningLaneRecord.title,
                          });
                      }}
                      readFinished={(cursor) =>
                        searchOutcomes({
                          lane: planningLaneRecord.key,
                          outcome: "any",
                          limit: 25,
                          ...(cursor ? { cursor } : {}),
                        })
                      }
                      onSelectProject={(project) => {
                        if (!laneContext.showProject(project))
                          showLanePlan(project);
                      }}
                      onSetStatus={(status) =>
                        void act(() =>
                          changeLaneStatus({
                            key: planningLaneRecord.key,
                            status,
                          }),
                        )
                      }
                      c={c}
                    />
                  ) : (
                    <View
                      style={{
                        alignItems: "center",
                        justifyContent: "center",
                        padding: space.lg,
                      }}
                    >
                      <Text style={muted(c)}>Select a lane from the plan.</Text>
                    </View>
                  )
                }
              />
            ) : (
              <>
                <View
                  style={
                    wide
                      ? {
                          width: inboxListWidth,
                          minHeight: 0,
                          backgroundColor: listFill,
                        }
                      : {
                          flex: 1,
                          minWidth: 0,
                          minHeight: 0,
                          backgroundColor: listFill,
                        }
                  }
                >
                  <InboxList
                    c={c}
                    state={state}
                    stateError={stateQuery.error}
                    inbox={inbox}
                    view={view}
                    rust={rustView ? {
                      tasks: rustColumns?.[rustView],
                      error: rustTasks.error,
                      retry: () => void rustTasks.refetch(),
                      selected: rustTaskId,
                      onSelect: selectRustTask,
                      project: ({ identity }) => {
                        const origin = normalizeRepositoryOrigin(identity.repository);
                        const project = projectForRepository(identity.repository, origin);
                        const repo = project?.repositories
                          .find((candidate) => candidate.origin && normalizeRepositoryOrigin(candidate.origin) === origin);
                        return {
                          name: project?.name ?? origin ?? identity.repository,
                          key: project?.key,
                          badge: (repo?.path && state?.repositoryBadges?.[repo.path]) || null,
                        };
                      },
                    } : undefined}
                    leadsLoading={leadsQuery.isLoading}
                    decisions={decisionsQuery.data}
                    decisionsError={decisionsQuery.error}
                    queuedHidden={queuedHidden}
                    projectForRepository={projectForRepository}
                    selected={selected}
                    selectedLeadId={selectedLeadId}
                    openPapercutId={openPapercutId}
                    openDecisionId={openDecisionId}
                    onSelectTask={selectTask}
                    onSelectDecision={selectDecision}
                    onSelectLead={selectLead}
                    onSelectPapercut={selectPapercut}
                    onOpenLane={openLaneInPlanning}
                    busy={busy}
                    act={act}
                    pipeline={pipeline}
                    plans={planQuery.data ?? []}
                  />
                </View>
                {wide && detailPane}
              </>
            )}
          </View>
          {!inlineDetail && detail}
        </BoardHeader>
        {narrow && menuOpen && (
          <Modal
            visible
            transparent
            animationType="fade"
            onRequestClose={() => setMenuOpen(false)}
          >
            <View style={{ flex: 1, flexDirection: "row" }}>
              <View
                accessibilityViewIsModal
                accessibilityLabel="Board menu"
                style={{
                  width: 260,
                  maxWidth: "85%",
                  backgroundColor: navigationFill,
                  paddingTop: space.sm,
                }}
              >
                <Text
                  style={{
                    color: c.foreground,
                    fontSize: typeScale.section.fontSize,
                    fontWeight: "600",
                    paddingHorizontal: space.md,
                    paddingBottom: space.xs,
                  }}
                >
                  Nucleus
                </Text>
                {menu}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close the board menu"
                onPress={() => setMenuOpen(false)}
                style={{ flex: 1, backgroundColor: overlay.scrim }}
              />
            </View>
          </Modal>
        )}
        {removingProject && (
          <ProjectManagementView
            c={c}
            project={removingProject}
            rpc={projectSelector.removal}
            onClose={() => setRemovingProject(null)}
            onRemoved={() => {
              setRemovingProject(null);
              void projectSelector.refresh();
            }}
          />
        )}
      </View>
    </PopoverHost>
  );
}

/**
 * Spec 026 row 14c, the per-project workspace board. The panel resolves the
 * workspace's Nucleus project from its project root (`project.get` by repository)
 * and renders the main surface's board preset to that project. A workspace
 * outside every Nucleus project shows a plain message; there is no second copy of
 * board code — the panel is MainSurface with the workspace preset.
 */
export function QueueBoardPanel(props: BoardWorkspacePanelProps) {
  const c = props.theme.colors;
  const workspace = useWorkspace(props.workspaceId, (w) => w);
  const root = workspace
    ? workspace.projectRootPath || workspace.directory
    : null;
  const fetchProject = useRpc(api.projectGet);
  const [resolution, setResolution] = useState<
    "loading" | "outside" | "error" | WorkspaceBoardScope
  >("loading");
  useEffect(() => {
    if (!root) return;
    let live = true;
    setResolution("loading");
    fetchProject({ repository: { origin: null, path: root } })
      .then((project) => {
        if (live)
          setResolution(
            project ? { key: project.key, name: project.name } : "outside",
          );
      })
      .catch(() => {
        if (live) setResolution("error");
      });
    return () => {
      live = false;
    };
  }, [root, fetchProject]);
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: roles(c).canvas }}>
      {!workspace && (
        <BoardNotice
          text="Nucleus cannot see this workspace, so it cannot tell which project it belongs to."
          c={c}
        />
      )}
      {workspace && !root && (
        <BoardNotice
          text="This workspace has no project root, so it cannot be matched to a Nucleus project."
          c={c}
        />
      )}
      {workspace && root && resolution === "loading" && (
        <BoardNotice text="Finding this workspace's Nucleus project…" c={c} />
      )}
      {workspace && root && resolution === "outside" && (
        <BoardNotice
          text="This workspace is outside every Nucleus project. Its repository is not listed in any project, so there is no board for it here."
          c={c}
        />
      )}
      {workspace && root && resolution === "error" && (
        <BoardNotice
          text="Nucleus could not look up this workspace's project. Try reopening the board."
          c={c}
        />
      )}
      {workspace &&
        root &&
        resolution !== "loading" &&
        resolution !== "outside" &&
        resolution !== "error" && (
          <MainSurface {...props} workspaceBoard={resolution} />
        )}
    </View>
  );
}
function BoardNotice({ text, c }: { text: string; c: Colors }) {
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel="Nucleus board message"
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: space.lg,
      }}
    >
      <Text style={{ ...muted(c), textAlign: "center" }}>{text}</Text>
    </View>
  );
}
