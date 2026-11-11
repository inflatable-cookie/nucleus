import type { ComponentType } from "react";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { RpcContract } from "../../shared/rpc";
import type { SettingsTarget } from "../../shared/queue-navigation";

/*
 * The board's host shell. Components import these types and the hooks from
 * `./index.ts`, never a host package. The host client entry binds its hooks
 * before registering board surfaces; the web bundle supplies its own shell.
 */

/** The theme colours the board paints with. Hosts supply at least these. */
export interface BoardTheme {
  readonly colors: {
    readonly surface0: string;
    readonly surface1: string;
    readonly surface2: string;
    readonly border: string;
    readonly foreground: string;
    readonly foregroundMuted: string;
    readonly accent: string;
    readonly accentForeground: string;
    readonly statusSuccess: string;
    readonly statusWarning: string;
    readonly statusDanger: string;
  };
}

export interface BoardLayout {
  readonly compact: boolean;
}

/** Host navigation the board uses. Absent on hosts that have no such screens; hide the affordance then. */
export interface BoardNavigation {
  openAgent(input: { agentId: string }): void;
  openWorkspace(input: { workspaceId: string }): void;
}

/** Props every board surface (the main view and the settings screen) receives. */
export interface BoardSurfaceProps {
  readonly theme: BoardTheme;
  readonly layout: BoardLayout;
  readonly navigation?: BoardNavigation;
}

export type BoardWorkspacePanelProps = BoardSurfaceProps & { readonly context: "workspace"; readonly workspaceId: string };

export interface BoardIconProps {
  readonly name: string;
  readonly size?: number;
  readonly color?: string;
}

/** The workspace fields the board reads. A host's workspace snapshot carries these. */
export interface BoardWorkspace {
  readonly projectRootPath: string;
  readonly directory: string;
}

export type BoardRpc = <Input extends ZodType, Output extends ZodType>(
  contract: RpcContract<Input, Output>,
) => (input: ZodInput<Input>) => Promise<ZodOutput<Output>>;

/** Where a composer pill's popover opens: on a workspace or on one agent's thread. */
export type BoardPillContext = { readonly context: "workspace"; readonly workspaceId: string } | { readonly context: "agent"; readonly workspaceId: string; readonly agentId: string };

export type BoardPillContentProps = BoardPillContext & { readonly theme: BoardTheme; close(): void };

export interface BoardPill {
  readonly title: string;
  readonly label: string;
  readonly icon: string;
  readonly behavior: { readonly kind: "popover"; readonly Content: ComponentType<BoardPillContentProps> };
}

export interface BoardPillRegistration {
  /** Updates the pill's words in place. */
  update(patch: Partial<Pick<BoardPill, "title" | "label">>): void;
  /** Idempotent. */
  remove(): void;
}

/** One agent as the board reads it. A listing carries `pendingPermissions`; a refresh may not. */
export interface BoardAgentRecord {
  readonly id: string;
  readonly workspaceId?: string | null;
  readonly cwd?: string;
  readonly pendingPermissions?: unknown;
}

export type BoardAgentUpdate = { kind: "upsert"; agent: BoardAgentRecord } | { kind: "remove"; agentId: string };

export interface BoardAgentRef {
  refresh(): Promise<{ agent: BoardAgentRecord } | undefined>;
  respondToPermission(input: { requestId: string; response: { behavior: "allow"; updatedInput: { answers: Record<string, string> } } }): Promise<unknown>;
}

export interface BoardAgentListing {
  entries: Array<{ agent: BoardAgentRecord }>;
  pageInfo: { hasMore: boolean; nextCursor?: string | null };
  subscription?: {
    release?(): unknown;
    subscribe?(handlers: {
      snapshot(snapshot: { entries: Array<{ agent: BoardAgentRecord }> }): void;
      update(message: { type: string; payload: BoardAgentUpdate }): void;
    }): unknown;
  };
}

/**
 * The host's agent inventory, in the call shapes the board uses. Paseo 0.12 hands
 * `list({ subscribe })` a subscription that delivers a snapshot of existing agents,
 * then `agent_update` messages, and a fresh snapshot after a reconnect. The older
 * `subscribe` feed is optional; read whichever the host provides.
 */
export interface BoardAgents {
  subscribe?(handler: (update: BoardAgentUpdate) => void): () => void;
  list(options: { subscribe?: Record<string, never>; page?: { limit: number; cursor?: string }; signal?: AbortSignal }): Promise<BoardAgentListing>;
  ref(agentId: string): BoardAgentRef;
}

/** Everything a board feature needs from the host, bound to one plugin installation. */
export interface BoardHost {
  rpc<Input extends ZodType, Output extends ZodType>(contract: RpcContract<Input, Output>, input: ZodInput<Input>): Promise<ZodOutput<Output>>;
  openPanel(id: string, options: { workspaceId: string; agentId?: string }): void;
  /** Opens a settings screen; `section` asks it to show that section (the hint lives in `client/settings-hint.ts`). */
  openSettings(id: string, options?: { section?: SettingsTarget }): void;
  addComposerPill(contribution: { id: string; workspaceId: string; agentId: string; button: BoardPill }): BoardPillRegistration;
  agents: BoardAgents;
}

/** The hooks and the icon the components render with. */
export interface BoardShell {
  useRpc: BoardRpc;
  useWorkspace<Selection>(workspaceId: string, selector: (workspace: BoardWorkspace) => Selection): Selection | null;
  Icon: ComponentType<BoardIconProps>;
}
