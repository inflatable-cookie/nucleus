import { useEffect, useMemo, useState } from "react";
import {
  keepPreviousData,
  skipToken,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as api from "../../shared/contracts";
import type { UiQueueState } from "../../shared/contracts";
import {
  effectiveSelection,
  planningLaneLeads,
  planningScopeLanes,
  projectHasRepository,
  scopedProjects,
  type ProjectScope,
} from "../../shared/project-scope";
import { lanePlaces, laneProjects } from "../../shared/lane-finder";
import { useRpc } from "../shell";
import type { RustTask } from "../web/rust-board";
import { useEngineFeatures } from "../engine-features";
import { domainRevision, useBoardState } from "../board-state";
import { useRetainedRead } from "../retained-read";
import { readDecisions, clearDecisionRead } from "../decision-read";
import { errorText } from "../error-text";
import { usePlanningLane } from "../project-scope-controls";
import type { RecordNoticeValue } from "../task/parts";

/** The board's tabs. #866 folded Lanes into Planning; PR #403 removed QA runs. */
export type BoardTab = "queue" | "planning";
type BoardStateQuery = ReturnType<typeof useBoardState>["stateQuery"];

/** The open task's detail and next reads, polled while it is selected. */
export function useTaskDetail(selected: string | null) {
  const fetchDetail = useRpc(api.detail);
  const fetchNext = useRpc(api.taskNext);
  const detailQuery = useQuery({
    queryKey: ["nucleus", "detail", selected],
    queryFn: () => fetchDetail({ taskId: selected! }),
    enabled: Boolean(selected),
    refetchInterval: 4000,
  });
  // Spec 050 step 6: task.next feeds the Next section beside queue.detail, so
  // the verbs re-derive from the task's recorded facts after every control.
  const nextQuery = useQuery({
    queryKey: ["nucleus", "next", selected],
    queryFn: () => fetchNext({ taskId: selected!, caller: "operator (board)" }),
    enabled: Boolean(selected),
    refetchInterval: 4000,
  });
  return { detailQuery, nextQuery };
}

/**
 * The paired board reads its menu counts on entry and refreshes the collections
 * on engine events. The TypeScript pipeline keeps its shared revisioned reads.
 */
export function useRecordQueries({
  stateQuery,
  state,
  tab,
  scopeOpen,
}: {
  stateQuery: BoardStateQuery;
  state: UiQueueState | undefined;
  tab: BoardTab;
  scopeOpen: boolean;
}) {
  const rust = useEngineFeatures().engine === "rust";
  const fetchLeadBoard = useRpc(api.leadBoard);
  const fetchDecisions = useRpc(api.decisionList);
  const fetchPlans = useRpc(api.plans);
  // Planning lists read the narrow lead.board projection: card metadata, a bounded
  // preview and the facts the cards show, never full bodies or promoted history.
  // Selection still reads the complete record through lead.get.
  // Task 1030: each planning list keys on its own domain revision, so a run, event or
  // telemetry write never refetches it, and keeps its last result on screen while a new
  // revision loads or a refresh fails (useRetainedRead).
  const leadsRevision = rust ? undefined : domainRevision(stateQuery.data, "leads"),
    decisionsRevision = rust ? undefined : domainRevision(stateQuery.data, "decisions"),
    plansRevision = rust ? undefined : domainRevision(stateQuery.data, "plans");
  const staleTime = rust ? Infinity : 300_000;
  const leadsFetch = useQuery({
    queryKey: ["nucleus", "leads", leadsRevision],
    queryFn: () => fetchLeadBoard({}),
    enabled: rust || scopeOpen || tab === "planning" || tab === "queue",
    staleTime,
    placeholderData: keepPreviousData,
  });
  const leadsQuery = {
    ...useRetainedRead(leadsFetch),
    isLoading: leadsFetch.isLoading,
    refetch: leadsFetch.refetch,
  };
  const decisionsFetch = useQuery({
    queryKey: ["nucleus", "decisions", decisionsRevision],
    queryFn: () => rust
      ? fetchDecisions({ status: "open" })
      : readDecisions(decisionsRevision, () => fetchDecisions({ status: "open" })),
    staleTime,
    placeholderData: keepPreviousData,
  });
  const decisionsQuery = useRetainedRead(decisionsFetch);
  const planFetch = useQuery({
    queryKey: ["nucleus", "plans", plansRevision],
    queryFn: () => fetchPlans({}),
    enabled:
      rust || ((tab === "planning" || tab === "queue") && Boolean(state?.projects.length)),
    staleTime,
    placeholderData: keepPreviousData,
  });
  const planQuery = {
    ...useRetainedRead(planFetch),
    isLoading: planFetch.isLoading,
    refetch: planFetch.refetch,
  };
  const staleRead = leadsQuery.stale
    ? (["Leads", leadsQuery.stale] as const)
    : decisionsQuery.stale
      ? (["Decisions", decisionsQuery.stale] as const)
      : planQuery.stale
        ? (["Plans", planQuery.stale] as const)
        : null;
  return {
    leadsQuery,
    decisionsQuery,
    planQuery,
    staleRead,
    boardLeads: leadsQuery.data?.cards ?? [],
    leadLinks: leadsQuery.data?.links ?? [],
  };
}
export type RecordQueries = ReturnType<typeof useRecordQueries>;

/**
 * The Planning tab's reads: the projects it lists, the open lane, its document
 * and task page, and the lane's leads.
 */
export function usePlanningData({
  scope,
  state,
  tab,
  records,
  rustTasks,
  onLeaveLane,
}: {
  scope: ProjectScope;
  state: UiQueueState | undefined;
  tab: BoardTab;
  records: RecordQueries;
  rustTasks?: RustTask[];
  onLeaveLane: () => void;
}) {
  const rust = useEngineFeatures().engine === "rust";
  const fetchLaneDocument = useRpc(api.laneDocumentGet);
  const fetchLaneTaskPage = useRpc(api.laneTaskPage);
  const { planQuery, boardLeads } = records;
  const { lanes, members } = useMemo(() => {
    const members = new Map<api.LaneView, RustTask[]>();
    if (!rust) return { lanes: state?.lanes ?? [], members };
    const lanes = (planQuery.data ?? []).flatMap(plan => {
      const project = state?.projects.find(candidate => candidate.key === plan.project);
      const byLane = new Map<string, RustTask[]>();
      for (const task of rustTasks ?? []) {
        const origin = task.identity.repository;
        if (!project || task.phase === "done" || task.phase === "cancelled" ||
            !projectHasRepository(project, origin, origin)) continue;
        for (const key of task.lanes ?? []) {
          const rows = byLane.get(key);
          if (rows) rows.push(task);
          else byLane.set(key, [task]);
        }
      }
      return (plan.laneViews ?? []).map(lane => {
        const rows = byLane.get(lane.key) ?? [];
        const liveByPhase: Record<string, number> = {};
        for (const { phase } of rows) liveByPhase[phase] = (liveByPhase[phase] ?? 0) + 1;
        const view = { ...lane, liveByPhase };
        if (rustTasks) members.set(view, rows);
        return view;
      });
    });
    return { lanes, members };
  }, [rust, planQuery.data, state?.lanes, state?.projects, rustTasks]);
  const [laneTaskOffset, setLaneTaskOffset] = useState(0);
  // A lane opened from Planning keeps the project context it was found in (#866): the
  // search reaches past the chosen project, so the open lane stays in scope.
  const [planningPin, setPlanningPin] = useState("");
  const planningProjects = effectiveSelection(
    state?.projects ?? [],
    scope.projects,
  ).length
    ? scopedProjects(state?.projects ?? [], scope.projects)
    : [...(state?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  // A lane whose projects leave the selection closes; the compact view returns to the plan.
  const planningInScope =
    state && planQuery.data
      ? [
          ...new Set([
            ...planningScopeLanes(
              state.projects,
              scope.projects.length
                ? scope.projects
                : planningProjects.map((project) => project.key),
              planQuery.data,
              lanes,
            ),
            ...(planningPin ? [planningPin] : []),
          ]),
        ]
      : null;
  const {
    lane: planningLane,
    project: planningLaneProject,
    setLane: setPlanningLane,
    step: planningStep,
    setStep: setPlanningStep,
  } = usePlanningLane(planningInScope, onLeaveLane);
  const planningLaneRecord = lanes.find((lane) =>
    lane.key === planningLane &&
    Boolean(planningLaneProject) &&
    laneProjects(lane, state?.projects ?? []).some(({ key }) => key === planningLaneProject),
  );
  const planningLaneRef =
    planningLaneProject && planningLaneRecord
      ? { key: planningLane, project: planningLaneProject }
      : null;
  const documentQuery = useQuery({
    queryKey: ["nucleus", "lane-document", planningLaneProject, planningLane],
    queryFn: planningLaneRef ? () => fetchLaneDocument(planningLaneRef) : skipToken,
    enabled: tab === "planning" && Boolean(planningLaneRef),
    refetchInterval: rust ? false : 4000,
    staleTime: rust ? Infinity : 0,
  });
  useEffect(() => setLaneTaskOffset(0), [planningLaneProject, planningLane]);
  const laneTasksQuery = useQuery({
    queryKey: ["nucleus", "lane-tasks", planningLaneProject, planningLane, laneTaskOffset],
    queryFn: () =>
      fetchLaneTaskPage({
        lane: planningLane!,
        offset: laneTaskOffset,
        limit: 25,
      }),
    enabled: !rust && tab === "planning" && Boolean(planningLane),
    refetchInterval: rust ? false : 4000,
    staleTime: rust ? Infinity : 0,
  });
  // The open lane's leads and papercuts come from every project that lists the lane, whatever the
  // chooser shows, so the lane screen's counts are the lane's own (#867). A lane no project lists falls
  // back to the projects in scope, as it did before (#866).
  const planningLaneProjects = planningLaneRecord
    ? lanePlaces(
        planningLaneRecord,
        state?.projects ?? [],
        planQuery.data ?? [],
      ).map((place) => place.key)
    : [];
  const planningLeads = planningLaneLeads(
    boardLeads,
    planningLane,
    state?.projects ?? [],
    planningLaneProjects.length
      ? planningLaneProjects
      : planningProjects.map((project) => project.key),
  );
  return {
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
    rustLaneTasks: planningLaneRecord && members.get(planningLaneRecord),
    planningLeads,
    fetchLaneDocument,
  };
}

/** The open records an action refreshes once it lands. */
type OpenRecords = {
  selected: string | null;
  recordProject?: string;
  selectedLeadId: string | null;
  openPapercutId: string | null;
  openDecisionId: string | null;
};

/**
 * The board's shared action runner. `act` runs a control, reports a failure as a
 * board error (or, `into: "record"`, as the open record's notice) and refreshes
 * the board and the open records; `leadAct` is the lead screen's variant.
 */
export function useBoardAct({
  recordProject,
  selected,
  selectedLeadId,
  openPapercutId,
  openDecisionId,
  setRecordNotice,
}: OpenRecords & {
  setRecordNotice: (notice: RecordNoticeValue | null) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function act(
    fn: () => Promise<unknown>,
    into: "board" | "record" = "board",
  ) {
    setBusy(true);
    if (into === "board") setError("");
    else setRecordNotice(null);
    try {
      await fn();
      clearDecisionRead();
      await queryClient.refetchQueries({
        queryKey: ["nucleus", "state"],
        exact: true,
      });
      void queryClient.invalidateQueries({
        queryKey: ["nucleus", "telemetry"],
      });
      if (selected)
        void queryClient.invalidateQueries({
          queryKey: ["nucleus", "detail", selected],
          exact: true,
        });
      if (selectedLeadId)
        void queryClient.invalidateQueries({
          queryKey: ["nucleus", "lead", selectedLeadId, recordProject],
          exact: true,
        });
      if (openPapercutId)
        void queryClient.invalidateQueries({
          queryKey: ["nucleus", "papercut", openPapercutId, recordProject],
          exact: true,
        });
      if (openDecisionId)
        void queryClient.invalidateQueries({
          queryKey: ["nucleus", "decision", openDecisionId, recordProject],
          exact: true,
        });
      await queryClient.invalidateQueries({ queryKey: ["nucleus", "leads"] });
      await queryClient.invalidateQueries({
        queryKey: ["nucleus", "decisions"],
      });
      await queryClient.invalidateQueries({ queryKey: ["nucleus", "plans"] });
      await queryClient.invalidateQueries({
        queryKey: ["nucleus", "lane-document"],
      });
    } catch (e) {
      const message = errorText(e);
      if (into === "record") setRecordNotice({ kind: "error", text: message });
      else setError(message);
    } finally {
      setBusy(false);
    }
  }
  /**
   * A lead screen action: it reports its own result or refusal beside the control, so the
   * value comes back to the screen and a failure is rethrown there instead of becoming a
   * board notice. The board and this record are refreshed on success as `act` does.
   */
  async function leadAct<T>(fn: () => Promise<T>): Promise<T> {
    setBusy(true);
    try {
      const value = await fn();
      clearDecisionRead();
      await queryClient.refetchQueries({
        queryKey: ["nucleus", "state"],
        exact: true,
      });
      await queryClient.invalidateQueries({ queryKey: ["nucleus", "leads"] });
      await queryClient.invalidateQueries({
        queryKey: ["nucleus", "decisions"],
      });
      if (selectedLeadId)
        await queryClient.invalidateQueries({
          queryKey: ["nucleus", "lead", selectedLeadId, recordProject],
          exact: true,
        });
      return value;
    } finally {
      setBusy(false);
    }
  }
  return { act, leadAct, busy, error, setError };
}
export type BoardAct = ReturnType<typeof useBoardAct>["act"];
