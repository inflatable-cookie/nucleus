import React, { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Icon } from "./shell";
import type { LeadListFacts, Project, TaskSummary } from "../shared/contracts";
import type { PlanningStep } from "../shared/planning-tab";
import { projectSelectorRows, readProjectScope, selectionLabel, toggleProject, writeProjectScope, type ProjectScope } from "../shared/project-scope";
import { ActionButton, Button, controlFrame, controlText, muted, row, type Colors } from "./controls";
import { control, space } from "./design";

type ScopeStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem?(key: string): void };
/** Local storage when the plugin surface offers it; the scope falls back to the session otherwise. */
export const localStore = (): ScopeStorage | undefined => { try { return (globalThis as { localStorage?: ScopeStorage }).localStorage; } catch { return undefined; } };

/** The header scope: read once, written back on every change. Never sent to Queue's store. */
export function useProjectScope(storage: () => ScopeStorage | undefined = localStore): [ProjectScope, (scope: ProjectScope) => void] {
  const [scope, setScope] = useState<ProjectScope>(() => readProjectScope(storage()));
  useEffect(() => writeProjectScope(storage(), scope), [scope]);
  return [scope, setScope];
}

/** Spec 026 row 14c: the workspace panel's selection starts preset to the workspace's
 * project and lives in the panel; it never reads or writes the main surface's scope. */
export function usePanelScope(preset: string | null): [ProjectScope | null, (scope: ProjectScope) => void] {
  const [scope, setScope] = useState<ProjectScope | null>(null);
  useEffect(() => { setScope(preset ? { projects: [preset], statusFilter: true } : null); }, [preset]);
  return [scope, setScope];
}

/** The Planning tab's open lane. `inScope` lists the lanes the selection reaches, or
 * null while loading; a lane that leaves scope closes and the compact view returns to the plan. */
export function usePlanningLane(inScope: string[] | null, onLeave: () => void = () => {}) {
  const [lane, setLane] = useState(""), [step, setStep] = useState<PlanningStep>("plan");
  const scopeKey = inScope?.join("\n") ?? null;
  useEffect(() => {
    if (lane && inScope && !inScope.includes(lane)) { setLane(""); setStep("plan"); onLeave(); }
  }, [lane, scopeKey]);
  return { lane, setLane, step, setStep };
}

/** The project selector's "Enabled" switch (Tom, 2026-09-28): off shows every project
 * in every scoped view and keeps the selection; on applies it. */
export function ProjectFilterSwitch({ value, onChange, c }: { value: boolean; onChange: (value: boolean) => void; c: Colors }) {
  return <Pressable accessibilityRole="switch" accessibilityLabel="Enabled" accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={{ flexDirection: "row", alignItems: "center", gap: 7, minHeight: 32 }}>
    <View style={{ width: 30, height: 18, borderRadius: 9, padding: 2, backgroundColor: value ? c.accent : c.surface2, alignItems: value ? "flex-end" : "flex-start" }}><View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: value ? c.accentForeground : c.foregroundMuted }} /></View>
    <Text style={{ color: c.foreground, fontSize: 13 }}>Enabled</Text></Pressable>;
}
/** Kept for callers written before the 2026-09-27 board retirement. */

/** Spec 026 Board "Scope": the header's multi-project selector. A popover at the
 * wide size, a modal at the compact size. An empty selection means all projects.
 * It only scopes the board: project settings live in Settings → Projects, which
 * its settings icon opens (lane `nucleus-ui`, task 946 build task 4). */
export function ProjectSelector({ projects, tasks, leads, value, onChange, onOpenChange, compact, c, enabled = true, onEnabledChange, onSettings }: { projects: Project[]; tasks: TaskSummary[]; leads: readonly LeadListFacts[]; value: string[]; onChange: (keys: string[]) => void; enabled?: boolean; onEnabledChange?: (enabled: boolean) => void; /** Opens Settings at Projects; absent on a host without Settings. */ onSettings?: () => void; onOpenChange: (open: boolean) => void; compact: boolean; c: Colors }) {
  const [open, setOpenState] = useState(false), [search, setSearch] = useState("");
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange(next); };
  const filtering = enabled && value.length > 0;
  const label = enabled || !value.length ? selectionLabel(projects, value) : `${selectionLabel(projects, value)} · filter off`;
  const rows = projectSelectorRows(projects, value, search, tasks, leads);
  const panel = <View accessibilityLabel="Project selector" style={{ gap: 8, padding: 12 }}>
    {(onEnabledChange || onSettings) && <View style={{ ...row, justifyContent: "space-between" }}>
      {onEnabledChange ? <ProjectFilterSwitch value={enabled} onChange={onEnabledChange} c={c} /> : <View />}
      {onSettings && <Button iconOnly c={c} icon="Settings" text="Project settings" label="Project settings" onPress={() => { setOpen(false); onSettings(); }} />}
    </View>}
    <TextInput accessibilityLabel="Filter projects" value={search} onChangeText={setSearch} placeholder="Filter projects" placeholderTextColor={c.foregroundMuted} style={{ ...controlFrame(c), ...controlText(c) }} />
    <View style={row}><Button small c={c} text="All" label="Select all projects" onPress={() => onChange(projects.filter(project => project.visibility !== 'parked').map(project => project.key))} /><Button small c={c} text="None" label="Clear project selection" onPress={() => onChange([])} />
      <Text style={{ ...muted(c), fontSize: 11, flexShrink: 1 }}>{value.length ? `${value.length} selected` : "None selected · showing all projects"}</Text></View>
    <ScrollView nestedScrollEnabled style={{ maxHeight: compact ? undefined : 380 }} contentContainerStyle={{ gap: 6 }}>
      {rows.map((project, index) => <React.Fragment key={project.key}>{project.visibility === 'parked' && (index === 0 || rows[index - 1].visibility !== 'parked') && <Text accessibilityRole="header" accessibilityLabel="Parked" style={{ color: c.foreground, fontWeight: '600' }}>Parked</Text>}{project.visibility !== 'parked' && project.dormant && (index === 0 || !rows[index - 1].dormant) && <Text accessibilityRole="header" accessibilityLabel="Dormant projects" style={{ color: c.foreground, fontWeight: '600' }}>Dormant projects</Text>}<Pressable accessibilityRole="checkbox" accessibilityLabel={`Project ${project.name}`} accessibilityState={{ checked: project.checked }} onPress={() => onChange(toggleProject(value, project.key))}
        style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 9, borderRadius: 7, borderWidth: 1, borderColor: project.checked ? c.accent : c.border, backgroundColor: project.checked ? c.surface2 : c.surface0 }}>
        <View style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: project.checked ? c.accent : c.foregroundMuted, backgroundColor: project.checked ? c.accent : "transparent", alignItems: "center", justifyContent: "center" }}>{project.checked && <Icon name="Check" size={12} color={c.accentForeground} />}</View>
        <Text numberOfLines={1} style={{ color: c.foreground, fontWeight: "600", fontSize: 13, flex: 1, minWidth: 0 }}>{project.name}</Text>
      </Pressable></React.Fragment>)}
      {!projects.length && <Text style={muted(c)}>No projects yet.</Text>}
      {Boolean(projects.length) && !rows.length && <Text style={muted(c)}>No projects match this filter.</Text>}
    </ScrollView>
  </View>;
  return <View style={{ minWidth: 210, maxWidth: "100%", position: "relative", zIndex: open ? 20 : 0 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Projects, ${label}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
      style={{ ...controlFrame(c, { focused: open }), flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0 }}><Icon name="Folder" size={14} color={filtering ? c.accent : c.foregroundMuted} />
        <Text numberOfLines={1} style={{ ...controlText(c), flexShrink: 1 }}>{label}</Text></View>
      <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
    </Pressable>
    {open && !compact && <View style={{ position: "absolute", top: control.height + space.xxs, right: 0, width: 420, borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface1,
      shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.38, shadowRadius: 14, elevation: 12 }}>{panel}</View>}
    {open && compact && <Modal visible transparent animationType="fade" onRequestClose={() => setOpen(false)}><View style={{ flex: 1, justifyContent: "center", padding: 16, backgroundColor: "rgba(0,0,0,0.68)" }}>
      <View accessibilityViewIsModal style={{ flexShrink: 1, maxHeight: "90%", width: "100%", maxWidth: 560, alignSelf: "center", borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
        <View style={{ ...row, justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 12 }}><Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>Projects</Text><ActionButton c={c} action="close" label="Close project selector" onPress={() => setOpen(false)} /></View>
        {panel}</View></View></Modal>}
  </View>;
}
