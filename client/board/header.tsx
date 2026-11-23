import React, { useState, useEffect, useMemo, useRef } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as api from "../../shared/contracts";
import type { UiQueueState } from "../../shared/contracts";
import { headerControls, type SettingsTarget } from "../../shared/queue-navigation";
import { serviceNotices, type ServiceNotice } from "../../shared/service-roll";
import { useRpc, Icon } from "../shell";
import { ActionButton, Button, SurfacePress, muted, popover, row, type Colors } from "../controls";
import { errorText } from "../error-text";
import { Popover } from "../popover";
import { Badge } from "./badges";
import type { BoardAct } from "./use-board-data";
import { control as controlSize, space, type as typeScale, radius, overlay, roles } from "../design";

/**
 * Queue #665: the slot table lists only projects with at least one slot occupied,
 * most-used first, then name. Visibility is by slots in use only: a project with
 * tasks in flight and no live agent does not appear. The filter copies the array,
 * so sorting never mutates the board projection and a refresh keeps a
 * deterministic order unless counts change.
 */
export function slotPopoverRows(capacities: UiQueueState["projectCapacities"] | undefined) {
  return (capacities ?? []).filter(project => project.occupiedSlots > 0)
    .sort((a, b) => b.occupiedSlots - a.occupiedSlots || (a.projectName < b.projectName ? -1 : a.projectName > b.projectName ? 1 : 0));
}

/**
 * The run state the header shows (Tom, 2026-11-21: the status line left the
 * header). A normal running queue shows nothing; only a state the operator
 * should notice gets a pill. Slot usage lives in the queue menu.
 *
 * A resumed thread is not one of them (nucleus#1511): the count survives a
 * restart with nothing left to act on, so it never earns a pill. Stopped
 * threads still do.
 */
export function headerStatePills(state: UiQueueState | undefined): Array<{ label: string; tone: "warning" | "neutral" }> {
  if (!state) return [];
  if (!state.connected) return [{ label: "Connecting to the queue backend…", tone: "neutral" }];
  const pills: Array<{ label: string; tone: "warning" | "neutral" }> = [];
  if (state.paused)
    pills.push({ label: state.quiet ? "Paused · managed threads are idle" : `Draining · ${state.activeWorkers} active · ${state.unsettled} unconfirmed`, tone: "warning" });
  if (state.dispatchHeld) pills.push({ label: "Dispatch held", tone: "warning" });
  if (state.stoppedThreads) pills.push({ label: state.paused ? `${state.stoppedThreads} stopped` : `${state.stoppedThreads} waiting to resume`, tone: "warning" });
  if (state.operationBacklog) pills.push({ label: `${state.operationBacklog} operation${state.operationBacklog === 1 ? "" : "s"} queued`, tone: "neutral" });
  return pills;
}

/**
 * A service state as a header pill (nucleus#1540): the short label in the pill and
 * the full detail in its popover on hover, keyboard focus or press. The header has
 * no status line under the title.
 */
export function NoticePill({ notice, c }: { notice: ServiceNotice; c: Colors }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  return <Pressable ref={anchor} accessibilityRole="button" accessibilityLabel={notice.label} accessibilityHint={notice.text}
    accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
    onHoverIn={() => setOpen(true)} onHoverOut={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
    <Badge label={notice.label} tone={notice.tone === "warning" ? "warning" : "neutral"} c={c} />
    {open && <Popover anchor={anchor} align="start" pointerEvents="none" maxWidth={420} inlineStyle={{ top: "100%", left: 0, marginTop: space.xxs, maxWidth: 420 }}>
      <View pointerEvents="none" accessibilityLabel={`${notice.label} detail`} style={{ paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.control, ...popover(c) }}>
        <Text style={{ color: notice.tone === "warning" ? c.statusWarning : c.foreground, fontSize: typeScale.metadata.fontSize, lineHeight: typeScale.metadata.lineHeight }}>{notice.text}</Text>
      </View>
    </Popover>}
  </Pressable>;
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
  /** The first failed board read in plain words, shown when no control failed. */
  readError: string | null;
  staleRead: readonly [string, unknown] | null;
  inset: number;
  settingsOpener: ((section?: SettingsTarget) => void) | null;
  /** The project filter, to the left of the header controls. */
  filter: React.ReactNode;
  /** Opens the menu drawer on a narrow board; absent when the menu is always shown. */
  onMenu?: () => void;
  /** The surface below the header. */
  children: React.ReactNode;
};

/**
 * The board header: one row with the title, any run-state pills, the project
 * filter and the queue controls, then the service and QA fence notices and errors
 * when there are any. It owns the queue menu's state, so opening it re-renders
 * the header alone. The body renders between the header and the outside-press
 * layer, which covers the whole surface.
 */
export function BoardHeader({ c, workspaceName, state, refetchState, busy, act, error, onDismissError, readError, staleRead, inset, settingsOpener, filter, onMenu, children }: BoardHeaderProps) {
  const workspacePanel = workspaceName !== undefined;
  const { height: viewportHeight } = useWindowDimensions();
  const setQueue = useRpc(api.queueControl);
  const stopThreadsRpc = useRpc(api.stopThreads);
  const refresh = useRpc(api.refreshCatalog);
  const fetchServiceState = useRpc(api.serviceState);
  const [queueMenuOpen, setQueueMenuOpen] = useState(false);
  // Queue #1391: the queue menu's anchor. Its panel renders in the shell's
  // popover layer, positioned from the anchor's window coordinates.
  const queueAnchor = useRef<View | null>(null), queueMenu = useRef<View | null>(null);
  // Queue #665: Escape closes the queue menu on hosts with a DOM. The anchored
  // dropdown has no Modal onRequestClose to lean on; native hosts skip it.
  useEffect(() => {
    if (!queueMenuOpen) return;
    const documentHost = (globalThis as { document?: { addEventListener: (type: string, listener: (event: { key?: string }) => void) => void; removeEventListener: (type: string, listener: (event: { key?: string }) => void) => void } }).document;
    if (!documentHost) return;
    const onKey = (event: { key?: string }) => { if (event?.key === "Escape") setQueueMenuOpen(false); };
    documentHost.addEventListener("keydown", onKey);
    return () => documentHost.removeEventListener("keydown", onKey);
  }, [queueMenuOpen]);
  const overrideCount = Object.keys(state?.projectLimitOverrides ?? {}).length;
  const slotRows = useMemo(() => slotPopoverRows(state?.projectCapacities), [state?.projectCapacities]);
  const serviceStateQuery = useQuery({ queryKey: ["nucleus", "service-state"], queryFn: () => fetchServiceState({}), refetchInterval: 15_000, retry: false });
  const pills = headerStatePills(state);
  const notices = !workspacePanel && serviceStateQuery.data ? serviceNotices(serviceStateQuery.data) : [];
  const meta = { fontSize: typeScale.metadata.fontSize, lineHeight: typeScale.metadata.lineHeight } as const;
  const hasAlerts = Boolean(error || readError) || Boolean(staleRead);
  return <>
      <View
        style={{
          paddingHorizontal: inset,
          paddingVertical: space.sm,
          gap: space.xs,
          backgroundColor: roles(c).header,
          position: "relative",
          // Queue #665 / #706: no zIndex here, so this block is not a stacking
          // context. The open queue menu renders in the shell's popover layer,
          // above the list and detail panes. The row keeps zIndex 50 while the
          // menu is open, so the outside-press layer (40) covers the board while
          // the menu keeps its presses.
        }}
      >
        <View style={{ ...row, flexWrap: "nowrap", justifyContent: "space-between", ...(queueMenuOpen ? { zIndex: 50 } : {}) }}>
          <View style={{ ...row, flexWrap: "nowrap", gap: space.sm, flexShrink: 1, minWidth: 0 }}>
            {onMenu && <Button small iconOnly c={c} icon="Menu" text="Menu" label="Open the board menu" onPress={onMenu} />}
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              style={{ color: c.foreground, fontSize: typeScale.page.fontSize, lineHeight: typeScale.page.lineHeight, fontWeight: "600", flexShrink: 0 }}
            >
              {workspacePanel ? `Nucleus board · ${workspaceName}` : "Nucleus"}
            </Text>
            {(pills.length > 0 || notices.length > 0) && <View accessibilityLabel="Queue state" style={{ ...row, gap: space.xs, flexShrink: 1, minWidth: 0, overflow: "hidden", flexWrap: "nowrap" }}>
              {pills.map(pill => <Badge key={pill.label} label={pill.label} tone={pill.tone} c={c} a11y={pill.label} />)}
              {notices.map(notice => <NoticePill key={notice.label} notice={notice} c={c} />)}
            </View>}
          </View>
          <View accessibilityLabel="Nucleus header controls" style={{ ...row, flexWrap: "nowrap", flexShrink: 0 }}>
            {filter}
            {!workspacePanel && headerControls(
                Boolean(state?.paused),
                Boolean(state?.connected),
                busy,
              ).map((control) => control.id === "pause" ? (
                <View key={control.id} style={{ position: "relative", zIndex: queueMenuOpen ? 50 : 0 }}>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <Button small iconOnly joined="start" c={c} icon={control.icon} text={control.label} disabled={control.disabled}
                      onPress={() => { setQueueMenuOpen(false); if (state) void act(() => setQueue({ paused: !state.paused })); }} />
                    <Pressable ref={queueAnchor} accessibilityRole="button" accessibilityLabel="Queue controls menu" accessibilityState={{ expanded: queueMenuOpen, disabled: control.disabled }} disabled={control.disabled}
                      onPress={() => setQueueMenuOpen(!queueMenuOpen)}
                      style={{ minHeight: 36, minWidth: 28, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xxs, backgroundColor: c.surface2,
                        borderTopRightRadius: radius.control, borderBottomRightRadius: radius.control, borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
                        borderLeftWidth: 1, borderLeftColor: roles(c).hairline, opacity: control.disabled ? 0.45 : 1 }}>
                      <Icon name={queueMenuOpen ? "ChevronUp" : "ChevronDown"} size={16} color={c.foreground} />
                    </Pressable>
                  </View>
                  {/* The open menu renders in the shell's popover layer, above the panes. Outside a host it renders in place. */}
                  {queueMenuOpen && <Popover anchor={queueAnchor} contentRef={queueMenu} align="end" inlineStyle={{ top: controlSize.height + space.xxs / 2, right: 0, width: 340 }}>
                    <ScrollView accessibilityRole="menu" accessibilityLabel="Queue controls" nestedScrollEnabled style={{ width: 340, maxHeight: Math.max(0, viewportHeight - inset - controlSize.height - space.lg), borderWidth: 1, borderColor: roles(c).hairline, borderRadius: radius.panel, backgroundColor: roles(c).section, padding: space.xxs,
                    shadowColor: overlay.shadow, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.38, shadowRadius: 14, elevation: 12 }}>
                    {([
                      { key: "pause", icon: control.icon, label: state?.paused ? "Resume" : "Pause", run: () => { if (state) void act(() => setQueue({ paused: !state.paused })); } },
                      { key: "hold", icon: "Pause", label: state?.dispatchHeld ? "Release dispatch hold" : "Dispatch hold", run: () => { if (state) void act(() => setQueue({ dispatchHeld: !state.dispatchHeld })); } },
                      { key: "stop", icon: "Square", label: "Stop", run: () => void act(async () => {
                        await setQueue({ paused: true });
                        await stopThreadsRpc({ caller: "operator (board)" });
                        await refetchState();
                      }) },
                    ] as const).map(item => <SurfacePress key={item.key} role="menuitem" label={item.label} disabled={control.disabled} c={c} corner={radius.control}
                      onPress={() => { setQueueMenuOpen(false); item.run(); }}
                      style={{ minHeight: 34, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.sm, paddingVertical: space.xs }}>
                      <Icon name={item.icon} size={14} color={c.foreground} />
                      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: typeScale.body.fontSize }}>{item.label}</Text>
                    </SurfacePress>)}
                    {state?.paused && <Text style={{ ...muted(c), ...meta, paddingHorizontal: space.sm, paddingBottom: space.xs }}>
                      Submissions are stored. No new run starts. In-flight work drains. Idle status covers this plugin’s managed runs only.
                    </Text>}
                    {/* Queue #665: per-project slot usage, moved here from the header's status line (Tom, 2026-11-21). */}
                    {state && <View accessibilityLabel={`Project slot usage (${state.occupiedSlots ?? 0}/${state.globalLimit} in use)`} style={{ gap: space.xxs, paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: space.xs }}>
                      <View style={{ ...row, flexWrap: "nowrap", justifyContent: "space-between" }}>
                        <Text style={{ color: c.foreground, ...meta, fontWeight: "600" }}>Slots</Text>
                        <Text numberOfLines={1} style={{ ...muted(c), ...meta, flexShrink: 1 }}>{`${state.occupiedSlots ?? 0}/${state.globalLimit} global · project default ${state.projectLimit}${overrideCount ? ` · ${overrideCount} override${overrideCount === 1 ? "" : "s"}` : ""}`}</Text>
                      </View>
                      {slotRows.length === 0
                        ? <Text style={{ ...muted(c), ...meta }}>No project is using a slot.</Text>
                        : slotRows.map(project => <View key={project.projectKey} accessibilityLabel={`${project.projectName}, ${project.occupiedSlots} of ${project.slotLimit} slots, ${project.inFlightTasks} of ${project.inFlightLimit} in flight`} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                          <Text numberOfLines={1} style={{ color: c.foreground, ...meta, flex: 1 }}>{project.projectName}</Text>
                          <Text numberOfLines={1} style={{ color: c.foregroundMuted, ...meta, fontFamily: "monospace", textAlign: "right" }}>{`${project.occupiedSlots}/${project.slotLimit} slots · ${project.inFlightTasks}/${project.inFlightLimit} in flight`}</Text>
                        </View>)}
                    </View>}
                    {state && <View accessibilityLabel={state.drained ? "Drained" : `${state.boundRuns.length} bound run${state.boundRuns.length === 1 ? "" : "s"}`} style={{ gap: space.xxs, paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: space.xs }}>
                      <Text style={{ color: c.foreground, ...meta, fontWeight: "600" }}>{state.drained ? "Drained" : `${state.boundRuns.length} bound run${state.boundRuns.length === 1 ? "" : "s"}`}</Text>
                      {!state.drained && state.boundRuns.slice(0, 8).map(run =>
                        <Text key={run.runId} numberOfLines={1} style={{ color: c.foregroundMuted, ...meta }}>{`${run.reference ?? run.taskId} · ${run.role}`}</Text>)}
                    </View>}
                    </ScrollView>
                  </Popover>}
                </View>
              ) : (
                <Button key={control.id} small iconOnly c={c} icon={control.icon} text={control.label}
                  disabled={control.disabled}
                  onPress={() => {
                    setQueueMenuOpen(false);
                    if (control.id === "settings") settingsOpener?.();
                    else if (control.id === "refresh") void act(() => refresh({}));
                  }} />
              ))}
          </View>
        </View>
        {hasAlerts && <View style={{ gap: space.xxs }}>
          {Boolean(error || readError) && (
            <View style={{ ...row, flexWrap: "nowrap" }}>
              <Text accessibilityRole="alert" style={{ color: c.statusDanger, flex: 1 }}>
                {error || readError}
              </Text>
              {error && <ActionButton c={c} action="close" label="Dismiss error" onPress={onDismissError} />}
            </View>
          )}
          {staleRead && (
            <Text accessibilityRole="alert" style={{ color: c.statusWarning }}>
              {`${staleRead[0]} not refreshed: ${errorText(staleRead[1])}. Showing the last loaded list.`}
            </Text>
          )}
        </View>}
      </View>
      {children}
      {/* Queue #665 / #706: an outside click closes the open queue menu. The layer
        sits above the board (zIndex 40) and below the raised header row (zIndex 50)
        and the popover layer (zIndex 1000), so a press anywhere else dismisses
        while the menu keeps its presses. */}
      {!workspacePanel && queueMenuOpen && <Pressable accessibilityRole="button" accessibilityLabel="Close queue controls" onPress={() => setQueueMenuOpen(false)} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 40 }} />}
  </>;
}
