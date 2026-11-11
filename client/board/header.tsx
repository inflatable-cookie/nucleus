import React, { useState, useEffect, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as api from "../../shared/contracts";
import type { UiQueueState } from "../../shared/contracts";
import { headerControls, type SettingsTarget } from "../../shared/queue-navigation";
import { serviceNotices } from "../../shared/service-roll";
import { useRpc, Icon } from "../shell";
import { ActionButton, Button, muted, row, type Colors } from "../controls";
import { errorText } from "../error-text";
import { QaFenceNotice } from "../qa-fence-notice";
import type { BoardAct } from "./use-board-data";

/**
 * Queue #665: the header's slot popover lists only projects with at least one
 * slot occupied, most-used first, then name. Visibility is by slots in use
 * only: a project with tasks in flight and no live agent does not appear. The
 * filter copies the array, so sorting never mutates the board projection and a
 * refresh keeps a deterministic order unless counts change.
 */
function slotPopoverRows(capacities: UiQueueState["projectCapacities"] | undefined) {
  return (capacities ?? []).filter(project => project.occupiedSlots > 0)
    .sort((a, b) => b.occupiedSlots - a.occupiedSlots || (a.projectName < b.projectName ? -1 : a.projectName > b.projectName ? 1 : 0));
}

export type BoardHeaderProps = {
  c: Colors;
  /** The workspace board's project name; the main surface passes none. */
  workspaceName?: string;
  state: UiQueueState | undefined;
  refetchState: () => Promise<unknown>;
  busy: boolean;
  act: BoardAct;
  /** The last control's failure, which the operator can dismiss. */
  error: string;
  onDismissError: () => void;
  /** The first failed board read, shown when no control failed. */
  readError: unknown;
  staleRead: readonly [string, unknown] | null;
  inset: number;
  settingsOpener: ((section?: SettingsTarget) => void) | null;
  /** The navigation row: tabs and the project selector. */
  navigation: React.ReactNode;
  /** The surface below the header. */
  children: React.ReactNode;
};

/**
 * The board header: title, run summary with the slot popover, service and QA
 * fence notices, queue controls, errors and the navigation row. It owns the
 * queue-menu and slot-popover state, so opening either re-renders the header
 * alone. The body renders between the header and the outside-press layers,
 * which cover the whole surface.
 */
export function BoardHeader({ c, workspaceName, state, refetchState, busy, act, error, onDismissError, readError, staleRead, inset, settingsOpener, navigation, children }: BoardHeaderProps) {
  const workspacePanel = workspaceName !== undefined;
  const setQueue = useRpc(api.queueControl);
  const stopThreadsRpc = useRpc(api.stopThreads);
  const refresh = useRpc(api.refreshCatalog);
  const writeQaFence = useRpc(api.projectQaFence);
  const fetchServiceState = useRpc(api.serviceState);
  const [queueMenuOpen, setQueueMenuOpen] = useState(false);
  // Queue #665: the header's slot count opens the per-project popover. The flag
  // lives in the header, so a live board refresh never closes it.
  const [slotsOpen, setSlotsOpen] = useState(false);
  // Queue #665: Escape closes the slot popover on hosts with a DOM. The
  // anchored dropdown has no Modal onRequestClose to lean on; guarded like
  // localStore in project-scope-controls, so native hosts skip it.
  useEffect(() => {
    if (!slotsOpen && !queueMenuOpen) return;
    const documentHost = (globalThis as { document?: { addEventListener: (type: string, listener: (event: { key?: string }) => void) => void; removeEventListener: (type: string, listener: (event: { key?: string }) => void) => void } }).document;
    if (!documentHost) return;
    const onKey = (event: { key?: string }) => { if (event?.key === "Escape") { setSlotsOpen(false); setQueueMenuOpen(false); } };
    documentHost.addEventListener("keydown", onKey);
    return () => documentHost.removeEventListener("keydown", onKey);
  }, [slotsOpen, queueMenuOpen]);
  const overrideCount = Object.keys(state?.projectLimitOverrides ?? {}).length;
  const slotRows = useMemo(() => slotPopoverRows(state?.projectCapacities), [state?.projectCapacities]);
  const serviceStateQuery = useQuery({ queryKey: ["nucleus", "service-state"], queryFn: () => fetchServiceState({}), refetchInterval: 15_000, retry: false });
  const qaFence = state?.qaFence.fence ?? null;
  return <>
      <View
        style={{
          paddingTop: inset,
          paddingHorizontal: inset,
          paddingBottom: 20,
          gap: 20,
          position: "relative",
          // Queue #665 / #706: no zIndex here, so this block is not a stacking
          // context. The title+controls row raises to 50 while a header menu is
          // open, stacking above the nav row (20) and the outside-press layer
          // (40). The layer still covers the nav row and the board. Slot and
          // pause wrappers keep zIndex 50 inside that raised row.
        }}
      >
        <View style={{ ...row, justifyContent: "space-between", ...(queueMenuOpen || slotsOpen ? { zIndex: 50 } : {}) }}>
          <View style={{ gap: 5, flexShrink: 1 }}>
            <Text
              accessibilityRole="header"
              style={{ color: c.foreground, fontSize: 24, fontWeight: "600" }}
            >
              {workspacePanel
                ? `Nucleus board · ${workspaceName}`
                : "Nucleus"}
            </Text>
            {/* Queue #665: the summary keeps its line; the slot count above is the
              trigger. The panel is an anchored dropdown in the ProjectFilter /
              SelectFilter pattern (relative wrapper, absolute panel, the same
              surface and shadow tokens), never a Modal. */}
            <View style={{ position: "relative", zIndex: slotsOpen ? 50 : 0 }}>
            <Text style={muted(c)}>
              {state?.connected
                ? state.paused
                  ? state.quiet
                    ? `Paused · managed threads are idle${state.stoppedThreads ? ` · ${state.stoppedThreads} stopped` : ""}`
                    : `Draining · ${state.activeWorkers} active · ${state.unsettled} unconfirmed${state.stoppedThreads ? ` · ${state.stoppedThreads} stopped` : ""}`
                  : state.stoppedThreads || state.resumedThreads
                    ? [`Running`, state.resumedThreads ? `${state.resumedThreads} resumed` : "", state.stoppedThreads ? `${state.stoppedThreads} waiting to resume` : ""].filter(Boolean).join(" · ")
                    : workspacePanel
                      ? `Running · ${state.occupiedSlots ?? 0}/${state.globalLimit} global slots · project default ${state.projectLimit}${overrideCount ? ` · ${overrideCount} override${overrideCount === 1 ? "" : "s"}` : ""}`
                      : <>{`Running · `}<Text accessibilityRole="button" accessibilityLabel={`Project slot usage (${state.occupiedSlots ?? 0}/${state.globalLimit} in use): ${slotsOpen ? "hide" : "show"} projects using slots`} accessibilityState={{ expanded: slotsOpen }} onPress={() => { setSlotsOpen(!slotsOpen); setQueueMenuOpen(false); }} style={{ color: c.accent, fontWeight: "600" }}>{`${state.occupiedSlots ?? 0}/${state.globalLimit} global slots`}</Text>{` · project default ${state.projectLimit}${overrideCount ? ` · ${overrideCount} override${overrideCount === 1 ? "" : "s"}` : ""}`}</>
                : "Connecting to the queue backend…"}
              {state?.dispatchHeld && <>{" · Dispatch held · "}<Text accessibilityRole="button" accessibilityLabel="Release dispatch hold" accessibilityState={{ disabled: busy || !state.connected }}
                style={{ color: busy || !state.connected ? c.foregroundMuted : c.accent }}
                onPress={() => { if (!busy && state.connected) void act(() => setQueue({ dispatchHeld: false })); }}>Release</Text></>}
              {state?.operationBacklog
                ? ` · ${state.operationBacklog} operation${state.operationBacklog === 1 ? "" : "s"} queued`
                : ""}
            </Text>
            {/* Queue #665: per-project counts live in the anchored dropdown, never inline. */}
            {!workspacePanel && slotsOpen && state && <ScrollView accessibilityRole="menu" accessibilityLabel="Projects using slots" nestedScrollEnabled
              contentContainerStyle={{ gap: 8 }}
              style={{ position: "absolute", top: 24, left: 0, width: 380, maxWidth: "92%", maxHeight: 320, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 9, backgroundColor: c.surface1,
                shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.38, shadowRadius: 14, elevation: 12 }}>
              <Text accessibilityRole="header" style={{ color: c.foreground, fontWeight: "600", fontSize: 13 }}>Projects using slots</Text>
              {slotRows.length === 0
                ? <Text style={{ ...muted(c), fontSize: 12 }}>No project is using a slot.</Text>
                : slotRows.map(project => <View key={project.projectKey} accessibilityLabel={`${project.projectName}, ${project.occupiedSlots} of ${project.slotLimit} slots, ${project.inFlightTasks} of ${project.inFlightLimit} in flight`} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, flex: 1 }}>{project.projectName}</Text>
                  <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, fontFamily: "monospace", minWidth: 84, textAlign: "right" }}>{`${project.occupiedSlots}/${project.slotLimit} slots`}</Text>
                  <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, fontFamily: "monospace", minWidth: 104, textAlign: "right" }}>{`${project.inFlightTasks}/${project.inFlightLimit} in flight`}</Text>
                </View>)}
            </ScrollView>}
            </View>
            {!workspacePanel &&
              serviceStateQuery.data &&
              serviceNotices(serviceStateQuery.data).map((notice) =>
                notice.tone === "warning" ? (
                  <Text
                    key={notice.text}
                    accessibilityRole="alert"
                    style={{ color: c.statusWarning, fontSize: 12 }}
                  >
                    {notice.text}
                  </Text>
                ) : (
                  <Text key={notice.text} style={{ ...muted(c), fontSize: 12 }}>
                    {notice.text}
                  </Text>
                ),
              )}
            {!workspacePanel && state && qaFence && (
              <QaFenceNotice
                fence={qaFence}
                busy={busy}
                c={c}
                onClear={() =>
                  void act(async () => {
                    await writeQaFence({
                      action: "clear",
                      expectedRevision: state.qaFence.revision,
                      caller: "operator (board)",
                    });
                    await refetchState();
                  })
                }
              />
            )}
          </View>
          {!workspacePanel && (
            <View accessibilityLabel="Nucleus header controls" style={row}>
              {headerControls(
                Boolean(state?.paused),
                Boolean(state?.connected),
                busy,
              ).map((control) => control.id === "pause" ? (
                <View key={control.id} style={{ position: "relative", zIndex: queueMenuOpen ? 50 : 0 }}>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <Button small iconOnly joined="start" c={c} icon={control.icon} text={control.label} disabled={control.disabled}
                      onPress={() => { setQueueMenuOpen(false); if (state) void act(() => setQueue({ paused: !state.paused })); }} />
                    <Pressable accessibilityRole="button" accessibilityLabel="Queue controls menu" accessibilityState={{ expanded: queueMenuOpen, disabled: control.disabled }} disabled={control.disabled}
                      onPress={() => { setQueueMenuOpen(!queueMenuOpen); setSlotsOpen(false); }}
                      style={{ minHeight: 36, minWidth: 28, alignItems: "center", justifyContent: "center", paddingHorizontal: 4, backgroundColor: c.surface2,
                        borderTopRightRadius: 7, borderBottomRightRadius: 7, borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
                        borderLeftWidth: 1, borderLeftColor: c.border, opacity: control.disabled ? 0.45 : 1 }}>
                      <Icon name={queueMenuOpen ? "ChevronUp" : "ChevronDown"} size={16} color={c.foreground} />
                    </Pressable>
                  </View>
                  {queueMenuOpen && <View accessibilityRole="menu" accessibilityLabel="Queue controls" style={{ position: "absolute", top: 38, right: 0, width: 260, borderWidth: 1, borderColor: c.border, borderRadius: 7, backgroundColor: c.surface1,
                    shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.38, shadowRadius: 14, elevation: 12 }}>
                    {state && <View accessibilityRole="text" accessibilityLabel={state.drained ? "Drained" : `${state.boundRuns.length} bound run${state.boundRuns.length === 1 ? "" : "s"}`} style={{ paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border, gap: 4 }}>
                      <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>{state.drained ? "Drained" : `${state.boundRuns.length} bound run${state.boundRuns.length === 1 ? "" : "s"}`}</Text>
                      {!state.drained && state.boundRuns.slice(0, 8).map(run =>
                        <Text key={run.runId} numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>{`${run.reference ?? run.taskId} · ${run.role}`}</Text>)}
                    </View>}
                    {([
                      { key: "pause", icon: control.icon, label: state?.paused ? "Resume" : "Pause", run: () => { if (state) void act(() => setQueue({ paused: !state.paused })); } },
                      { key: "hold", icon: "Pause", label: state?.dispatchHeld ? "Release dispatch hold" : "Dispatch hold", run: () => { if (state) void act(() => setQueue({ dispatchHeld: !state.dispatchHeld })); } },
                      { key: "stop", icon: "Square", label: "Stop", run: () => void act(async () => {
                        await setQueue({ paused: true });
                        await stopThreadsRpc({ caller: "operator (board)" });
                        await refetchState();
                      }) },
                    ] as const).map(item => <Pressable key={item.key} accessibilityRole="menuitem" accessibilityLabel={item.label} accessibilityState={{ disabled: control.disabled }} disabled={control.disabled}
                      onPress={() => { setQueueMenuOpen(false); item.run(); }}
                      style={{ minHeight: 34, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: c.surface1 }}>
                      <Icon name={item.icon} size={14} color={c.foreground} />
                      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13 }}>{item.label}</Text>
                    </Pressable>)}
                  </View>}
                </View>
              ) : (
                <Button key={control.id} small iconOnly c={c} icon={control.icon} text={control.label}
                  disabled={control.disabled}
                  onPress={() => {
                    setQueueMenuOpen(false);
                    setSlotsOpen(false);
                    if (control.id === "settings") settingsOpener?.();
                    else if (control.id === "refresh") void act(() => refresh({}));
                  }} />
              ))}

            </View>
          )}
        </View>
        {state?.paused && (
          <Text style={muted(c)}>
            Submissions are stored. No new run starts. In-flight work drains.
            Idle status covers this plugin’s managed runs only.
          </Text>
        )}
        {Boolean(error || readError) && (
          <View style={{ ...row, flexWrap: "nowrap" }}>
            <Text
              accessibilityRole="alert"
              style={{ color: c.statusDanger, flex: 1 }}
            >
              {error || String(readError)}
            </Text>
            {error && (
              <ActionButton c={c} action="close" label="Dismiss error" onPress={onDismissError} />
            )}
          </View>
        )}
        {staleRead && (
          <Text accessibilityRole="alert" style={{ color: c.statusWarning }}>
            {`${staleRead[0]} not refreshed: ${errorText(staleRead[1])}. Showing the last loaded list.`}
          </Text>
        )}
        {navigation}
      </View>
      {children}
      {/* Queue #665 / #706: an outside click closes the open header menu. The
        layer sits above the nav row (zIndex 20) and the board (zIndex 40) and
        below the raised title+controls row (zIndex 50), so a press on the
        project filter or the board dismisses while the menu keeps its presses.
        Other header icons live in that raised row, so they close the menu in
        their own onPress. Follows RecordModal's outside-press layer without a
        Modal. */}
      {!workspacePanel && queueMenuOpen && <Pressable accessibilityRole="button" accessibilityLabel="Close queue controls" onPress={() => setQueueMenuOpen(false)} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 40 }} />}
      {!workspacePanel && slotsOpen && <Pressable accessibilityRole="button" accessibilityLabel="Close project slot usage" onPress={() => setSlotsOpen(false)} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 40 }} />}
  </>;
}
