import { useContext } from "react";
import { BoardLiveContext } from "./board-live";
import {
  replaceEqualDeep,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useRpc } from "./shell";
import { useEngineFeatures } from "./engine-features";
import * as api from "../shared/contracts";
import {
  isUnchangedBoard,
  type PlanningRevisions,
  type UiBoard,
  type UiQueueState,
  type UnchangedBoard,
} from "../shared/contracts";

/**
 * The board's one query key. The poll (this module) and the web live channel
 * (`client/web/live-channel.ts`) both write this entry, so neither spells the
 * key out for itself.
 */
export const BOARD_STATE_KEY = ["nucleus", "state"] as const;

export type RetainedBoard = UiQueueState & {
  revision: number;
  planning?: PlanningRevisions;
};

export interface BoardTransitionOptions {
  /**
   * Allow a lower-revision full projection to replace the retained one (used
   * for explicit server replacement or a fresh reconnect/unavailable recovery).
   */
  allowReplacement?: boolean;
}

export interface BoardReadTicket {
  revision: number | undefined;
  epoch: number;
}

interface BoardCacheState {
  commitEpoch: number;
  allowReplacement: boolean;
  replacementArmedAtEpoch: number | null;
  lastGuard: {
    expectedPrev: UiBoard | undefined;
    committed: UiBoard;
  } | null;
}

const boardCacheStates = new WeakMap<QueryClient, BoardCacheState>();

function cacheStateOf(queryClient: QueryClient): BoardCacheState {
  let state = boardCacheStates.get(queryClient);
  if (!state) {
    state = {
      commitEpoch: 0,
      allowReplacement: false,
      replacementArmedAtEpoch: null,
      lastGuard: null,
    };
    boardCacheStates.set(queryClient, state);
  }
  return state;
}

function mergeAckCounters(
  retained: RetainedBoard,
  ack: UnchangedBoard,
): RetainedBoard {
  return {
    ...retained,
    connected: ack.connected,
    paused: ack.paused,
    dispatchHeld: ack.dispatchHeld,
    drained: ack.drained ?? retained.drained,
    boundRuns: ack.boundRuns ?? retained.boundRuns,
    quiet: ack.quiet,
    activeWorkers: ack.activeWorkers,
    unsettled: ack.unsettled,
    occupiedSlots: ack.occupiedSlots ?? retained.occupiedSlots,
    stoppedThreads: ack.stoppedThreads,
    resumedThreads: ack.resumedThreads,
    error: ack.error,
  };
}

function recordCommit(state: BoardCacheState, committed: UiBoard): void {
  state.commitEpoch++;
  if (!isUnchangedBoard(committed)) {
    state.allowReplacement = false;
    state.replacementArmedAtEpoch = null;
  }
}

/**
 * One board read replaces or merges into the retained projection: a complete
 * projection replaces it when its revision is at least as new (or when server
 * replacement is explicitly allowed), while the bounded acknowledgement merges
 * its global counters only into a retained projection of the exact same
 * revision. The merge happens in query state, so every observing surface sees
 * it. The paused-stop counters ride the ack because an episode reset moves them
 * without a board revision (Queue #650).
 */
export function nextBoardState(
  retained: UiBoard | undefined,
  response: UiBoard,
  options: BoardTransitionOptions = {},
): UiBoard {
  if (!retained) return response;
  if (isUnchangedBoard(response)) {
    if (isUnchangedBoard(retained)) {
      return response.revision < retained.revision ? retained : response;
    }
    return response.revision === retained.revision
      ? mergeAckCounters(retained, response)
      : retained;
  }
  return options.allowReplacement || response.revision >= retained.revision
    ? response
    : retained;
}

/**
 * Snapshot the board revision and cache commit epoch before an async RPC read
 * starts so commit time can detect updates that landed while awaiting.
 */
export function beginBoardRead(queryClient: QueryClient): BoardReadTicket {
  const cached = queryClient.getQueryData<UiBoard>(BOARD_STATE_KEY);
  const retained = cached && !isUnchangedBoard(cached) ? cached : undefined;
  return {
    revision: retained?.revision,
    epoch: cacheStateOf(queryClient).commitEpoch,
  };
}

/**
 * Commit a completed RPC board response against the latest cache state rather
 * than the pre-await projection, enforcing revision and ack ordering rules.
 */
export function commitBoardRead(
  queryClient: QueryClient,
  response: UiBoard,
  started: BoardReadTicket,
): UiBoard {
  const state = cacheStateOf(queryClient);
  const current = queryClient.getQueryData<UiBoard>(BOARD_STATE_KEY);
  const sameEpoch = started.epoch === state.commitEpoch;

  let next: UiBoard;
  if (sameEpoch) {
    const allowReplacement =
      !isUnchangedBoard(response) &&
      (started.revision !== undefined ||
        (state.allowReplacement &&
          state.replacementArmedAtEpoch === state.commitEpoch));
    next = nextBoardState(current, response, { allowReplacement });
  } else if (!current) {
    next = response;
  } else if (isUnchangedBoard(response)) {
    next =
      isUnchangedBoard(current) && response.revision > current.revision
        ? response
        : current;
  } else if (isUnchangedBoard(current)) {
    next = response.revision >= current.revision ? response : current;
  } else {
    next = response.revision > current.revision ? response : current;
  }

  if (current !== undefined && next === current) {
    state.lastGuard = { expectedPrev: current, committed: current };
    return current;
  }

  recordCommit(state, next);
  state.lastGuard = { expectedPrev: current, committed: next };
  return next;
}

/**
 * Commit a live board or counter frame into the shared query cache, enforcing
 * the same revision and ack rules against whatever is currently cached.
 */
export function commitBoardUpdate(
  queryClient: QueryClient,
  response: UiBoard,
): UiBoard | undefined {
  return queryClient.setQueryData<UiBoard>(BOARD_STATE_KEY, (retained) => {
    const state = cacheStateOf(queryClient);
    const allowReplacement =
      !isUnchangedBoard(response) &&
      state.allowReplacement &&
      state.replacementArmedAtEpoch === state.commitEpoch;
    const next = nextBoardState(retained, response, { allowReplacement });
    if (retained !== undefined && next === retained) return retained;
    recordCommit(state, next);
    return next;
  });
}

function armReplacement(queryClient: QueryClient): void {
  const state = cacheStateOf(queryClient);
  state.allowReplacement = true;
  state.replacementArmedAtEpoch = state.commitEpoch;
}

/**
 * Mark the cached board invalidated on an `unavailable` signal and allow the
 * replacement projection (including a lower revision after server restart) to
 * replace it when it arrives.
 */
export function invalidateBoardState(queryClient: QueryClient): void {
  armReplacement(queryClient);
  void queryClient.invalidateQueries({ queryKey: BOARD_STATE_KEY });
}

/**
 * Arm replacement for the first full board frame after a live stream reconnects
 * so a restarted server with a lower revision is not blocked by the prior run.
 */
export function markBoardReconnect(queryClient: QueryClient): void {
  armReplacement(queryClient);
}

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
  const rust = useEngineFeatures().engine === "rust";
  const fetchState = useRpc(api.uiSnapshot);
  const queryClient = useQueryClient();
  const stateQuery = useQuery({
    queryKey: BOARD_STATE_KEY,
    refetchInterval: live || rust ? false : 4000,
    staleTime: rust ? Infinity : 0,
    queryFn: async (): Promise<UiBoard> => {
      const started = beginBoardRead(queryClient);
      const response = await fetchState(
        started.revision === undefined ? {} : { revision: started.revision },
      );
      return commitBoardRead(queryClient, response, started);
    },
    structuralSharing: (prevData, nextData) => {
      const state = cacheStateOf(queryClient);
      const guard = state.lastGuard;
      if (guard && nextData === guard.committed) {
        state.lastGuard = null;
        if (prevData !== undefined && prevData !== guard.expectedPrev) {
          const prevBoard = prevData as UiBoard;
          const nextBoard = nextData as UiBoard;
          const strictlyNewer =
            !isUnchangedBoard(nextBoard) &&
            (isUnchangedBoard(prevBoard) ||
              nextBoard.revision > prevBoard.revision);
          return replaceEqualDeep(
            prevData,
            strictlyNewer ? nextBoard : prevBoard,
          );
        }
      }
      return replaceEqualDeep(prevData, nextData);
    },
  });
  const state = boardOf(stateQuery);
  return { stateQuery, state };
}

/** The full board projection a surface renders; the bounded ack never reaches a view. */
export function boardOf(stateQuery: {
  data?: UiBoard;
}): RetainedBoard | undefined {
  const data = stateQuery.data;
  return data && !isUnchangedBoard(data) ? data : undefined;
}

/**
 * The read key for one planning list (task 1030): that domain's own revision, so a run,
 * event or telemetry write never refetches it. A service without per-domain revisions
 * falls back to the board revision; a bounded acknowledgement has neither.
 */
export function domainRevision(
  board: UiBoard | undefined,
  domain: keyof PlanningRevisions,
): number | undefined {
  if (!board || isUnchangedBoard(board)) return undefined;
  return board.planning?.[domain] ?? board.revision;
}
