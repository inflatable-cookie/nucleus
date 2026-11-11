import { useContext } from "react";
import { BoardLiveContext } from "./board-live";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "./shell";
import * as api from "../shared/contracts";
import { isUnchangedBoard, type PlanningRevisions, type UiBoard, type UiQueueState } from "../shared/contracts";

/**
 * The revisioned board read (Contract 007), shared by every Queue surface: the
 * main surface, the workspace panel and the native settings screen all observe
 * one React Query entry. The retained projection and the last observed store
 * revision live in the query's own data — not in per-hook refs — so a surface
 * that mounts while another surface's fetch is in flight hydrates from the same
 * cached board immediately, and an unchanged four-second refresh transfers only
 * counters, never another complete board.
 */
export function useBoardState() {
  const live = useContext(BoardLiveContext);
  const fetchState = useRpc(api.uiSnapshot);
  const queryClient = useQueryClient();
  const stateQuery = useQuery({
    queryKey: ["nucleus", "state"],
    refetchInterval: live ? false : 4000,
    queryFn: async (): Promise<UiBoard> => {
      const cached = queryClient.getQueryData<UiBoard>(["nucleus", "state"]);
      const retained = cached && !isUnchangedBoard(cached) ? cached : undefined;
      const response = await fetchState(retained?.revision === undefined ? {} : { revision: retained.revision });
      if (isUnchangedBoard(response)) {
        // Bounded delta: merge the fresh global counters into the retained board
        // projection instead of transferring another complete one. The merge
        // happens in query state, so every observing surface sees it. The
        // paused-stop counters ride the ack because an episode reset moves them
        // without a board revision (Queue #650).
        if (!retained) return response;
        return { ...retained, connected: response.connected, paused: response.paused, dispatchHeld: response.dispatchHeld, drained: response.drained ?? retained.drained, boundRuns: response.boundRuns ?? retained.boundRuns, quiet: response.quiet, activeWorkers: response.activeWorkers, unsettled: response.unsettled, occupiedSlots: response.occupiedSlots ?? retained.occupiedSlots, stoppedThreads: response.stoppedThreads, resumedThreads: response.resumedThreads, error: response.error };
      }
      return response;
    },
  });
  const state = boardOf(stateQuery);
  return { stateQuery, state };
}

/** The full board projection a surface renders; the bounded ack never reaches a view. */
export function boardOf(stateQuery: { data?: UiBoard }): (UiQueueState & { revision: number; planning?: PlanningRevisions }) | undefined {
  const data = stateQuery.data;
  return data && !isUnchangedBoard(data) ? data : undefined;
}

/**
 * The read key for one planning list (task 1030): that domain's own revision, so a run,
 * event or telemetry write never refetches it. A service without per-domain revisions
 * falls back to the board revision; a bounded acknowledgement has neither.
 */
export function domainRevision(board: UiBoard | undefined, domain: keyof PlanningRevisions): number | undefined {
  if (!board || isUnchangedBoard(board)) return undefined;
  return board.planning?.[domain] ?? board.revision;
}
