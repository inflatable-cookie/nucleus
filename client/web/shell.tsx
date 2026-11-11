import React, { createContext, useCallback, useContext } from "react";
import * as icons from "lucide-react";
import type { BoardIconProps, BoardRpc, BoardWorkspace } from "../shell/types";
import type { createWebTransport } from "./transport";

export const WebContext = createContext<{ transport: ReturnType<typeof createWebTransport>; settings: boolean } | null>(null);

export const useRpc: BoardRpc = contract => {
  const context = useContext(WebContext);
  if (!context) throw new Error("Missing web board context");
  return useCallback(input => context.transport.rpc(contract, input, context.settings), [context, contract]);
};
export function useWorkspace<Selection>(_id: string, _selector: (workspace: BoardWorkspace) => Selection): Selection | null { return null; }
export function Icon({ name, ...props }: BoardIconProps) {
  const Component = (icons as unknown as Record<string, React.ComponentType<{ size?: number; color?: string }>>)[name];
  return Component ? <Component {...props} /> : null;
}
export type * from "../shell/types";
