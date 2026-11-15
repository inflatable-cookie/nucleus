import type { QueryClient } from "@tanstack/react-query";
import * as api from "../../shared/contracts";
import type { UiBoard, UnchangedBoard } from "../../shared/contracts";
import { BOARD_STATE_KEY, nextBoardState } from "../board-state";

/**
 * The web board's live channel: the frames the service writes on
 * `text/event-stream` (`service/web/web-board.ts`), decoded into the board
 * contract before they reach the query cache. The RPC path parses a contract's
 * output, so the live path parses the same schema; a frame the contract does not
 * carry is refused with its reason instead of being written through.
 */

/** One server-sent event frame: the event name and the first data line, as the service writes them. */
export type LiveFrame = { event: string | null; data: string | null };

/**
 * Split the complete frames off the read buffer. The tail is the next read's
 * prefix, so a frame split across two reads is decoded once, whole.
 */
export function readLiveFrames(pending: string): { frames: LiveFrame[]; rest: string } {
  const text = pending.replace(/\r\n/g, "\n");
  const frames: LiveFrame[] = [];
  let rest = text;
  let end: number;
  while ((end = rest.indexOf("\n\n")) >= 0) {
    const frame = rest.slice(0, end);
    rest = rest.slice(end + 2);
    frames.push({
      event: /^event: (.+)$/m.exec(frame)?.[1] ?? null,
      data: /^data: (.+)$/m.exec(frame)?.[1] ?? null,
    });
  }
  return { frames, rest };
}

/**
 * What one frame means. `ignored` is a frame this channel does not carry — the
 * service's keepalive, its retry hint, or an event a newer service added;
 * `refused` is a frame of a kind this channel carries whose payload does not
 * match the board contract, and it is never applied.
 */
export type LiveUpdate =
  | { kind: "board"; board: UiBoard }
  | { kind: "counters"; counters: UnchangedBoard }
  | { kind: "unavailable" }
  | { kind: "ignored" }
  | { kind: "refused"; reason: string };

const LIVE_EVENTS = new Set(["board", "counters", "unavailable"]);

function refused(event: string, error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): LiveUpdate {
  const issue = error.issues[0];
  const at = issue && issue.path.length ? `${issue.path.map(String).join(".")} ` : "";
  return { kind: "refused", reason: `Live ${event} frame does not match the board contract: ${at}${issue?.message ?? "unknown shape"}` };
}

export function decodeLiveFrame(frame: LiveFrame): LiveUpdate {
  if (frame.event === null || frame.data === null || !LIVE_EVENTS.has(frame.event)) return { kind: "ignored" };
  let value: unknown;
  try {
    value = JSON.parse(frame.data);
  } catch {
    return { kind: "refused", reason: `Live ${frame.event} frame is not JSON` };
  }
  if (frame.event === "unavailable") return { kind: "unavailable" };
  if (frame.event === "board") {
    const parsed = api.uiSnapshot.output.safeParse(value);
    return parsed.success ? { kind: "board", board: parsed.data } : refused(frame.event, parsed.error);
  }
  const parsed = api.boardAckSchema.safeParse(value);
  return parsed.success ? { kind: "counters", counters: parsed.data } : refused(frame.event, parsed.error);
}

/**
 * Apply one decoded frame to the board query cache. A board or counters frame
 * goes through the same replace-or-merge rule the poll uses; an unavailable
 * board drops the cached projection so the next read asks for a fresh one.
 */
export function applyLiveUpdate(query: QueryClient, update: LiveUpdate): void {
  if (update.kind === "board" || update.kind === "counters") {
    const response = update.kind === "board" ? update.board : update.counters;
    void query.setQueryData<UiBoard>(BOARD_STATE_KEY, retained => nextBoardState(retained, response));
  } else if (update.kind === "unavailable") {
    void query.invalidateQueries({ queryKey: BOARD_STATE_KEY });
  }
}
