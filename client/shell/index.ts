import type { BoardShell } from "./types";

export let useRpc: BoardShell["useRpc"];
export let useWorkspace: BoardShell["useWorkspace"];
export let Icon: BoardShell["Icon"];

/** Bind the host hooks before registering board surfaces. */
export function bindBoardShell(shell: BoardShell): void {
  ({ useRpc, useWorkspace, Icon } = shell);
}

export type * from "./types";
