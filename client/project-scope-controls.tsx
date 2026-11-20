import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Icon } from "./shell";
import { Popover } from "./popover";
import { errorText } from "./error-text";
import type { LeadListFacts, Project, TaskSummary } from "../shared/contracts";
import type { PlanningStep } from "../shared/planning-tab";
import {
  isAdditivePress,
  projectNameProblem,
  projectSelectorRows,
  readProjectScope,
  selectionLabel,
  selectProject,
  toggleProject,
  writeProjectScope,
  type ProjectScope,
} from "../shared/project-scope";
import {
  ActionButton,
  Button,
  Field,
  InlineConfirm,
  controlFrame,
  controlText,
  muted,
  row,
  type Colors,
} from "./controls";
import { control, space, radius, roles, type as typeScale, overlay } from "./design";

type ScopeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};
/** Local storage when the plugin surface offers it; the scope falls back to the session otherwise. */
export const localStore = (): ScopeStorage | undefined => {
  try {
    return (globalThis as { localStorage?: ScopeStorage }).localStorage;
  } catch {
    return undefined;
  }
};

/** The header scope: read once, written back on every change. Never sent to Queue's store. */
export function useProjectScope(
  storage: () => ScopeStorage | undefined = localStore,
): [ProjectScope, (scope: ProjectScope) => void] {
  const [scope, setScope] = useState<ProjectScope>(() =>
    readProjectScope(storage()),
  );
  useEffect(() => writeProjectScope(storage(), scope), [scope]);
  return [scope, setScope];
}

/** Spec 026 row 14c: the workspace panel's selection starts preset to the workspace's
 * project and lives in the panel; it never reads or writes the main surface's scope. */
export function usePanelScope(
  preset: string | null,
): [ProjectScope | null, (scope: ProjectScope) => void] {
  const [scope, setScope] = useState<ProjectScope | null>(null);
  useEffect(() => {
    setScope(preset ? { projects: [preset], statusFilter: true } : null);
  }, [preset]);
  return [scope, setScope];
}

/** The Planning tab's open lane. `inScope` lists the lanes the selection reaches, or
 * null while loading; a lane that leaves scope closes and the compact view returns to the plan. */
export function usePlanningLane(
  inScope: string[] | null,
  onLeave: () => void = () => {},
) {
  const [lane, setLane] = useState(""),
    [step, setStep] = useState<PlanningStep>("plan");
  const scopeKey = inScope?.join("\n") ?? null;
  useEffect(() => {
    if (lane && inScope && !inScope.includes(lane)) {
      setLane("");
      setStep("plan");
      onLeave();
    }
  }, [lane, scopeKey]);
  return { lane, setLane, step, setStep };
}

/** The project selector's "Enabled" switch (Tom, 2026-09-28): off shows every project
 * in every scoped view and keeps the selection; on applies it. */
export function ProjectFilterSwitch({
  value,
  onChange,
  c,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  c: Colors;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel="Enabled"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        minHeight: 32,
      }}
    >
      <View
        style={{
          width: 30,
          height: 18,
          borderRadius: radius.control,
          padding: space.xxs / 2,
          backgroundColor: value ? c.accent : c.surface2,
          alignItems: value ? "flex-end" : "flex-start",
        }}
      >
        <View
          style={{
            width: 14,
            height: 14,
            borderRadius: radius.control,
            backgroundColor: value ? c.accentForeground : c.foregroundMuted,
          }}
        />
      </View>
      <Text style={{ color: c.foreground, fontSize: typeScale.body.fontSize }}>
        Enabled
      </Text>
    </Pressable>
  );
}
/** Hosts with a DOM (the Paseo settings page, the web board) dismiss an open chooser on an outside press or Escape; native hosts skip the listeners. */
type DocumentHost = {
  addEventListener: (
    type: string,
    listener: (event: { key?: string; target?: unknown }) => void,
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event: { key?: string; target?: unknown }) => void,
  ) => void;
};
/** True when a press landed inside one of these boxes (the trigger's or its popover's). Hosts without a DOM report false. */
function withinBoxes(boxes: React.RefObject<View | null>[], target: unknown) {
  return boxes.some((box) => {
    try {
      const node = box.current as unknown as {
        contains?: (target: unknown) => boolean;
      } | null;
      return Boolean(node && node.contains && node.contains(target));
    } catch {
      return false;
    }
  });
}
/** Kept for callers written before the 2026-09-27 board retirement. */

/** A row's actions in the board's project selector (nucleus#1430). Each resolves once the
 * change is saved; a rejection shows in the row. Remove hands the project to the shared
 * removal dialog, which the board renders outside the picker. An absent action is left out of the menu. */
export type ProjectSelectorActions = {
  park?: (project: Project) => Promise<unknown>;
  unpark?: (project: Project) => Promise<unknown>;
  rename?: (project: Project, name: string) => Promise<unknown>;
  remove?: (project: Project) => void;
};

/** A desktop pointer that hovers reveals a row's ellipsis on hover; touch and native hosts keep it visible. */
function finePointer(): boolean {
  try {
    return Boolean(
      (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia?.(
        "(hover: hover) and (pointer: fine)",
      )?.matches,
    );
  } catch {
    return false;
  }
}

type RowMenu = { key: string; view: "actions" | "park" | "rename" };

/** Spec 026 Board "Scope": the header's project selector (nucleus#1421:
 * single-select by default, Shift-click toggles one project). A popover at the
 * wide size, a modal at the compact size. An empty selection means all projects.
 * Each row's ellipsis (nucleus#1430) opens Park or Unpark, Rename and Remove from
 * Nucleus inline in the picker, so no nested popover takes an outside press. Project
 * settings live in Settings → Projects, which its settings icon opens (lane `nucleus-ui`,
 * task 946 build task 4). */
export function ProjectSelector({
  projects,
  tasks,
  leads,
  queuedCounts = [],
  value,
  onChange,
  onOpenChange,
  compact,
  c,
  enabled = true,
  onEnabledChange,
  onSettings,
  projectActions,
}: {
  projects: Project[];
  tasks: TaskSummary[];
  leads: readonly LeadListFacts[];
  queuedCounts?: readonly { repoPath: string; count: number }[];
  value: string[];
  onChange: (keys: string[]) => void;
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  /** Opens Settings at Projects; absent on a host without Settings. */ onSettings?: () => void;
  /** The row ellipsis's actions; absent, rows have no ellipsis. */ projectActions?: ProjectSelectorActions;
  onOpenChange: (open: boolean) => void;
  compact: boolean;
  c: Colors;
}) {
  const [open, setOpenState] = useState(false),
    [search, setSearch] = useState("");
  // The row whose actions are open, and the step it is on. Ref-mirrored so the Escape listener reads it live.
  const [menuState, setMenuState] = useState<RowMenu | null>(null),
    menuRef = useRef<RowMenu | null>(null);
  const [draft, setDraft] = useState(""),
    [pending, setPending] = useState(false),
    [actionError, setActionError] = useState("");
  // Hover and keyboard focus reveal a row's ellipsis on a pointer device.
  const [hovered, setHovered] = useState<string | null>(null),
    [focused, setFocused] = useState<string | null>(null);
  const setMenu = (next: RowMenu | null) => {
    menuRef.current = next;
    setMenuState(next);
    setActionError("");
  };
  const setOpen = (next: boolean) => {
    if (!next) setMenu(null);
    setOpenState(next);
    onOpenChange(next);
  };
  const trigger = useRef<View | null>(null),
    menu = useRef<View | null>(null);
  // Escape and outside presses close the popover on hosts with a DOM. The pointer
  // listener checks the press landed outside the trigger and the popover first, so
  // choosing a project still reaches its own press; guarded like the header menus,
  // so native hosts keep toggle dismissal only.
  useEffect(() => {
    if (!open || compact) return;
    const documentHost = (globalThis as { document?: DocumentHost }).document;
    if (!documentHost) return;
    const onPointer = (event: { target?: unknown }) => {
      if (!withinBoxes([trigger, menu], event?.target)) setOpen(false);
    };
    // Escape closes an open row action first, so a rename in progress is cancelled, not the picker.
    const onKey = (event: { key?: string }) => {
      if (event?.key !== "Escape") return;
      if (menuRef.current) setMenu(null);
      else setOpen(false);
    };
    documentHost.addEventListener("pointerdown", onPointer);
    documentHost.addEventListener("keydown", onKey);
    return () => {
      documentHost.removeEventListener("pointerdown", onPointer);
      documentHost.removeEventListener("keydown", onKey);
    };
  }, [open, compact]);
  const filtering = enabled && value.length > 0;
  const label =
    enabled || !value.length
      ? selectionLabel(projects, value)
      : `${selectionLabel(projects, value)} · filter off`;
  const rows = projectSelectorRows(
    projects,
    value,
    search,
    tasks,
    leads,
    queuedCounts,
  );
  const byKey = new Map(projects.map((project) => [project.key, project]));
  const fine = finePointer();
  // One action at a time. Each one resolves into a closed menu; a rejection stays on the row.
  const run = (action: Promise<unknown>) => {
    setPending(true);
    setActionError("");
    action.then(
      () => {
        setPending(false);
        setMenu(null);
      },
      (error) => {
        setPending(false);
        setActionError(errorText(error));
      },
    );
  };
  const toggleMenu = (key: string) =>
    menuRef.current?.key === key ? setMenu(null) : setMenu({ key, view: "actions" });
  /** The row's actions, inline under the row so the picker's outside-press check still sees them. */
  const renderMenu = (full: Project) => {
    const name = full.name;
    const parked = full.visibility === "parked";
    const view = menuState?.view ?? "actions";
    const step = (next: RowMenu["view"]) => setMenu({ key: full.key, view: next });
    const failure = actionError ? (
      <Text accessibilityRole="alert" style={{ color: roles(c).danger, fontSize: typeScale.metadata.fontSize }}>
        {actionError}
      </Text>
    ) : null;
    const box = {
      gap: space.xs,
      padding: space.xs,
      marginLeft: space.md,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.control,
      backgroundColor: c.surface1,
    };
    if (view === "park")
      return (
        <View style={box}>
          <InlineConfirm
            c={c}
            question={`Park ${name}? No new work starts.`}
            confirmLabel="Park"
            label={`project ${name}`}
            busy={pending}
            onConfirm={() => run(projectActions!.park!(full))}
            onCancel={() => step("actions")}
          />
          {failure}
        </View>
      );
    if (view === "rename") {
      const problem = projectNameProblem(draft);
      return (
        <View style={box}>
          <Field
            c={c}
            label="Name"
            a11yLabel={`Name for ${name}`}
            value={draft}
            onChange={setDraft}
            disabled={pending}
            invalid={Boolean(problem)}
          />
          {problem && (
            <Text accessibilityRole="alert" style={{ color: roles(c).danger, fontSize: typeScale.metadata.fontSize }}>
              {problem}
            </Text>
          )}
          <View style={row}>
            <Button
              small
              c={c}
              text="Save"
              label={`Save name for ${name}`}
              disabled={pending || Boolean(problem) || draft.trim() === name}
              onPress={() => run(projectActions!.rename!(full, draft.trim()))}
            />
            <Button
              small
              c={c}
              text="Cancel"
              label={`Cancel rename of ${name}`}
              disabled={pending}
              onPress={() => step("actions")}
            />
          </View>
          {failure}
        </View>
      );
    }
    return (
      <View style={box}>
        <View style={{ ...row, flexWrap: "wrap" }}>
          {projectActions!.park && !parked && (
            <Button small c={c} text="Park" label={`Park ${name}`} disabled={pending} onPress={() => step("park")} />
          )}
          {projectActions!.unpark && parked && (
            <Button
              small
              c={c}
              text="Unpark"
              label={`Unpark ${name}`}
              disabled={pending}
              onPress={() => run(projectActions!.unpark!(full))}
            />
          )}
          {projectActions!.rename && (
            <Button
              small
              c={c}
              text="Rename"
              label={`Rename ${name}`}
              disabled={pending}
              onPress={() => {
                setDraft(name);
                step("rename");
              }}
            />
          )}
          {projectActions!.remove && (
            // Remove opens the shared removal dialog, which checks blockers and asks for confirmation.
            <Button
              small
              c={c}
              text="Remove from Nucleus"
              label={`Remove ${name} from Nucleus`}
              disabled={pending}
              onPress={() => {
                setOpen(false);
                projectActions!.remove!(full);
              }}
            />
          )}
        </View>
        {failure}
      </View>
    );
  };
  const panel = (
    <View
      accessibilityLabel="Project selector"
      style={{ gap: space.xs, padding: space.sm }}
    >
      {(onEnabledChange || onSettings) && (
        <View style={{ ...row, justifyContent: "space-between" }}>
          {onEnabledChange ? (
            <ProjectFilterSwitch
              value={enabled}
              onChange={onEnabledChange}
              c={c}
            />
          ) : (
            <View />
          )}
          {onSettings && (
            <Button
              iconOnly
              c={c}
              icon="Settings"
              text="Project settings"
              label="Project settings"
              onPress={() => {
                setOpen(false);
                onSettings();
              }}
            />
          )}
        </View>
      )}
      <TextInput
        accessibilityLabel="Filter projects"
        value={search}
        onChangeText={setSearch}
        placeholder="Filter projects"
        placeholderTextColor={c.foregroundMuted}
        style={{ ...controlFrame(c), ...controlText(c) }}
      />
      <View style={row}>
        <Button
          small
          c={c}
          text="All"
          label="Select all projects"
          onPress={() =>
            onChange(
              projects
                .filter((project) => project.visibility !== "parked")
                .map((project) => project.key),
            )
          }
        />
        <Button
          small
          c={c}
          text="None"
          label="Clear project selection"
          onPress={() => onChange([])}
        />
        <Text
          style={{
            ...muted(c),
            fontSize: typeScale.metadata.fontSize,
            flexShrink: 1,
          }}
        >
          {value.length
            ? `${value.length} selected`
            : "None selected · showing all projects"}
        </Text>
      </View>
      <ScrollView
        nestedScrollEnabled
        style={{ maxHeight: compact ? undefined : 380 }}
        contentContainerStyle={{ gap: space.xs }}
      >
        {rows.map((project, index) => (
          <React.Fragment key={project.key}>
            {project.visibility === "parked" &&
              (index === 0 || rows[index - 1].visibility !== "parked") && (
                <Text
                  accessibilityRole="header"
                  accessibilityLabel="Parked"
                  style={{ color: c.foreground, fontWeight: "600" }}
                >
                  Parked
                </Text>
              )}
            {project.visibility !== "parked" &&
              project.dormant &&
              (index === 0 || !rows[index - 1].dormant) && (
                <Text
                  accessibilityRole="header"
                  accessibilityLabel="Dormant projects"
                  style={{ color: c.foreground, fontWeight: "600" }}
                >
                  Dormant projects
                </Text>
              )}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                borderRadius: radius.control,
                borderWidth: 1,
                borderColor: project.checked ? c.accent : c.border,
                backgroundColor: project.checked ? c.surface2 : c.surface0,
              }}
            >
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={`Project ${project.name}, ${project.tasks} tasks`}
                accessibilityState={{ checked: project.checked }}
                onHoverIn={() => setHovered(project.key)}
                onHoverOut={() => setHovered((current) => (current === project.key ? null : current))}
                onFocus={() => setFocused(project.key)}
                onBlur={() => setFocused((current) => (current === project.key ? null : current))}
                onPress={(event) => {
                  // Single-select by default (nucleus#1421): a plain press replaces the
                  // selection and closes the picker, while Shift toggles just that
                  // project and keeps the picker open for a sequence of Shift-clicks.
                  // Touch and keyboard activation carry no Shift, so they select one.
                  const additive = isAdditivePress(event);
                  onChange(
                    additive
                      ? toggleProject(value, project.key)
                      : selectProject(value, project.key),
                  );
                  if (!additive) setOpen(false);
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  padding: space.xs,
                }}
              >
                <View
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: radius.control,
                    borderWidth: 1,
                    borderColor: project.checked ? c.accent : c.foregroundMuted,
                    backgroundColor: project.checked ? c.accent : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {project.checked && (
                    <Icon name="Check" size={12} color={c.accentForeground} />
                  )}
                </View>
                <Text
                  numberOfLines={1}
                  style={{
                    color: c.foreground,
                    fontWeight: "600",
                    fontSize: typeScale.body.fontSize,
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {project.name}
                </Text>
                <Text
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  style={{
                    color: c.foregroundMuted,
                    fontSize: typeScale.metadata.fontSize,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {project.tasks}
                </Text>
              </Pressable>
              {projectActions && byKey.get(project.key) && (() => {
                const full = byKey.get(project.key)!;
                const menuOpen = menuState?.key === project.key;
                // Hidden until hover, focus or an open menu on a pointer device; it keeps its place either way.
                const revealed = compact || !fine || hovered === project.key || focused === project.key || menuOpen;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Project actions for ${full.name}`}
                    accessibilityState={{ expanded: menuOpen }}
                    onHoverIn={() => setHovered(project.key)}
                    onHoverOut={() => setHovered((current) => (current === project.key ? null : current))}
                    onFocus={() => setFocused(project.key)}
                    onBlur={() => setFocused((current) => (current === project.key ? null : current))}
                    onPress={() => toggleMenu(project.key)}
                    style={{
                      opacity: revealed ? 1 : 0,
                      paddingHorizontal: space.xs,
                      paddingVertical: space.xs,
                    }}
                  >
                    <Icon
                      name="EllipsisVertical"
                      size={16}
                      color={menuOpen ? c.foreground : c.foregroundMuted}
                    />
                  </Pressable>
                );
              })()}
            </View>
            {projectActions && menuState?.key === project.key && byKey.get(project.key) && renderMenu(byKey.get(project.key)!)}
          </React.Fragment>
        ))}
        {!projects.length && <Text style={muted(c)}>No projects yet.</Text>}
        {Boolean(projects.length) && !rows.length && (
          <Text style={muted(c)}>No projects match this filter.</Text>
        )}
      </ScrollView>
    </View>
  );
  // The open panel renders in the shell's popover layer, above the board columns:
  // an anchored dropdown inside this row is painted over by the column cards that
  // follow it, and no zIndex leaves this row's stacking context (Tom, 2026-11-19).
  // Outside a host it renders in place, positioned as before.
  return (
    <View
      style={{
        minWidth: 210,
        maxWidth: "100%",
        position: "relative",
        zIndex: open ? 20 : 0,
      }}
    >
      <Pressable
        ref={trigger}
        accessibilityRole="button"
        accessibilityLabel={`Projects, ${label}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{
          ...controlFrame(c, { focused: open }),
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.xs,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            minWidth: 0,
          }}
        >
          <Icon
            name="Folder"
            size={14}
            color={filtering ? c.accent : c.foregroundMuted}
          />
          <Text numberOfLines={1} style={{ ...controlText(c), flexShrink: 1 }}>
            {label}
          </Text>
        </View>
        <Icon
          name={open ? "ChevronUp" : "ChevronDown"}
          size={14}
          color={c.foregroundMuted}
        />
      </Pressable>
      {open && !compact && (
        <Popover
          anchor={trigger}
          contentRef={menu}
          align="end"
          inlineStyle={{
            top: control.height + space.xxs,
            right: 0,
            width: 420,
          }}
        >
          <View
            style={{
              width: 420,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: radius.panel,
              backgroundColor: c.surface1,
              shadowColor: overlay.shadow,
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.38,
              shadowRadius: 14,
              elevation: 12,
            }}
          >
            {panel}
          </View>
        </Popover>
      )}
      {open && compact && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setOpen(false)}
        >
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              padding: space.md,
              backgroundColor: overlay.scrim,
            }}
          >
            <View
              accessibilityViewIsModal
              style={{
                flexShrink: 1,
                maxHeight: "90%",
                width: "100%",
                maxWidth: 560,
                alignSelf: "center",
                borderRadius: radius.panel,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.surface1,
              }}
            >
              <View
                style={{
                  ...row,
                  justifyContent: "space-between",
                  paddingHorizontal: space.sm,
                  paddingTop: space.sm,
                }}
              >
                <Text
                  accessibilityRole="header"
                  style={{
                    color: c.foreground,
                    fontSize: typeScale.section.fontSize,
                    fontWeight: "600",
                  }}
                >
                  Projects
                </Text>
                <ActionButton
                  c={c}
                  action="close"
                  label="Close project selector"
                  onPress={() => setOpen(false)}
                />
              </View>
              {panel}
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}
