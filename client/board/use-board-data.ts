import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../../shared/contracts";
import type { UiQueueState } from "../../shared/contracts";
import { activeSelection, effectiveSelection, planningLaneLeads, planningScopeLanes, scopedProjects, type ProjectScope } from "../../shared/project-scope";
import { lanePlaces } from "../../shared/lane-finder";
import { useRpc } from "../shell";
import { domainRevision, useBoardState } from "../board-state";
import { useRetainedRead } from "../retained-read";
import { readDecisions, clearDecisionRead } from "../decision-read";
import { errorText } from "../error-text";
import { usePlanningLane } from "../project-scope-controls";
import { runAccounting } from "../qa-runs-tab";
import type { RecordNoticeValue } from "../task/parts";

/** The board's tabs. #866 folded Lanes into Planning; #1113 added Usage. */
export type BoardTab = "queue" | "planning" | "qa" | "usage";
type BoardStateQuery = ReturnType<typeof useBoardState>["stateQuery"];

/** The open task's detail and next reads, polled while it is selected. */
export function useTaskDetail(selected: string | null) {
  const fetchDetail = useRpc(api.detail);
  const fetchNext = useRpc(api.taskNext);
  const detailQuery = useQuery({ queryKey: ["nucleus", "detail", selected], queryFn: () => fetchDetail({ taskId: selected! }), enabled: Boolean(selected), refetchInterval: 4000 });
  // Spec 050 step 6: task.next feeds the Next section beside queue.detail, so
  // the verbs re-derive from the task's recorded facts after every control.
  const nextQuery = useQuery({ queryKey: ["nucleus", "next", selected], queryFn: () => fetchNext({ taskId: selected!, caller: "operator (board)" }), enabled: Boolean(selected), refetchInterval: 4000 });
  return { detailQuery, nextQuery };
}

/**
 * The planning lists: leads, open decisions and plans. The pipeline projection
 * needs all three loaded, so those reads are not gated to one view.
 */
export function useRecordQueries({ stateQuery, state, tab, scopeOpen }: { stateQuery: BoardStateQuery; state: UiQueueState | undefined; tab: BoardTab; scopeOpen: boolean }) {
  const fetchLeadBoard = useRpc(api.leadBoard);
  const fetchDecisions = useRpc(api.decisionList);
  const fetchPlans = useRpc(api.plans);
  // Planning lists read the narrow lead.board projection: card metadata, a bounded
  // preview and the facts the cards show, never full bodies or promoted history.
  // Selection still reads the complete record through lead.get.
  // Task 1030: each planning list keys on its own domain revision, so a run, event or
  // telemetry write never refetches it, and keeps its last result on screen while a new
  // revision loads or a refresh fails (useRetainedRead).
  const leadsRevision = domainRevision(stateQuery.data, "leads"), decisionsRevision = domainRevision(stateQuery.data, "decisions"), plansRevision = domainRevision(stateQuery.data, "plans");
  const leadsFetch = useQuery({queryKey:["nucleus","leads",leadsRevision],queryFn:()=>fetchLeadBoard({}),enabled:scopeOpen||tab==="planning"||tab==="queue",staleTime:300_000,placeholderData:keepPreviousData});
  const leadsQuery = {...useRetainedRead(leadsFetch), isLoading:leadsFetch.isLoading, refetch:leadsFetch.refetch};
  // Spec 032: open decisions feed the Pipeline Decisions column and linked-record
  // chips. The list is open decisions only, so it loads on every tab.
  const decisionsFetch = useQuery({queryKey:["nucleus","decisions",decisionsRevision],queryFn:()=>readDecisions(decisionsRevision,()=>fetchDecisions({status:"open"})),staleTime:300_000,placeholderData:keepPreviousData});
  const decisionsQuery = useRetainedRead(decisionsFetch);
  const planFetch = useQuery({queryKey:["nucleus","plans",plansRevision],queryFn:()=>fetchPlans({}),enabled:(tab==="planning"||tab==="queue")&&Boolean(state?.projects.length),staleTime:300_000,placeholderData:keepPreviousData});
  const planQuery = {...useRetainedRead(planFetch), refetch:planFetch.refetch};
  const staleRead = leadsQuery.stale ? ["Leads", leadsQuery.stale] as const : decisionsQuery.stale ? ["Decisions", decisionsQuery.stale] as const : planQuery.stale ? ["Plans", planQuery.stale] as const : null;
  return { leadsQuery, decisionsQuery, planQuery, staleRead, boardLeads: leadsQuery.data?.cards ?? [], leadLinks: leadsQuery.data?.links ?? [] };
}
export type RecordQueries = ReturnType<typeof useRecordQueries>;

/**
 * The Planning tab's reads: the projects it lists, the open lane, its document
 * and task page, and the lane's leads.
 */
export function usePlanningData({ scope, state, tab, records, onLeaveLane }: { scope: ProjectScope; state: UiQueueState | undefined; tab: BoardTab; records: RecordQueries; onLeaveLane: () => void }) {
  const fetchLaneDocument = useRpc(api.laneDocumentGet);
  const fetchLaneTaskPage = useRpc(api.laneTaskPage);
  const { planQuery, boardLeads } = records;
  const [laneTaskOffset, setLaneTaskOffset] = useState(0);
  // A lane opened from Planning keeps the project context it was found in (#866): the
  // search reaches past the chosen project, so the open lane stays in scope.
  const [planningPin, setPlanningPin] = useState("");
  const planningProjects = effectiveSelection(state?.projects ?? [], activeSelection(scope)).length ? scopedProjects(state?.projects ?? [], activeSelection(scope)) : [...state?.projects ?? []].sort((a,b)=>Number(a.visibility === 'parked')-Number(b.visibility === 'parked')||a.name.localeCompare(b.name));
  // A lane whose projects leave the selection closes; the compact view returns to the plan.
  const planningInScope = state&&planQuery.data ? [...new Set([...planningScopeLanes(state.projects, scope.projects.length ? scope.projects : planningProjects.map(project=>project.key), planQuery.data, state.lanes ?? []), ...(planningPin?[planningPin]:[])])] : null;
  const {lane:planningLane,setLane:setPlanningLane,step:planningStep,setStep:setPlanningStep} = usePlanningLane(planningInScope, onLeaveLane);
  const documentQuery = useQuery({queryKey:["nucleus","lane-document",planningLane],queryFn:()=>fetchLaneDocument({key:planningLane}),enabled:tab==="planning"&&Boolean(planningLane),refetchInterval:4000});
  useEffect(() => setLaneTaskOffset(0), [planningLane]);
  const laneTasksQuery = useQuery({ queryKey:["nucleus","lane-tasks",planningLane,laneTaskOffset], queryFn:()=>fetchLaneTaskPage({lane:planningLane!,offset:laneTaskOffset,limit:25}), enabled:tab==="planning"&&Boolean(planningLane), refetchInterval:4000 });
  const planningLaneRecord = (state?.lanes??[]).find(lane=>lane.key===planningLane);
  // The open lane's leads and papercuts come from every project that lists the lane, whatever the
  // chooser shows, so the lane screen's counts are the lane's own (#867). A lane no project lists falls
  // back to the projects in scope, as it did before (#866).
  const planningLaneProjects = planningLaneRecord ? lanePlaces(planningLaneRecord, state?.projects ?? [], planQuery.data ?? []).map(place => place.key) : [];
  const planningLeads = planningLaneLeads(boardLeads, planningLane, state?.projects??[],
    planningLaneProjects.length ? planningLaneProjects : planningProjects.map(project=>project.key));
  return { planningProjects, planningLane, setPlanningLane, planningStep, setPlanningStep, setPlanningPin, documentQuery, laneTasksQuery, laneTaskOffset, setLaneTaskOffset, planningLaneRecord, planningLeads, fetchLaneDocument };
}

/** Milestone QA, host runs with their accounting, and the QA fence inventory. */
export function useQaData({ tab, selected, state }: { tab: BoardTab; selected: string | null; state: UiQueueState | undefined }) {
  const fetchQaList = useRpc(api.projectQaList);
  const fetchHostRunBoard = useRpc(api.hostRunBoard);
  const fetchQaFence = useRpc(api.projectQaFenceStatus);
  const qaQuery = useQuery({queryKey:["nucleus","project-qa"],queryFn:()=>fetchQaList({}),enabled:tab==="planning"||tab==="qa"||Boolean(selected),refetchInterval:4000});
  // Audit A8: one Queue-private combined read answers the pinned host-run list and
  // the retired-accounting join from the same list call, so the QA tab polls once.
  const hostRunBoardQuery = useQuery({queryKey:["nucleus","host-run-board"],queryFn:()=>fetchHostRunBoard({}),refetchInterval:tab==="qa"?3000:15000});
  const hostRunQuery = {data:hostRunBoardQuery.data?.runs,error:hostRunBoardQuery.error,isLoading:hostRunBoardQuery.isLoading,refetch:hostRunBoardQuery.refetch};
  const runAccountingState = useMemo(()=>runAccounting(hostRunBoardQuery.data?.runs,hostRunBoardQuery.data?.accounting,hostRunBoardQuery.error),[hostRunBoardQuery.data,hostRunBoardQuery.error]);
  const qaFence = state?.qaFence.fence ?? null;
  const qaFenceQuery = useQuery({queryKey:["nucleus","qa-fence"],queryFn:()=>fetchQaFence({}),enabled:tab==="qa"&&Boolean(qaFence),refetchInterval:4000});
  return { qaQuery, hostRunQuery, runAccountingState, qaFence, qaFenceQuery };
}

/** The open records an action refreshes once it lands. */
type OpenRecords = { selected: string | null; selectedLeadId: string | null; openPapercutId: string | null; openDecisionId: string | null };

/**
 * The board's shared action runner. `act` runs a control, reports a failure as a
 * board error (or, `into: "record"`, as the open record's notice) and refreshes
 * the board and the open records; `leadAct` is the lead screen's variant.
 */
export function useBoardAct({ selected, selectedLeadId, openPapercutId, openDecisionId, setRecordNotice }: OpenRecords & { setRecordNotice: (notice: RecordNoticeValue | null) => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function act(fn: () => Promise<unknown>, into: "board" | "record" = "board") {
    setBusy(true);
    if (into === "board") setError("");
    else setRecordNotice(null);
    try {
      await fn();
      clearDecisionRead();
      await queryClient.refetchQueries({ queryKey: ["nucleus", "state"], exact: true });
      void queryClient.invalidateQueries({queryKey:["nucleus","telemetry"]});
      if (selected) void queryClient.invalidateQueries({ queryKey: ["nucleus", "detail", selected], exact: true });
      if (selectedLeadId) void queryClient.invalidateQueries({ queryKey: ["nucleus", "lead", selectedLeadId], exact: true });
      if (openPapercutId) void queryClient.invalidateQueries({ queryKey: ["nucleus", "papercut", openPapercutId], exact: true });
      if (openDecisionId) void queryClient.invalidateQueries({ queryKey: ["nucleus", "decision", openDecisionId], exact: true });
      await queryClient.invalidateQueries({queryKey:["nucleus","leads"]});
      await queryClient.invalidateQueries({queryKey:["nucleus","decisions"]});
      await queryClient.invalidateQueries({queryKey:["nucleus","plans"]});
      await queryClient.invalidateQueries({queryKey:["nucleus","lane-document"]});
    }
    catch (e) {
      const message = errorText(e);
      if (into === "record") setRecordNotice({ kind: "error", text: message });
      else setError(message);
    }
    finally { setBusy(false); }
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
      await queryClient.refetchQueries({ queryKey: ["nucleus", "state"], exact: true });
      await queryClient.invalidateQueries({ queryKey: ["nucleus", "leads"] });
      await queryClient.invalidateQueries({ queryKey: ["nucleus", "decisions"] });
      if (selectedLeadId) await queryClient.invalidateQueries({ queryKey: ["nucleus", "lead", selectedLeadId], exact: true });
      return value;
    } finally { setBusy(false); }
  }
  return { act, leadAct, busy, error, setError };
}
export type BoardAct = ReturnType<typeof useBoardAct>["act"];
