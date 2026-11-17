/**
 * Nucleus's operator surfaces in BB (Spec 062, phase 6; decisions 5c–5d and 7).
 *
 * - the shared board in a `navPanel` in the left rail, with its attention badge;
 * - the same board per project at the panel's `project/<key>` sub-path and in a
 *   fixed thread tab on the project's planner and named-agent threads;
 * - the board's task detail in a fixed `Task` tab on a task's role threads;
 * - the board's Settings in a `settingsSection` (and at the panel's `settings`
 *   sub-path, which the board header's Settings button opens);
 * - decision and native-question composer pills, drawn by one static composer
 *   customization from the pills the shared modules register;
 * - the pending-interaction renderer for a Nucleus-raised blocking question;
 * - a "Project board" thread action on planner and named-agent rows.
 *
 * Usage is the board's own Usage view over `usage.state` (decision 5e): BB's card
 * and the operator's Usage Pace plugin cover glanceable usage, so this file adds
 * no usage surface of its own.
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Text, TextInput, View } from "react-native";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { bindBoardShell } from "../../../client/shell";
import type { BoardHost, BoardSurfaceProps } from "../../../client/shell/types";
import { MainSurface, registerSettingsOpener } from "../../../client/queue";
import { QueueSettingsScreen } from "../../../client/settings-screen";
import { TaskDetailPanel } from "../../../client/task/task-panel";
import { useBoardState, BOARD_STATE_KEY } from "../../../client/board-state";
import { registerDecisionPills } from "../../../client/decision-pill";
import { registerNativeQuestionPills } from "../../../client/native-questions";
import { hintSettingsSection } from "../../../client/settings-hint";
import { Button, muted, row } from "../../../client/controls";
import { radius, space, touchTarget, type as typeScale } from "../../../client/design";
import * as api from "../../../shared/contracts";
import { isUnchangedBoard, type BbSidebarGroups, type UiBoard } from "../../../shared/contracts";
import { BB_THEME, callCatalogue, createBbBoardHost, createBbShell, createPillStore, type BbBoardSdk, type BbRpcClient, type PillStore } from "./host";
import { BOARD_PANEL_ID, BOARD_PANEL_PATH, SETTINGS_SEGMENT, parseBoardSubPath, projectSubPath, railBadge, sidebarIndex, type RailBadge, type SidebarIndex } from "./model";

/** The realtime channel the plugin backend publishes a board revision change on. */
export const BOARD_SIGNAL_CHANNEL = "nucleus.board-signal";
export const PROJECT_TAB_ID = "nucleus-project-board";
export const TASK_TAB_ID = "nucleus-task";
export const SETTINGS_SECTION_ID = "nucleus-settings";
export const PILLS_ID = "nucleus-pills";
export const PILL_POPUP_ID = "nucleus-pill";
export const RUNTIME_OVERLAY_ID = "nucleus-runtime";
export const QUESTION_RENDERER_ID = "nucleus-question";
export const PROJECT_BOARD_ACTION_ID = "nucleus-project-board";

/** How often the shared reads behind the badge and the tabs refresh without a signal. */
const POLL_MS = 15_000;

/**
 * One shared, refcounted read. BB calls the badge hook and every tab's
 * `useVisible` in its own scope, so they share this store instead of each polling:
 * the first subscriber starts the read, the last one stops it, a board signal
 * refreshes it, and a value only changes identity when its content changes.
 */
export function createSharedRead<T>(intervalMs = POLL_MS) {
  let value: T | null = null;
  let serialized = "";
  let reader: (() => Promise<T>) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let reading = false;
  const listeners = new Set<() => void>();
  const refresh = async () => {
    if (!reader || reading) return;
    reading = true;
    try {
      const next = await reader();
      const text = JSON.stringify(next);
      if (text !== serialized) { serialized = text; value = next; for (const listener of listeners) listener(); }
    } catch {
      // A failed read keeps the last answer: a tab or badge never flickers on one fault.
    } finally { reading = false; }
  };
  return {
    bind(read: () => Promise<T>) { const first = !reader; reader = read; if (first && listeners.size) void refresh(); },
    refresh,
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        timer = setInterval(() => { void refresh(); }, intervalMs);
        (timer as { unref?: () => void }).unref?.();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
      };
    },
    reset() { value = null; serialized = ""; reader = null; if (timer) clearInterval(timer); timer = null; listeners.clear(); },
  };
}

export type SharedRead<T> = ReturnType<typeof createSharedRead<T>>;

/** The board snapshot's full projection, kept across revision acknowledgements. */
function snapshotReader(rpc: BbRpcClient) {
  let board: Exclude<UiBoard, { unchanged: true }> | undefined;
  return async () => {
    const answer = await callCatalogue(rpc, api.uiSnapshot, board?.revision === undefined ? {} : { revision: board.revision });
    if (!isUnchangedBoard(answer)) board = answer as typeof board;
    return board?.tasks ?? [];
  };
}

/** Everything the registered surfaces share on one BB window. `refreshMs` paces the pill modules (the board's own beat by default). */
export function createBoardRuntime(sdk: BbBoardSdk, options: { refreshMs?: number } = {}) {
  const queryClient = new QueryClient();
  const pills = createPillStore();
  const sidebar = createSharedRead<BbSidebarGroups>();
  const tasks = createSharedRead<api.TaskSummary[]>();

  function useSharedRead<T>(store: SharedRead<T>, read: (rpc: BbRpcClient) => () => Promise<T>, rpcKey?: { current: BbRpcClient | null }): T | null {
    const rpc = sdk.useRpc();
    if (!rpcKey || rpcKey.current !== rpc) { if (rpcKey) rpcKey.current = rpc; store.bind(read(rpc)); }
    sdk.useRealtime(BOARD_SIGNAL_CHANNEL, () => { void store.refresh(); });
    return useSyncExternalStore(store.subscribe, store.get, store.get);
  }
  const sidebarKey = { current: null as BbRpcClient | null };
  /** The sidebar's one read, indexed: which thread is whose (decision 5d). */
  function useSidebarIndex(): SidebarIndex {
    const read = useSharedRead(sidebar, rpc => () => callCatalogue(rpc, api.bbSidebarGroups, null), sidebarKey);
    return useMemo(() => sidebarIndex(read), [read]);
  }
  const tasksKey = { current: null as BbRpcClient | null };
  /** The rail badge (decision 5c): tasks that need the operator, draining as they settle. */
  function useRailBadge(): RailBadge | null {
    const read = useSharedRead(tasks, snapshotReader, tasksKey);
    return useMemo(() => railBadge(read ?? []), [read]);
  }

  /** Every surface's root: one query client, and a board signal refreshes the board read. */
  function Surface({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}><BoardSignal />{children}</QueryClientProvider>;
  }
  function BoardSignal() {
    const client = useQueryClient();
    sdk.useRealtime(BOARD_SIGNAL_CHANNEL, () => { void client.invalidateQueries({ queryKey: BOARD_STATE_KEY }); });
    return null;
  }
  const surfaceProps = (compact: boolean): BoardSurfaceProps => ({ theme: BB_THEME, layout: { compact } });

  /** The board's Settings button, wherever it is pressed, opens the panel's Settings route. */
  function useSettingsOpener() {
    const navigate = sdk.useBbNavigate();
    const latest = useRef(navigate);
    latest.current = navigate;
    useEffect(() => {
      registerSettingsOpener(section => {
        if (section) hintSettingsSection(section);
        latest.current.toPluginPanel(BOARD_PANEL_PATH, { subPath: SETTINGS_SEGMENT });
      });
    }, []);
  }

  /** The `navPanel` (decision 5c): the global board, a project's board, or Settings. */
  function BoardPanel({ subPath }: { subPath: string }) {
    useSettingsOpener();
    const route = parseBoardSubPath(subPath);
    return <Surface>
      {route.kind === "board" && <MainSurface {...surfaceProps(false)} />}
      {route.kind === "project" && <ProjectBoard projectKey={route.key} compact={false} />}
      {route.kind === "settings" && <QueueSettingsScreen {...surfaceProps(false)} />}
      {route.kind === "unknown" && <Notice text="This board link does not name a Nucleus board." />}
    </Surface>;
  }

  /**
   * One Nucleus project's board: the shared board preset to the project, so it
   * shows every repository the project lists (decision 5d: the key is the
   * Nucleus project key, never a BB project id).
   */
  function ProjectBoard({ projectKey, compact }: { projectKey: string; compact: boolean }) {
    const { state, stateQuery } = useBoardState();
    const project = state?.projects.find(candidate => candidate.key === projectKey);
    if (!state) return <Notice text={stateQuery.error ? "Nucleus could not read the board." : "Loading the board…"} />;
    if (!project) return <Notice text={`No Nucleus project is named ${projectKey}.`} />;
    return <MainSurface {...surfaceProps(compact)} workspaceBoard={{ key: project.key, name: project.name }} />;
  }

  /** The fixed per-project tab: the project board on its planner and named-agent threads. */
  function ProjectBoardTab({ threadId }: { threadId: string }) {
    useSettingsOpener();
    const project = useSidebarIndex().projectForThread(threadId);
    return <Surface>{project ? <ProjectBoard projectKey={project.key} compact /> : <Notice text="This thread is not a Nucleus project's planner or agent." />}</Surface>;
  }

  /** The fixed `Task` tab: the board's task detail on a task's role threads. */
  function TaskTab({ threadId }: { threadId: string }) {
    useSettingsOpener();
    const task = useSidebarIndex().taskForThread(threadId);
    return <Surface>{task ? <TaskDetailPanel {...surfaceProps(true)} taskId={task.taskId} /> : <Notice text="This thread is not a Nucleus task's thread." />}</Surface>;
  }

  /** The `settingsSection`: the board's own Settings screen. */
  function SettingsSection() {
    useSettingsOpener();
    return <Surface><View style={{ minHeight: 480 }}><QueueSettingsScreen {...surfaceProps(false)} /></View></Surface>;
  }

  /**
   * Mounted once per window (`experimental_appOverlay`): the board host, and the
   * shared decision and native-question pill modules running against it. Nothing
   * is drawn here; the pills draw in the composer.
   */
  function Runtime() {
    const rpc = sdk.useRpc();
    const navigate = sdk.useBbNavigate();
    const latest = useRef(navigate);
    latest.current = navigate;
    useEffect(() => {
      const host: BoardHost = createBbBoardHost({ rpc, navigate: () => latest.current, pills });
      const stopDecisions = registerDecisionPills(host, BOARD_PANEL_ID, options.refreshMs);
      const stopQuestions = registerNativeQuestionPills(host, options.refreshMs);
      return () => { stopQuestions(); stopDecisions(); };
    }, [rpc]);
    return null;
  }

  /** The composer action: this thread's pills, each opening its popover in BB's composer popup. */
  function ComposerPills() {
    const composer = sdk.useComposer();
    const threadId = composer.scope.kind === "new-thread" ? null : composer.scope.threadId;
    useSyncExternalStore(pills.subscribe, pills.snapshot, pills.snapshot);
    if (!threadId) return null;
    return <>{pills.forThread(threadId).map(pill => <button key={pill.id} type="button" data-nucleus-pill={pill.id} title={pill.button.title} aria-label={pill.button.title}
      className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:bg-secondary"
      onClick={() => { pills.setOpen(pill.id); composer.experimental_openPopup(PILL_POPUP_ID); }}>
      <sdk.experimental_Icon name={pill.button.icon} fallback="Circle" aria-hidden style={{ width: 14, height: 14 }} />
      <span>{pill.button.label}</span>
    </button>)}</>;
  }

  /** The popup a pill opens: the board's own popover content for that thread. */
  function PillPopup() {
    const composer = sdk.useComposer();
    const open = useSyncExternalStore(pills.subscribe, pills.openPill, pills.openPill);
    if (!open) return null;
    const Content = open.button.behavior.Content;
    const close = () => { pills.setOpen(null); composer.experimental_closePopup(); };
    return <div data-nucleus-pill-popup={open.id} style={{ width: 380, maxHeight: 440, overflowY: "auto", padding: 12 }}>
      <Content context="agent" workspaceId={open.workspaceId} agentId={open.agentId} theme={BB_THEME} close={close} />
    </div>;
  }

  return { queryClient, pills, sidebar, tasks, useSidebarIndex, useRailBadge, BoardPanel, ProjectBoardTab, TaskTab, SettingsSection, Runtime, ComposerPills, PillPopup };
}

export type BoardRuntime = ReturnType<typeof createBoardRuntime>;

function Notice({ text }: { text: string }) {
  const c = BB_THEME.colors;
  return <View accessibilityRole="text" accessibilityLabel="Nucleus board message" style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg, backgroundColor: c.surface0 }}>
    <Text style={{ ...muted(c), textAlign: "center" }}>{text}</Text>
  </View>;
}

/**
 * The payload a Nucleus-raised blocking question carries (`bb.ui.requestInput`
 * with renderer `nucleus-question`): the question, the options to choose from and
 * whether a typed answer is allowed. The submitted value is `{ answer }`.
 */
export const nucleusQuestionPayloadSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  options: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  allowText: z.boolean().default(true),
}).strict();

export interface PendingInteractionProps {
  interaction: { id: string; threadId: string; title: string; payload: unknown };
  submit(value: { answer: string }): Promise<void>;
  cancel(): Promise<void>;
}

/** The `pendingInteraction` renderer: one question, its options, an optional typed answer, Submit and Cancel. */
export function NucleusQuestionInteraction({ interaction, submit, cancel }: PendingInteractionProps) {
  const c = BB_THEME.colors;
  const parsed = nucleusQuestionPayloadSchema.safeParse(interaction.payload);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = (action: () => Promise<void>) => {
    setBusy(true); setError("");
    action().catch(failure => setError(failure instanceof Error ? failure.message : String(failure))).finally(() => setBusy(false));
  };
  if (!parsed.success) return <View style={{ gap: space.sm, padding: space.sm }}>
    <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>This question cannot be shown.</Text>
    <Button small c={c} text="Cancel" label="Cancel question" disabled={busy} onPress={() => run(cancel)} />
  </View>;
  const question = parsed.data;
  const chosen = answer.trim();
  return <View accessibilityLabel={`Question: ${question.question}`} style={{ gap: space.sm, padding: space.sm }}>
    <Text style={{ color: c.foreground, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight, fontWeight: "600" }}>{question.question}</Text>
    {question.options.length > 0 && <View style={{ ...row, flexWrap: "wrap", gap: space.xs }}>{question.options.map(option =>
      <Button key={option} small wrap c={c} text={option} label={`Answer ${option}`} selected={answer === option} disabled={busy} onPress={() => setAnswer(option)} />)}</View>}
    {question.allowText && <TextInput accessibilityLabel="Answer" value={answer} editable={!busy} onChangeText={setAnswer} multiline
      placeholder={question.options.length ? "Or type your answer" : "Your answer"} placeholderTextColor={c.foregroundMuted}
      style={{ color: c.foreground, backgroundColor: c.surface0, borderColor: c.border, borderWidth: 1, borderRadius: radius.control, padding: space.xs, minHeight: touchTarget, fontSize: typeScale.body.fontSize }} />}
    <View style={{ ...row, gap: space.xs }}>
      <Button small c={c} text={busy ? "Sending…" : "Submit"} label="Submit answer" disabled={busy || !chosen || (!question.allowText && !question.options.includes(chosen))} onPress={() => run(() => submit({ answer: chosen }))} />
      <Button small c={c} text="Cancel" label="Cancel question" disabled={busy} onPress={() => run(cancel)} />
    </View>
    {error !== "" && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{`Not sent: ${error}`}</Text>}
  </View>;
}

/** The registration surface of a BB plugin app (`definePluginApp`'s `app`), as the board uses it. */
export interface BbPluginApp {
  slots: {
    navPanel(registration: { id: string; title: string; icon: string; path: string; component: React.ComponentType<{ subPath: string }>; experimental_useBadge?: () => RailBadge | null }): void;
    experimental_tab(registration: { id: string; title: string; icon: string; context: { kind: "thread" }; availability: "fixed"; layout?: "flush" | "padded"; useVisible?(props: { threadId: string }): boolean; component: React.ComponentType<{ threadId: string }> }): void;
    settingsSection(registration: { id: string; title?: string; component: React.ComponentType }): void;
    pendingInteraction(registration: { id: string; component: React.ComponentType<PendingInteractionProps> }): void;
    experimental_appOverlay(registration: { id: string; component: React.ComponentType }): void;
    experimental_threadAction(registration: {
      id: string; title: string; icon: string; group: string; order?: number;
      useData?(input: { threadIds: readonly string[] }): SidebarIndex;
      item(input: { thread: { id: string }; data: SidebarIndex; navigate: { toPluginPanel(path: string, options?: { subPath?: string }): void } }): { label: string; icon: string; run(): void } | null;
    }): void;
  };
  composer: {
    customize(registration: { id: string; scopes?: readonly ("thread" | "queued-message" | "new-thread")[]; actions?: readonly { id: string; component: React.ComponentType }[]; experimental_popups?: readonly { id: string; label: string; component: React.ComponentType }[] }): void;
  };
}

/**
 * Register every phase-6 surface on the plugin app. The SDK module is passed in
 * (the plugin entry passes `@get-bb/plugin-sdk/app`), and the shared board is bound
 * to BB's shell before anything renders.
 */
export function registerNucleusBoard(app: BbPluginApp, sdk: BbBoardSdk): BoardRuntime {
  bindBoardShell(createBbShell(sdk));
  const runtime = createBoardRuntime(sdk);
  app.slots.navPanel({ id: BOARD_PANEL_ID, title: "Nucleus", icon: "LayoutDashboard", path: BOARD_PANEL_PATH, component: runtime.BoardPanel, experimental_useBadge: runtime.useRailBadge });
  app.slots.experimental_tab({
    id: PROJECT_TAB_ID, title: "Board", icon: "LayoutDashboard", context: { kind: "thread" }, availability: "fixed", layout: "flush",
    useVisible: ({ threadId }) => runtime.useSidebarIndex().projectForThread(threadId) !== null,
    component: runtime.ProjectBoardTab,
  });
  app.slots.experimental_tab({
    id: TASK_TAB_ID, title: "Task", icon: "ListTodo", context: { kind: "thread" }, availability: "fixed", layout: "flush",
    useVisible: ({ threadId }) => runtime.useSidebarIndex().taskForThread(threadId) !== null,
    component: runtime.TaskTab,
  });
  app.slots.settingsSection({ id: SETTINGS_SECTION_ID, title: "Nucleus", component: runtime.SettingsSection });
  app.slots.pendingInteraction({ id: QUESTION_RENDERER_ID, component: NucleusQuestionInteraction });
  app.slots.experimental_appOverlay({ id: RUNTIME_OVERLAY_ID, component: runtime.Runtime });
  app.slots.experimental_threadAction({
    id: PROJECT_BOARD_ACTION_ID, title: "Project board", icon: "LayoutDashboard", group: "1_open",
    useData: () => runtime.useSidebarIndex(),
    item: ({ thread, data, navigate }) => {
      const project = data?.projectForThread(thread.id) ?? null;
      return project ? { label: "Project board", icon: "LayoutDashboard", run: () => navigate.toPluginPanel(BOARD_PANEL_PATH, { subPath: projectSubPath(project.key) }) } : null;
    },
  });
  app.composer.customize({
    id: PILLS_ID, scopes: ["thread"],
    actions: [{ id: PILLS_ID, component: runtime.ComposerPills }],
    experimental_popups: [{ id: PILL_POPUP_ID, label: "Nucleus", component: runtime.PillPopup }],
  });
  return runtime;
}

export type { PillStore };
