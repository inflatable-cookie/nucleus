/**
 * The BB board shell and host (Spec 062, decision 5c).
 *
 * The shared board (`client/`) reaches its host only through `BoardShell` and
 * `BoardHost`. This file is BB's implementation of both, and the only board module
 * that knows BB's SDK shapes:
 *
 * - every catalogue call goes through the plugin's one forwarding method
 *   (`boardCall`, `hosts/bb/plugin/board-bridge.ts`), validated against the shared
 *   contract on both sides of the wire, so the board's reads and writes reach the
 *   service exactly as the Paseo bridge sends them;
 * - composer pills register into a store that the plugin's static composer
 *   customization draws per thread (BB's composer slots are declared once, not per
 *   thread), and the pill's popover renders in BB's composer popup;
 * - the agent inventory the shared pill modules observe is the set of BB threads
 *   Nucleus records (task role threads and each project's planner and named
 *   agents), with a thread's pending native questions read through the service
 *   catalogue (`question.native-list`) and answered through it
 *   (`question.native-answer`) — the plugin never writes a BB interaction itself.
 *
 * The SDK is injected (`BbBoardSdk`), so the plugin entry passes BB's real module
 * and tests pass a fake with the same shapes.
 */
import React, { useCallback, type ComponentType, type CSSProperties } from "react";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { RpcContract } from "../../../shared/rpc";
import type { BoardAgentRecord, BoardAgents, BoardHost, BoardPill, BoardPillRegistration, BoardShell, BoardTheme } from "../../../client/shell/types";
import * as api from "../../../shared/contracts";
import { isUnchangedBoard, type UiBoard } from "../../../shared/contracts";
import { formatAgentId } from "../../../shared/agent-identity";
import { hintSettingsSection } from "../../../client/settings-hint";
import { BOARD_PANEL_PATH, SETTINGS_SEGMENT } from "./model";

/** The plugin's forwarding method, as `useRpc()` exposes it (`boardContract` in the plugin). */
export interface BbRpcClient {
  call(method: "boardCall", input: { method: string; input: unknown }): Promise<unknown>;
}

export interface BbNavigate {
  toPluginPanel(path: string, options?: { subPath?: string; replace?: boolean }): void;
  toThread(threadId: string, options?: { split?: boolean }): void;
}

export interface BbComposer {
  scope: { kind: "thread"; threadId: string } | { kind: "queued-message"; threadId: string } | { kind: "new-thread"; projectId: string | null };
  experimental_openPopup(popupId: string): boolean;
  experimental_closePopup(): boolean;
}

/** The part of `@get-bb/plugin-sdk/app` the board uses; the plugin entry passes the real module. */
export interface BbBoardSdk {
  useRpc(): BbRpcClient;
  useRealtime(channel: string, handler: (payload: unknown) => void): void;
  useBbNavigate(): BbNavigate;
  useComposer(): BbComposer;
  experimental_Icon: ComponentType<{ name: string; fallback?: string; style?: CSSProperties; "aria-hidden"?: boolean }>;
}

/**
 * BB's theme tokens. They are CSS variables, so the board follows BB's light and
 * dark themes without a theme read of its own; react-native-web passes `var()`
 * colours through unchanged.
 */
export const BB_THEME: BoardTheme = {
  colors: {
    surface0: "var(--background)",
    surface1: "var(--sidebar)",
    surface2: "var(--secondary)",
    border: "var(--border)",
    foreground: "var(--foreground)",
    foregroundMuted: "var(--muted-foreground)",
    accent: "var(--primary)",
    accentForeground: "var(--primary-foreground)",
    statusSuccess: "var(--success)",
    statusWarning: "var(--warning)",
    statusDanger: "var(--destructive)",
  },
};

/** One catalogue call through the plugin: input validated here, output validated on arrival. */
export async function callCatalogue<Input extends ZodType, Output extends ZodType>(rpc: BbRpcClient, contract: RpcContract<Input, Output>, input: ZodInput<Input>): Promise<ZodOutput<Output>> {
  const validated = await contract.input.parseAsync(input);
  const raw = await rpc.call("boardCall", { method: contract.name, input: validated ?? null });
  return await contract.output.parseAsync(raw) as ZodOutput<Output>;
}

/** The board's host hooks, bound to BB. BB has no workspace snapshot, so `useWorkspace` reads nothing. */
export function createBbShell(sdk: BbBoardSdk): BoardShell {
  return {
    useRpc: <Input extends ZodType, Output extends ZodType>(contract: RpcContract<Input, Output>) => {
      const rpc = sdk.useRpc();
      return useCallback((input: ZodInput<Input>) => callCatalogue(rpc, contract, input), [rpc, contract]);
    },
    useWorkspace: () => null,
    Icon: ({ name, size = 16, color }) => React.createElement(sdk.experimental_Icon, { name, fallback: "Circle", "aria-hidden": true, style: { width: size, height: size, color } }),
  };
}

/** One registered pill: the thread it shows on and the board's own button. */
export interface PillEntry {
  id: string;
  workspaceId: string;
  agentId: string;
  button: BoardPill;
}

/**
 * The composer pills, as one store the composer customization reads. A pill is a
 * view: registering, updating and removing it changes only this store.
 */
export function createPillStore() {
  let pills: ReadonlyMap<string, PillEntry> = new Map();
  let open: PillEntry | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const put = (entry: PillEntry | null, id: string) => {
    const next = new Map(pills);
    if (entry) next.set(id, entry); else next.delete(id);
    pills = next;
    if (open?.id === id) open = entry;
    emit();
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => pills,
    openPill: () => open,
    forThread: (threadId: string) => [...pills.values()].filter(pill => pill.agentId === threadId),
    setOpen(id: string | null) { open = id ? pills.get(id) ?? null : null; emit(); },
    add(contribution: { id: string; workspaceId: string; agentId: string; button: BoardPill }): BoardPillRegistration {
      const id = contribution.id;
      put({ ...contribution }, id);
      let removed = false;
      return {
        update(patch) {
          if (removed) return;
          const current = pills.get(id);
          if (current) put({ ...current, button: { ...current.button, ...patch } }, id);
        },
        remove() {
          if (removed) return;
          removed = true;
          put(null, id);
        },
      };
    },
  };
}

export type PillStore = ReturnType<typeof createPillStore>;

type Call = <Input extends ZodType, Output extends ZodType>(contract: RpcContract<Input, Output>, input: ZodInput<Input>) => Promise<ZodOutput<Output>>;

/** A native question in the shape the shared pill module reads (`client/native-questions.tsx`). */
function pendingQuestions(requests: Array<{ requestId: string; questions: Array<{ header: string; question: string; options: string[] }> }>) {
  return requests.map(request => ({
    kind: "question",
    id: request.requestId,
    input: { questions: request.questions.map(question => ({ header: question.header, question: question.question, options: question.options.map(label => ({ label })) })) },
  }));
}

/** The project threads' pill key: an opaque id the composer never shows. */
const projectWorkspace = (key: string) => `nucleus-project-${key}`;

/**
 * The agent inventory the shared pill modules observe: the BB threads Nucleus
 * records, read from the sidebar's one projection, and the questions the board
 * snapshot says each one is waiting on. A thread with no question carries an
 * explicit empty list, so its question pill clears.
 */
export function createBbAgents(call: Call): BoardAgents {
  let board: Exclude<UiBoard, { unchanged: true }> | undefined;
  const owners = new Map<string, { taskId: string; agentRef: string }>();
  const readBoard = async () => {
    const answer = await call(api.uiSnapshot, board?.revision === undefined ? {} : { revision: board.revision });
    if (!isUnchangedBoard(answer)) board = answer as typeof board;
    return board;
  };
  const record = async (agentId: string, workspaceId: string): Promise<BoardAgentRecord> => {
    const owner = owners.get(agentId);
    if (!owner) return { id: agentId, workspaceId, pendingPermissions: [] };
    const requests = await call(api.nativeQuestionList, { taskId: owner.taskId, agentRef: owner.agentRef });
    return { id: agentId, workspaceId, pendingPermissions: pendingQuestions(requests) };
  };
  const inventory = async (): Promise<BoardAgentRecord[]> => {
    const [sidebar, current] = await Promise.all([call(api.bbSidebarGroups, null), readBoard()]);
    owners.clear();
    for (const task of current?.tasks ?? []) {
      const hostId = task.hostId ?? current?.hostId;
      if (!hostId?.startsWith("bb:")) continue;
      for (const id of task.questionAgentIds ?? []) owners.set(id, { taskId: task.id, agentRef: formatAgentId(hostId, id) });
    }
    const threads = new Map<string, string>();
    for (const thread of sidebar.threads) threads.set(thread.threadId, thread.environmentId);
    for (const project of sidebar.projects) for (const id of project.threadIds) if (!threads.has(id)) threads.set(id, projectWorkspace(project.key));
    return await Promise.all([...threads].map(([id, workspaceId]) => record(id, workspaceId)));
  };
  return {
    async list() {
      const agents = await inventory();
      return { entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false } };
    },
    ref(agentId) {
      return {
        async refresh() {
          const agent = (await inventory()).find(candidate => candidate.id === agentId);
          return agent ? { agent } : undefined;
        },
        async respondToPermission({ requestId, response }) {
          const owner = owners.get(agentId);
          if (!owner) throw new Error("The question's thread is no longer on the board");
          return await call(api.nativeQuestionAnswer, { taskId: owner.taskId, agentRef: owner.agentRef, requestId, answers: response.updatedInput.answers });
        },
      };
    },
  };
}

/**
 * The board host on one BB window: catalogue calls through the plugin, panel and
 * Settings navigation to the board's own routes, composer pills into the store, and
 * the recorded-thread inventory.
 */
export function createBbBoardHost({ rpc, navigate, pills }: { rpc: BbRpcClient; navigate: () => BbNavigate; pills: PillStore }): BoardHost {
  const call: Call = (contract, input) => callCatalogue(rpc, contract, input);
  const agents = createBbAgents(call);
  return {
    rpc: call,
    // Every board panel id opens the one board route; a workspace has no panel of its own in BB.
    openPanel: () => navigate().toPluginPanel(BOARD_PANEL_PATH),
    openSettings: (_id, options) => {
      if (options?.section) hintSettingsSection(options.section);
      navigate().toPluginPanel(BOARD_PANEL_PATH, { subPath: SETTINGS_SEGMENT });
    },
    addComposerPill: contribution => pills.add(contribution),
    agents,
  };
}
