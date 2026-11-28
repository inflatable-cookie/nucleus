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
  matchesRepository,
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
import {
  InboxList,
  RustListRows,
  useInboxBoard,
  usePipelineState,
} from "./board/inbox-list";
import { InboxMenu, type BoardView } from "./board/inbox-menu";
import {
  ProjectsOverview,
  projectOverviewColumns,
  type ProjectSelectorInputs,
} from "./board/projects-overview";
import { useBoardSelection } from "./board/use-board-selection";
import {
  useBoardAct,
  usePlanningData,
  useRecordQueries,
  type BoardTab,
} from "./board/use-board-data";
import { RustTaskDialog } from "./task/rust-task";
import {
  groupRustTasks,
  postRustCommand,
  rustProjectActivity,
  rustSelectorCounts,
  useRustTasks,
  type RustCommand,
  type RustTask,
  type RustInvalidation,
  type RustBoardTransport,
} from "./web/rust-board";
import { RustItemDialog } from "./records/rust-item";
import { DecisionDialog } from "./records/decision-dialog";
import type { RecordNoticeValue } from "./task/parts";
import { overlay, roles, space, type as typeScale } from "./design";

export { TaskCard, DecisionCard } from "./board/cards";
export { TriageLeadCard } from "./board/triage-lead-card";

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

function useSavedScope(rust: boolean) {
  const [stored, save] = useProjectScope();
  const bindings = stored.projects;
  const surfaceScope = useMemo(
    () =>
      rust
        ? {
            projects: bindings
              .filter((key) => key.startsWith("rust:"))
              .map((key) => key.slice(5)),
          }
        : stored,
    [bindings, rust, stored],
  );
  return {
    surfaceScope,
    unresolvedScope: rust && surfaceScope.projects.length !== bindings.length,
    saveSurfaceScope: (value: { projects: string[] }) =>
      save(
        rust ? { projects: value.projects.map((key) => "rust:" + key) } : value,
      ),
  };
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
  workspaceBoard,
  rustBoard,
  planningIssues,
  boardTransport,
}: BoardSurfaceProps & {
  workspaceBoard?: WorkspaceBoardScope;
  now?: number;
  rustBoard?: RustInvalidation;
  planningIssues?: string;
  boardTransport?: RustBoardTransport;
}) {
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
  const queryClient = useQueryClient();
  const [view, setView] = useState<BoardView>("needs");
  const [menuOpen, setMenuOpen] = useState(false);
  // The reads still key on the two data shapes: Planning's, and the card lists'.
  const tab: BoardTab = view === "planning" ? "planning" : "queue";
  // The revisioned board read (Contract 007) lives in the shared board-state
  // hook, so every surface hydrates from one projection and panel mounts never
  // wait for their own poll.
  const { stateQuery, state } = useBoardState();
  const { surfaceScope, saveSurfaceScope, unresolvedScope } =
    useSavedScope(!workspaceBoard);
  const [panelScope, setPanelScope] = usePanelScope(
    workspaceBoard?.key ?? null,
  );
  const scope = workspaceBoard
    ? (panelScope ?? { projects: [workspaceBoard.key] })
    : surfaceScope;
  const setScope = workspaceBoard ? setPanelScope : saveSurfaceScope;
  const [, setScopeOpen] = useState(false);
  const {
    recordProject,
    selected,
    rustTaskId,
    setRustTaskId,
    selectedLeadId,
    setSelectedLeadId,
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
  // Unsaved plan drafts, one per project section: entries and the version they were based on.
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
  const rustTasks = useRustTasks(Boolean(rustBoard), boardTransport);
  const rustColumns = useMemo(() => {
    if (!rustTasks.data) return undefined;
    const contains = scopeContains(state?.projects ?? [], scope.projects);
    return groupRustTasks(
      rustTasks.data.filter(({ identity }) =>
        contains(identity.repository, identity.repository),
      ),
    );
  }, [rustTasks.data, state?.projects, scope.projects]);
  const rustView =
    Boolean(rustBoard) &&
    view !== "planning" &&
    view !== "projects" &&
    view !== "leads" &&
    view !== "papercuts"
      ? view
      : null;
  // On the Rust engine every task is a Rust task. The project selector counts
  // each project's open tasks through its hidden-count input, keyed by checkout.
  const selectorCounts = useMemo(
    () =>
      rustTasks.data
        ? rustSelectorCounts(state?.projects ?? [], rustTasks.data)
        : (state?.queuedCounts ?? []),
    [rustTasks.data, state?.projects, state?.queuedCounts],
  );
  // The selector's row actions (nucleus#1430) refresh the board after each save; Remove opens the shared removal dialog below.
  const projectSelector = useProjectSelectorActions(
    () => stateQuery.refetch(),
    state?.canEditSettings === true,
  );
  const [removingProject, setRemovingProject] = useState<api.Project | null>(
    null,
  );
  const records = useRecordQueries();
  const {
    leadsQuery,
    decisionsQuery,
    planQuery,
    staleRead,
    boardLeads,
    leadLinks,
  } = records;
  const projectActivity = useMemo(
    () =>
      state && rustTasks.data
        ? rustProjectActivity(
            state.projects,
            rustTasks.data,
            leadsQuery.data?.activity ?? [],
          )
        : (state?.projectActivity ?? []),
    [
      state?.projects,
      state?.projectActivity,
      rustTasks.data,
      leadsQuery.data?.activity,
    ],
  );
  // The header's project select and the Projects overview order projects from the same inputs.
  const selectorInputs: ProjectSelectorInputs = {
    tasks: state?.tasks ?? [],
    leads: boardLeads,
    queuedCounts: selectorCounts,
    projectActivity,
  };
  const overviewColumns = useMemo(
    () =>
      view === "projects" && state
        ? projectOverviewColumns({
            projects: state.projects,
            selector: selectorInputs,
            leads: leadsQuery.data ? boardLeads : undefined,
            tasks: rustTasks.data,
          })
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      view,
      state?.projects,
      state?.tasks,
      boardLeads,
      leadsQuery.data,
      selectorCounts,
      projectActivity,
      rustTasks.data,
    ],
  );
  const {
    lanes,
    planningProjects,
    planningLane,
    planningLaneProject,
    planningLaneRef,
    setPlanningLane,
    planningStep,
    setPlanningStep,
    setPlanningPin,
    documentQuery,
    laneTasksQuery,
    laneTaskOffset,
    setLaneTaskOffset,
    planningLaneRecord,
    rustLaneTasks,
    taskCounts,
    planningLeads,
    fetchLaneDocument,
  } = usePlanningData({
    scope,
    state,
    tab,
    records,
    rustTasks: rustTasks.data,
    onLeaveLane: () => setLaneDraft(null),
  });
  const laneCards = new Set(planningLeads);
  // The list's tag filter, pages and held-back queue reads outlive a visit to another view.
  const pipeline = usePipelineState();
  const { act, busy, error, setError } = useBoardAct({
    recordProject,
    selectedLeadId,
    openPapercutId,
    openDecisionId,
    setRecordNotice,
  });
  useEffect(() => {
    setError("");
  }, [selected, view]);
  useEffect(() => {
    setRecordNotice(null);
  }, [recordProject, selectedLeadId, openPapercutId, openDecisionId]);
  const recordKey = `${recordProject ?? ""}|${selectedLeadId ?? ""}|${openPapercutId ?? ""}|${openDecisionId ?? ""}`;
  // Stale saved keys (a removed project) drop out, so every view treats them alike.
  // The selection is the only filter state (nucleus#1476): an empty selection shows
  // all projects in every scoped view, and clearing the last project restores them.
  const selection = effectiveSelection(state?.projects ?? [], scope.projects);
  const belongs = scopeContains(state?.projects ?? [], selection);
  const projectForRepository = (repoPath: string, origin?: string | null) =>
    state?.projects.find((project) =>
      projectHasRepository(project, repoPath, origin),
    );
  const [rustBusy, setRustBusy] = useState(false);
  const rustListProps = {
    error: rustTasks.error,
    retry: () => void rustTasks.refetch(),
    selected: rustTaskId,
    onSelect: selectRustTask,
    busy: rustBusy,
    onCommand: rustBoard
      ? (id: string, command: RustCommand) => {
          setRustBusy(true);
          setError("");
          void postRustCommand(id, command)
            .then(
              () => {
                rustBoard(id);
              },
              (err: unknown) => setError(errorText(err)),
            )
            .finally(() => setRustBusy(false));
        }
      : undefined,
    project: ({ identity }: RustTask) => {
      const origin = normalizeRepositoryOrigin(identity.repository);
      const project = projectForRepository(
        identity.repository,
        identity.repository,
      );
      const repo = project?.repositories.find((candidate) =>
        matchesRepository(candidate, identity.repository, identity.repository),
      );
      return {
        name: project?.name ?? origin ?? identity.repository,
        key: project?.key,
        badge: (repo?.path && state?.repositoryBadges?.[repo.path]) || null,
      };
    },
  };
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
  const selectPlanningLane = (key: string, project?: string) => {
    if (!project) {
      setError("Select a project before opening this lane.");
      return;
    }
    setPlanningPin(key);
    setPlanningLane(key, project);
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
  const laneName = (key: string) =>
    lanes.find((lane) => lane.key === key)?.title ?? key;
  /** A project's T3 badge, from its first repository with one. */
  const itemBadge = (key: string) => {
    const project = state?.projects.find((candidate) => candidate.key === key);
    const path = project?.repositories.find(
      (repo) => repo.path && state?.repositoryBadges?.[repo.path],
    )?.path;
    return (path && state?.repositoryBadges?.[path]) || null;
  };
  const inset = space.md;
  // The first failed board read, in plain words: which read failed and why.
  // A raw schema dump never reaches the header (nucleus#1141).
  const failedRead = (
    [
      ["Board state", stateQuery.error],
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
  // holds the lane and Projects fills the width, so a record opened from either is a
  // modal, as on a narrower board.
  const inlineDetail = wide && view !== "planning" && view !== "projects";
  const anyRecord = Boolean(
    rustTaskId || selectedLeadId || openPapercutId || openDecisionId,
  );
  const detail =
    rustTaskId && rustBoard ? (
      <RustTaskDialog
        key={`rust:${rustTaskId}`}
        id={rustTaskId}
        summary={rustTasks.data?.find(
          ({ identity }) => identity.id === rustTaskId,
        )}
        project={rustListProps.project}
        onOpenTask={selectRustTask}
        inline={inlineDetail}
        compact={compact}
        c={c}
        onClose={() => setRustTaskId(null)}
        invalidate={rustBoard}
      />
    ) : selectedLeadId || openPapercutId ? (
      // The Rust engine keeps leads and papercuts as one item (Spec 071).
      <RustItemDialog
        key={recordKey}
        id={(selectedLeadId ?? openPapercutId)!}
        project={recordProject}
        kind={selectedLeadId ? "lead" : "papercut"}
        inline={inlineDetail}
        compact={compact}
        c={c}
        laneName={laneName}
        badge={itemBadge}
        task={(id) =>
          rustTasks.data?.find(({ identity }) => identity.id === id)
        }
        onOpenTask={selectRustTask}
        onClose={() => {
          setLeadLane(null);
          setSelectedLeadId(null);
          setOpenPapercutId(null);
        }}
      />
    ) : openDecisionId ? (
      <DecisionDialog
        key={recordKey}
        project={recordProject}
        id={openDecisionId}
        compact={compact}
        busy={busy}
        act={act}
        recordNotice={recordNotice}
        setRecordNotice={setRecordNotice}
        onOpenDecision={(id) => selectDecision(id, recordProject)}
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
          selectRustTask(id);
        }}
        inline={inlineDetail}
        onClose={() => setOpenDecisionId(null)}
        c={c}
      />
    ) : null;
  const detailPane = (
    <View
      accessibilityLabel="Detail"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        backgroundColor: roles(c).canvas,
      }}
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
      pendingCounts={[
        ...(!decisionsQuery.data ? ["needs" as const] : []),
        ...(!planQuery.data ? ["planning" as const] : []),
        ...(!leadsQuery.data ? ["leads" as const, "papercuts" as const] : []),
      ]}
      rust={
        rustBoard
          ? {
              totals: Object.fromEntries(
                Object.entries(rustColumns ?? {}).map(([column, tasks]) => [
                  column,
                  tasks.length,
                ]),
              ),
            }
          : undefined
      }
      onSelect={openView}
    />
  );
  const filter = (
    <ProjectSelector
      projects={state?.projects ?? []}
      {...selectorInputs}
      value={scope.projects}
      // The picker commits the selection it reports, and an empty pick
      // (Clear, or Shift-clearing the last project) restores all projects.
      onChange={(projects) => setScope({ projects })}
      onSettings={
        settingsOpener ? () => settingsOpener?.("projects") : undefined
      }
      projectActions={{
        ...projectSelector.actions,
        ...(state?.canEditSettings === true
          ? { remove: setRemovingProject }
          : {}),
      }}
      onOpenChange={setScopeOpen}
      compact={narrow}
      c={c}
    />
  );
  if (unresolvedScope)
    return (
      <PopoverHost>
        <BoardNotice
          c={c}
          text={
            state
              ? "The saved project filter uses an older format. Choose a project or clear the selection."
              : stateQuery.error
                ? readErrorText("Board state", stateQuery.error)
                : "Reading the saved project filter…"
          }
        />
        {state && filter}
      </PopoverHost>
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
            rustTasks.data?.filter((task) => task.wait === "running").length ??
            null
          }
          refetchState={stateQuery.refetch}
          busy={busy}
          act={act}
          error={error}
          onDismissError={() => setError("")}
          readError={
            [readError, planningIssues].filter(Boolean).join("\n") || null
          }
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
                  ...(wide
                    ? { borderRightWidth: 1, borderColor: roles(c).hairline }
                    : {}),
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
                  listSurface:
                    narrow && canvas !== section ? "canvas" : "section",
                }}
                leads={boardLeads}
                onCloseLane={(key, project, note) =>
                  void act(() =>
                    changeLaneStatus({ key, project, status: "done", note }),
                  )
                }
                onReopenLane={(key, project) =>
                  void act(() =>
                    changeLaneStatus({ key, project, status: "active" }),
                  )
                }
                busy={busy}
                step={planningStep}
                onStep={setPlanningStep}
                selectedLane={planningLane}
                selectedLaneProject={planningLaneProject}
                onOpenLane={selectPlanningLane}
                lanes={lanes}
                projects={state?.projects ?? []}
                projectActivity={projectActivity}
                selection={scope.projects}
                plans={planQuery.data ?? []}
                plansError={planMessage(planQuery.error)}
                lanesLoading={
                  planQuery.isLoading ||
                  (!state && !stateQuery.error) ||
                  Boolean(rustBoard && rustTasks.isLoading)
                }
                lanesError={planMessage(
                  stateQuery.error ??
                    (rustBoard && !rustTasks.data ? rustTasks.error : null),
                )}
                onRetryLanes={() => {
                  if (rustBoard && !rustTasks.data) void rustTasks.refetch();
                  void stateQuery.refetch();
                  void planQuery.refetch();
                }}
                onOpenTask={selectRustTask}
                sections={planningProjects.map((project) => {
                  const latest = planQuery.data?.find(
                    (plan) => plan.project === project.key,
                  );
                  return {
                    project,
                    latest,
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
                taskCounts={taskCounts}
                queuedCounts={state?.queuedCounts ?? []}
                readPlanVersion={(project, version) =>
                  readPlan({ project, version })
                }
                lanePanel={(laneContext) =>
                  rustBoard && !rustTasks.data ? (
                    <RustListRows
                      c={c}
                      view="working"
                      rust={{ ...rustListProps, tasks: undefined }}
                    />
                  ) : planningLaneRecord && planningLaneRef ? (
                    <LaneScreen
                      key={JSON.stringify([
                        planningLaneRef.project,
                        planningLaneRef.key,
                      ])}
                      lane={planningLaneRecord}
                      project={planningLaneRef.project}
                      compact={compact}
                      projects={state?.projects ?? []}
                      plans={(planQuery.data ?? []).filter(
                        ({ project }) =>
                          !planningLaneRecord.project ||
                          project === planningLaneRef.project,
                      )}
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
                          ...planningLaneRef,
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
                          ...planningLaneRef,
                          version,
                        })
                      }
                      tasks={
                        rustBoard
                          ? {
                              total: rustLaneTasks?.length,
                              rows: (
                                <RustListRows
                                  c={c}
                                  view="working"
                                  rust={{
                                    ...rustListProps,
                                    tasks: rustLaneTasks,
                                  }}
                                />
                              ),
                            }
                          : {
                              items: laneTasksQuery.data?.tasks,
                              error: laneTasksQuery.error
                                ? planMessage(laneTasksQuery.error)
                                : undefined,
                              total: laneTasksQuery.data?.total,
                              offset: laneTaskOffset,
                              nextOffset: laneTasksQuery.data?.nextOffset,
                            }
                      }
                      onLoadMoreTasks={(offset) => setLaneTaskOffset(offset)}
                      onLoadPreviousTasks={() =>
                        setLaneTaskOffset(Math.max(0, laneTaskOffset - 25))
                      }
                      onRetryTasks={() => void laneTasksQuery.refetch()}
                      leads={{
                        items: leadsQuery.data
                          ? boardLeads.filter((lead) => laneCards.has(lead))
                          : undefined,
                        error: leadsQuery.error
                          ? planMessage(leadsQuery.error)
                          : undefined,
                      }}
                      onRetryLeads={() => void leadsQuery.refetch()}
                      onOpenTask={selectRustTask}
                      onOpenLead={(lead) => {
                        if (isPapercut(lead))
                          selectPapercut(lead.id, lead.projectKey);
                        else
                          selectLead(
                            lead.id,
                            {
                              key: planningLaneRecord.key,
                              title: planningLaneRecord.title,
                            },
                            lead.projectKey,
                          );
                      }}
                      onSelectProject={(project) => {
                        if (!laneContext.showProject(project))
                          showLanePlan(project);
                      }}
                      onSetStatus={(status, note) =>
                        void act(() =>
                          changeLaneStatus({
                            ...planningLaneRef,
                            status,
                            note,
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
            ) : view === "projects" ? (
              <ProjectsOverview
                c={c}
                columns={overviewColumns}
                narrowWidth={narrow && panelWidth > 0 ? panelWidth : null}
                badge={itemBadge}
                rust={rustListProps}
                items={{
                  selected:
                    selectedLeadId || openPapercutId
                      ? {
                          id: (selectedLeadId ?? openPapercutId)!,
                          project: recordProject,
                        }
                      : null,
                  repositoryBadges: state?.repositoryBadges,
                  onSelectLead: (id, project) => selectLead(id, null, project),
                  onSelectPapercut: selectPapercut,
                }}
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
                          borderRightWidth: 1,
                          borderColor: roles(c).hairline,
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
                    scope={selection}
                    view={view}
                    rust={
                      rustView
                        ? {
                            tasks: rustColumns?.[rustView],
                            ...rustListProps,
                          }
                        : undefined
                    }
                    leadsLoading={leadsQuery.isLoading}
                    decisions={decisionsQuery.data}
                    decisionsError={decisionsQuery.error}
                    queuedHidden={queuedHidden}
                    projectForRepository={projectForRepository}
                    selected={selected}
                    recordProject={recordProject}
                    selectedLeadId={selectedLeadId}
                    openPapercutId={openPapercutId}
                    openDecisionId={openDecisionId}
                    onSelectTask={selectTask}
                    onSelectDecision={selectDecision}
                    onSelectLead={selectLead}
                    onSelectPapercut={selectPapercut}
                    busy={busy}
                    act={act}
                    pipeline={pipeline}
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
