import React, { useState, useEffect } from "react";
import { Text, View } from "react-native";
import { useRpc, useWorkspace, type BoardSurfaceProps, type BoardWorkspacePanelProps } from "./shell";
import { muted, row, TabRow, type Colors } from "./controls";
import { useBoardState } from "./board-state";
import { PopoverHost } from "./popover";
import { PlanningTab, type PlanEdit } from "./planning-panel";
import { ProjectSelector, usePanelScope, useProjectScope } from "./project-scope-controls";
import { useQueryClient } from "@tanstack/react-query";
import * as api from "../shared/contracts";
import type { HostRunRecord, TaskSummary } from "../shared/contracts";
import { hiddenQueuedByProject } from "../shared/queued-more";
import { planSaveInput } from "../shared/planning-tab";
import { activeSelection, effectiveSelection, scopeContains } from "../shared/project-scope";
import { navigationViews, openTaskCount, workspaceNavigationViews, type SettingsTarget } from "../shared/queue-navigation";
import { errorText, readErrorText, storedBoardErrorText } from "./error-text";
import { LaneScreen, isPapercut, type LaneDraft } from "./lane-screen";
import { UsagePage } from "./usage";
import { QaRunsTab, liveHostRun, type RunAccounting } from "./qa-runs-tab";
import { attention } from "./board/text";
import { BoardHeader } from "./board/header";
import { PipelineBoard, usePipelineState } from "./board/pipeline";
import { useBoardAct, usePlanningData, useQaData, useRecordQueries, useTaskDetail, type BoardTab } from "./board/use-board-data";
import { TaskDialog } from "./task/task-dialog";
import { useTaskDraftStore } from "./task/drafts";
import { LeadDialog } from "./records/lead-dialog";
import { PapercutDialog } from "./records/papercut-dialog";
import { DecisionDialog } from "./records/decision-dialog";
import type { RecordNoticeValue } from "./task/parts";
import { space, type as typeScale } from "./design";
export { TaskCard, DecisionCard } from "./board/cards";
export { TaskSummaryBlock, taskIdentityFields, EventRow, type TaskDetailTab, TaskDetailTabs, TechnicalActivityEvents, RunRow, MessageRow, RawRecords, DetailField } from "./task/parts";
export { NextSection } from "./task/next-section";
export { ProjectValidationSection, CompactTelemetrySummary } from "./telemetry-parts";

/** Live host runs: queued, admitted or running with charged accounting, plus settled runs still holding capacity. */
const activeHostRuns = (runs?: HostRunRecord[], accounting?: RunAccounting) => (runs ?? []).filter(run => liveHostRun(run, accounting));
export type WorkspaceBoardScope = { key: string; name: string };

/** The header's Settings icon opens Queue's native Paseo settings screen; the
 * client entry registers the host's `openSettings` here before any surface renders.
 * A section (the project chooser's settings icon passes Projects) rides as a hint. */
let settingsOpener: ((section?: SettingsTarget) => void) | null = null;
export function registerSettingsOpener(open: (section?: SettingsTarget) => void): void { settingsOpener = open; }

/**
 * A tab the sidebar's usage rings ask the board to show (nucleus#1123). The rings
 * sit beside the Nucleus button in the Paseo sidebar, and each opens the board on
 * its Usage tab; a request made while no board is mounted waits for the next one,
 * and while a board is open the newest request moves it.
 */
let requestedBoardTab: BoardTab | null = null;
const boardTabListeners = new Set<(tab: BoardTab) => void>();
export function requestBoardTab(tab: BoardTab): void {
  requestedBoardTab = tab;
  for (const show of boardTabListeners) show(tab);
}

/**
 * The board shell: tabs, project scope and the open task or record. The header
 * (`board/header.tsx`), the Pipeline (`board/pipeline.tsx`) and the reads
 * (`board/use-board-data.ts`) live in their own modules.
 */
export function MainSurface({ theme, layout, navigation, workspaceBoard }: BoardSurfaceProps & { workspaceBoard?: WorkspaceBoardScope }) {
  const workspacePanel = Boolean(workspaceBoard);
  const c = theme.colors;
  const [panelWidth, setPanelWidth] = useState(0);
  const compact = layout.compact || panelWidth > 0 && panelWidth < 700;
  const savePlan = useRpc(api.planSet);
  const runQa = useRpc(api.projectQaRun), cancelQa = useRpc(api.projectQaCancel), retryQaTeardown = useRpc(api.projectQaRetryTeardown);
  const releaseHostRunCapacity = useRpc(api.hostRunCapacityRelease);
  const saveLaneDocument = useRpc(api.laneDocumentEdit);
  const changeLaneStatus = useRpc(api.laneStatus);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<BoardTab>("queue");
  // A ring's tab request is taken on mount (that ring just opened the board) and
  // while the board is open; the request is spent once a board has taken it.
  useEffect(() => {
    const show = (next: BoardTab) => setTab(next);
    boardTabListeners.add(show);
    if (requestedBoardTab) { const pending = requestedBoardTab; requestedBoardTab = null; show(pending); }
    return () => { boardTabListeners.delete(show); };
  }, []);
  // A board QA card opens the QA runs page on its run (Tom, 2026-11-01).
  const [qaFocusId, setQaFocusId] = useState<string | null>(null);
  const [surfaceScope, setSurfaceScope] = useProjectScope();
  // Spec 026 row 14c: the workspace panel's selection is preset to the workspace's
  // project and lives in the panel, never in the main surface's persisted scope.
  const [panelScope, setPanelScope] = usePanelScope(workspaceBoard?.key ?? null);
  const scope = workspaceBoard ? panelScope ?? { projects: [workspaceBoard.key], statusFilter: true } : surfaceScope;
  const setScope = workspaceBoard ? setPanelScope : setSurfaceScope;
  const [scopeOpen, setScopeOpen] = useState(false), [selected, setSelected] = useState<string | null>(null);
  // Unsaved plan drafts, one per project section: entries, idle mark and the version they were based on.
  const [planEdits,setPlanEdits] = useState<Record<string,PlanEdit>>({});
  // The last failed save per project. The draft stays; the section says why it was not saved.
  const [planSaveErrors,setPlanSaveErrors] = useState<Record<string,string>>({});
  // The open lane's unsaved document text. Leaving the lane or the Planning tab keeps it until it is saved or discarded.
  const [laneDraft,setLaneDraft] = useState<LaneDraft|null>(null);
  const [selectedLeadId,setSelectedLeadId] = useState<string|null>(null);
  // #868: the lane a lead was opened from, so the lead screen says where it sits; the
  // Triage column opens a lead with no lane and clears it.
  const [leadLane,setLeadLane] = useState<{key:string;title:string}|null>(null);
  const [openPapercutId,setOpenPapercutId] = useState<string|null>(null);
  // Spec 032: the decision dialog keyed by the decision's id; its answer and
  // withdraw boxes clear when it closes or moves to another decision.
  const [openDecisionId,setOpenDecisionId] = useState<string|null>(null);
  const [recordNotice,setRecordNotice] = useState<RecordNoticeValue|null>(null);
  // The revisioned board read (Contract 007) lives in the shared board-state
  // hook, so every surface hydrates from one projection and panel mounts never
  // wait for their own poll.
  const { stateQuery, state } = useBoardState();
  const { detailQuery, nextQuery } = useTaskDetail(selected);
  const records = useRecordQueries({ stateQuery, state, tab, scopeOpen });
  const { leadsQuery, decisionsQuery, planQuery, staleRead, boardLeads, leadLinks } = records;
  const {planningProjects, planningLane, setPlanningLane, planningStep, setPlanningStep, setPlanningPin, documentQuery, laneTasksQuery, laneTaskOffset, setLaneTaskOffset, planningLaneRecord, planningLeads, fetchLaneDocument} = usePlanningData({ scope, state, tab, records, onLeaveLane: ()=>setLaneDraft(null) });
  const { qaQuery, hostRunQuery, runAccountingState, qaFence, qaFenceQuery } = useQaData({ tab, selected, state });
  // The Pipeline's Triage filter, pages and measurements outlive a visit to another tab.
  const pipelineView = usePipelineState();
  const { act, leadAct, busy, error, setError } = useBoardAct({ selected, selectedLeadId, openPapercutId, openDecisionId, setRecordNotice });
  // Record dialogs own their drafts and remount per record, so they clear when it closes or
  // moves on. Task-detail drafts live in the draft store: the dispose, escalation, replacement,
  // work-disposition and note drafts clear when the task or tab changes; the rest persist.
  useEffect(() => { setError(""); }, [selected, tab]);
  const taskDrafts = useTaskDraftStore(`${selected ?? ""}|${tab}`);
  useEffect(() => { setRecordNotice(null); }, [selectedLeadId, openPapercutId, openDecisionId]);
  const recordKey = `${selectedLeadId ?? ""}|${openPapercutId ?? ""}|${openDecisionId ?? ""}`;
  // Opening a task, decision, lead, papercut or QA run closes whichever other record was open.
  const selectTask = (id: string) => { setSelectedLeadId(null); setOpenPapercutId(null); setOpenDecisionId(null); setSelected(id); };
  const selectDecision = (id: string) => { setSelected(null); setSelectedLeadId(null); setOpenPapercutId(null); setOpenDecisionId(id); };
  const selectLead = (id: string, lane: {key:string;title:string}|null) => { setSelected(null); setOpenDecisionId(null); setOpenPapercutId(null); setLeadLane(lane); setSelectedLeadId(id); };
  const selectPapercut = (id: string) => { setSelected(null); setOpenDecisionId(null); setSelectedLeadId(null); setOpenPapercutId(id); };
  const openQaRun = (id: string) => { setSelected(null); setSelectedLeadId(null); setOpenPapercutId(null); setOpenDecisionId(null); setQaFocusId(id); setTab("qa"); };
  const liveTasks = state?.tasks.filter(t => (!["done","cancelled"].includes(t.phase)||Boolean(t.originError||t.originLookupError))) ?? [];
  const setScopeProjects = (projects: string[]) => setScope({ ...scope, projects });
  // Stale saved keys (a removed project) drop out, so every view treats them alike.
  // The Pipeline filter switch scopes the Pipeline view only: off shows all
  // projects without clearing the selection, on applies it. Papercuts, Lanes
  // and Planning keep the selection either way.
  // The selector's Enabled switch applies to every scoped view (Tom, 2026-09-28).
  const selection = effectiveSelection(state?.projects ?? [], activeSelection(scope));
  const pipelineFilterSelection = selection;
  const belongs = scopeContains(state?.projects ?? [], selection);
  const projectForRepository = (repoPath: string, origin?: string | null) => state?.projects.find(project => project.repositories.some(repo => origin && repo.origin ? repo.origin === origin : Boolean(repo.path && repo.path === repoPath)));
  const parkedRepository = (repoPath: string, origin?: string | null) => projectForRepository(repoPath, origin)?.visibility === 'parked';
  const taskNeedsAttention = (task: TaskSummary) => task.held || task.phase === 'changes_requested' || attention(task);
  const attentionPaths = new Set(liveTasks.filter(task=>taskNeedsAttention(task)).map(task=>task.repoPath));
  const attentionBelongs = (repoPath: string, origin?: string | null) => belongs(repoPath, origin) || parkedRepository(repoPath, origin) && attentionPaths.has(repoPath);
  const queuedCounts = (state?.queuedCounts ?? []).filter(item => attentionBelongs(item.repoPath));
  const queuedHidden = hiddenQueuedByProject(queuedCounts, state?.tasks ?? []);
  const hiddenQueued = queuedHidden.reduce((sum, item) => sum + item.hidden, 0);
  const projectForTask = (task: { repoPath: string; repository?: string | null }) => state?.projects.find(project => project.repositories.some(repo =>
    task.repository && repo.origin ? repo.origin === task.repository : Boolean(repo.path && repo.path === task.repoPath)));
  const multiRepository = (task: { repoPath: string; repository?: string | null }) => (projectForTask(task)?.repositories.length ?? 1) > 1;
  /** A read or save failure's message; undefined when there was no failure. */
  const planMessage = (error: unknown) => error == null ? undefined : errorText(error);
  const dropPlanEdit = (key:string) => {
    setPlanEdits(edits=>Object.fromEntries(Object.entries(edits).filter(([project])=>project!==key)));
    setPlanSaveErrors(errors=>Object.fromEntries(Object.entries(errors).filter(([project])=>project!==key)));
  };
  const selectPlanningLane = (key:string) => {setPlanningPin(key);setPlanningLane(key);setLaneDraft(null);setPlanningStep("lane")};
  /** Lane projects' "Show plan": the chooser moves to that project and the lane stays open. */
  const showLanePlan = (project: string) => { setScopeProjects([project]); setPlanningStep('plan'); };

  const laneName = (key: string) => (state?.lanes ?? []).find(lane => lane.key === key)?.title ?? key;
  const task = detailQuery.data?.task;
  const inset=compact?16:24;
  // The first failed board read, in plain words: which read failed and why.
  // A raw schema dump never reaches the header (nucleus#1141).
  const failedRead = ([
    ["Board state", stateQuery.error],
    ["Task detail", detailQuery.error],
    ["Leads", leadsQuery.error],
    ["Decisions", decisionsQuery.error],
    ["Plans", planQuery.error],
    ["Lane document", documentQuery.error],
  ] as Array<[string, unknown]>).find(([, failure]) => failure != null);
  const readError = failedRead ? readErrorText(failedRead[0], failedRead[1])
    : state?.error ? storedBoardErrorText(state.error)
    : null;
  // Every popover on the board renders in this host's layer, above the columns (Tom, 2026-11-08).
  return (
    <PopoverHost>
    <View
      onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, minHeight: 0, backgroundColor: c.surface0 }}
    >
      <BoardHeader c={c} workspaceName={workspaceBoard?.name} state={state} refetchState={stateQuery.refetch} busy={busy} act={act}
        error={error} onDismissError={() => setError("")} readError={readError} staleRead={staleRead} inset={inset} settingsOpener={settingsOpener}
        navigation={
            <View style={{ ...row, justifyContent: "space-between", zIndex: 20 }}>
              <TabRow
                c={c}
                label="Nucleus navigation"
                tabs={(workspacePanel ? workspaceNavigationViews : navigationViews).map((view) => ({
                  id: view.id,
                  text:
                    view.id === "queue" && state
                      ? `Tasks (${openTaskCount(state.tasks, attentionBelongs) + hiddenQueued} open)`
                      : view.id === "qa"
                        ? `QA runs (${activeHostRuns(hostRunQuery.data, runAccountingState).length})`
                        : view.label,
                }))}
                value={tab}
                onChange={setTab}
              />
              <View style={row}>
                {(tab === "queue" ||
                  tab === "planning" ||
                  tab === "qa") && (
                  <ProjectSelector
                    enabled={scope.statusFilter}
                    onEnabledChange={(statusFilter) =>
                      setScope({ ...scope, statusFilter })
                    }
                    projects={state?.projects ?? []}
                    tasks={state?.tasks ?? []}
                    leads={boardLeads}
                    value={scope.projects}
                    onChange={setScopeProjects}
                    onSettings={settingsOpener ? () => settingsOpener?.("projects") : undefined}
                    onOpenChange={setScopeOpen}
                    compact={compact}
                    c={c}
                  />
                )}
              </View>
            </View>
        }
      >
        {tab === "planning" && (
          <View
            style={{
              flex: 1,
              minHeight: 0,
              paddingHorizontal: inset,
              paddingBottom: inset,
              gap: space.sm,
            }}
          >
            <PlanningTab
              c={c}
              compact={compact}
              leads={boardLeads}
              onCloseLane={(lane) =>
                void act(() => changeLaneStatus({ key: lane, status: "done" }))
              }
              busy={busy}
              step={planningStep}
              onStep={setPlanningStep}
              selectedLane={planningLane}
              onOpenLane={selectPlanningLane}
              lanes={state?.lanes ?? []}
              projects={state?.projects ?? []}
              selection={activeSelection(scope)}
              plans={planQuery.data ?? []}
              plansError={planMessage(planQuery.error)}
              lanesLoading={!state && !stateQuery.error}
              lanesError={planMessage(stateQuery.error)}
              onSelectProjects={setScopeProjects}
              onRetryLanes={() => {
                void stateQuery.refetch();
                void planQuery.refetch();
              }}
              qaRuns={qaQuery.data}
              qaLoading={qaQuery.isLoading}
              qaError={planMessage(qaQuery.error)}
              onRetryQa={() => {
                void qaQuery.refetch();
              }}
              onOpenQaRun={openQaRun}
              sections={planningProjects.map(project => {
                const latest = planQuery.data?.find(plan => plan.project === project.key);
                return {
                  project,
                  latest,
                  saved: latest ? { ...latest, entries: latest.savedEntries } : undefined,
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
                    await savePlan(planSaveInput(project, edit, "operator (board)"));
                    dropPlanEdit(project);
                  } catch (error) {
                    // The draft stays. act's refresh reads the plans again, so a newer saved version shows as a conflict.
                    setPlanSaveErrors((errors) => ({ ...errors, [project]: planMessage(error) ?? "Save failed" }));
                  }
                })
              }
              onCancel={dropPlanEdit}
              lanePanel={
                planningLaneRecord ? (
                  <LaneScreen
                    key={planningLaneRecord.key}
                    lane={planningLaneRecord}
                    compact={compact}
                    projects={state?.projects ?? []}
                    plans={planQuery.data ?? []}
                    selected={activeSelection(scope)}
                    busy={busy}
                    canEdit
                    doc={{ data: documentQuery.data, error: documentQuery.error ? planMessage(documentQuery.error) : undefined }}
                    draft={laneDraft}
                    onDraft={setLaneDraft}
                    onSaveDocument={async ({ version, text }) => {
                      await saveLaneDocument({ key: planningLaneRecord.key, version, text, author: "operator (board)" });
                      setLaneDraft(null);
                      await queryClient.invalidateQueries({ queryKey: ["nucleus", "lane-document"] });
                    }}
                    onRetryDocument={() => void documentQuery.refetch()}
                    readVersion={(version) => fetchLaneDocument({ key: planningLaneRecord.key, version })}
                    tasks={{ items: laneTasksQuery.data?.tasks, error: laneTasksQuery.error ? planMessage(laneTasksQuery.error) : undefined, total: laneTasksQuery.data?.total, offset: laneTaskOffset, nextOffset: laneTasksQuery.data?.nextOffset }}
                    onLoadMoreTasks={(offset) => setLaneTaskOffset(offset)}
                    onLoadPreviousTasks={() => setLaneTaskOffset(Math.max(0, laneTaskOffset - 25))}
                    onRetryTasks={() => void laneTasksQuery.refetch()}
                    leads={{ items: leadsQuery.data ? boardLeads.filter((lead) => planningLeads.some((item) => item.id === lead.id)) : undefined, error: leadsQuery.error ? planMessage(leadsQuery.error) : undefined }}
                    onRetryLeads={() => void leadsQuery.refetch()}
                    onOpenTask={selectTask}
                    onOpenLead={(lead) => {
                      if (isPapercut(lead)) selectPapercut(lead.id);
                      else selectLead(lead.id, { key: planningLaneRecord.key, title: planningLaneRecord.title });
                    }}
                    onSelectProject={showLanePlan}
                    onSetStatus={(status) => void act(() => changeLaneStatus({ key: planningLaneRecord.key, status }))}
                    c={c}
                  />
                ) : (
                  <>
                    <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: typeScale.section.fontSize, fontWeight: "600" }}>Lane</Text>
                    <Text style={muted(c)}>Select a lane from the plan.</Text>
                  </>
                )
              }
            />
          </View>
        )}
        {tab === "qa" && (
          <QaRunsTab
            focusRunId={qaFocusId}
            runs={hostRunQuery.data}
            qaRuns={qaQuery.data}
            accounting={runAccountingState}
            projects={state?.projects ?? []}
            tasks={state?.tasks ?? []}
            fence={qaFence}
            fenceInventory={
              qaFenceQuery.data?.view.fence?.id === qaFence?.id
                ? qaFenceQuery.data?.inventory
                : undefined
            }
            selectedProjects={activeSelection(scope)}
            busy={busy}
            loading={hostRunQuery.isLoading || qaQuery.isLoading}
            loadError={
              hostRunQuery.error || qaQuery.error
                ? String(hostRunQuery.error || qaQuery.error)
                : undefined
            }
            onRunQa={(repository) =>
              void act(async () => {
                await runQa({ repository });
                await qaQuery.refetch();
              })
            }
            onCancelQa={(id, reason) =>
              void act(async () => {
                await cancelQa({ id, reason });
                await qaQuery.refetch();
              })
            }
            onRetryTeardownQa={(id, reason) =>
              void act(async () => {
                await retryQaTeardown({ id, reason });
                await qaQuery.refetch();
              })
            }
            onReleaseCapacity={(runId, reason) =>
              void act(async () => {
                await releaseHostRunCapacity({ runId, reason });
                await hostRunQuery.refetch();
              })
            }
            onOpenTask={selectTask}
            c={c}
          />
        )}
        {tab === "usage" && (
          <View style={{ flex: 1, minHeight: 0 }}>
            <UsagePage theme={theme} layout={{ compact }} />
          </View>
        )}
        {tab === "queue" && (
        <View style={{ flex: 1, minHeight: 0, gap: space.sm, zIndex: 0 }}>
          <PipelineBoard c={c} state={state} stateError={stateQuery.error} compact={compact} inset={inset} panelWidth={panelWidth}
            pipelineFilterSelection={pipelineFilterSelection} boardLeads={boardLeads} leadLinks={leadLinks} leadsLoading={leadsQuery.isLoading}
            decisions={decisionsQuery.data} queuedHidden={queuedHidden} parkedRepository={parkedRepository} projectForRepository={projectForRepository}
            selected={selected} selectedLeadId={selectedLeadId} openPapercutId={openPapercutId} openDecisionId={openDecisionId}
            onSelectTask={selectTask} onOpenQueuedTask={setSelected} onSelectDecision={selectDecision} onSelectLead={selectLead} onSelectPapercut={selectPapercut}
            onOpenQaRun={openQaRun} busy={busy} act={act} refetchQa={qaQuery.refetch} view={pipelineView} />
            {task && (
              <TaskDialog
                task={task}
                detailQuery={detailQuery}
                nextQuery={nextQuery}
                state={state}
                decisions={decisionsQuery.data}
                qaRuns={qaQuery.data}
                spansRepositories={multiRepository(task)}
                compact={compact}
                busy={busy}
                act={act}
                drafts={taskDrafts}
                navigation={navigation}
                onClose={() => setSelected(null)}
                onSelectTask={setSelected}
                c={c}
              />
            )}
            {selectedLeadId && (
              <LeadDialog
                id={selectedLeadId}
                lane={leadLane}
                compact={compact}
                busy={busy}
                leadAct={leadAct}
                onClose={() => {
                  setLeadLane(null);
                  setSelectedLeadId(null);
                }}
                c={c}
              />
            )}
            {/* A record dialog remounts when any open record changes, which clears its drafts. */}
            {openPapercutId && (
              <PapercutDialog
                key={recordKey}
                id={openPapercutId}
                compact={compact}
                busy={busy}
                act={act}
                recordNotice={recordNotice}
                setRecordNotice={setRecordNotice}
                laneName={laneName}
                onClose={() => setOpenPapercutId(null)}
                c={c}
              />
            )}
            {openDecisionId && (
              <DecisionDialog
                key={recordKey}
                id={openDecisionId}
                compact={compact}
                busy={busy}
                act={act}
                recordNotice={recordNotice}
                setRecordNotice={setRecordNotice}
                onOpenDecision={setOpenDecisionId}
                onOpenTask={(id) => { setOpenDecisionId(null); setSelected(id); }}
                onClose={() => setOpenDecisionId(null)}
                c={c}
              />
            )}
        </View>
        )}
      </BoardHeader>
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
  const workspace = useWorkspace(props.workspaceId, w => w);
  const root = workspace ? workspace.projectRootPath || workspace.directory : null;
  const fetchProject = useRpc(api.projectGet);
  const [resolution, setResolution] = useState<"loading" | "outside" | "error" | WorkspaceBoardScope>("loading");
  useEffect(() => {
    if (!root) return;
    let live = true;
    setResolution("loading");
    fetchProject({ repository: { origin: null, path: root } })
      .then(project => { if (live) setResolution(project ? { key: project.key, name: project.name } : "outside"); })
      .catch(() => { if (live) setResolution("error"); });
    return () => { live = false; };
  }, [root, fetchProject]);
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: c.surface0 }}>
    {!workspace && <BoardNotice text="Nucleus cannot see this workspace, so it cannot tell which project it belongs to." c={c} />}
    {workspace && !root && <BoardNotice text="This workspace has no project root, so it cannot be matched to a Nucleus project." c={c} />}
    {workspace && root && resolution === "loading" && <BoardNotice text="Finding this workspace's Nucleus project…" c={c} />}
    {workspace && root && resolution === "outside" && <BoardNotice text="This workspace is outside every Nucleus project. Its repository is not listed in any project, so there is no board for it here." c={c} />}
    {workspace && root && resolution === "error" && <BoardNotice text="Nucleus could not look up this workspace's project. Try reopening the board." c={c} />}
    {workspace && root && resolution !== "loading" && resolution !== "outside" && resolution !== "error" && <MainSurface {...props} workspaceBoard={resolution} />}
  </View>;
}
function BoardNotice({ text, c }: { text: string; c: Colors }) {
  return <View accessibilityRole="text" accessibilityLabel="Nucleus board message" style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg }}>
    <Text style={{ ...muted(c), textAlign: "center" }}>{text}</Text>
  </View>;
}
