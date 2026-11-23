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
import type { ProjectActivity } from "../shared/project-activity";
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
  ACTION_ICONS,
  ActionButton,
  Button,
  FocusRing,
  noOutline,
  controlFrame,
  controlText,
  muted,
  row,
  type Colors,
} from "./controls";
import {
  control,
  space,
  radius,
  roles,
  touchSlop,
  touchTarget,
  type as typeScale,
  overlay,
} from "./design";
import { useFocusVisible } from "./focus-modality";

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
    setScope(preset ? { projects: [preset] } : null);
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
  rename?: (project: Project, name: string) => Promise<unknown>;
  remove?: (project: Project) => void;
};

/** A desktop pointer that hovers reveals a row's disclosure chevron on hover; touch and native hosts keep it visible. */
function finePointer(): boolean {
  try {
    return Boolean(
      (
        globalThis as { matchMedia?: (query: string) => { matches: boolean } }
      ).matchMedia?.("(hover: hover) and (pointer: fine)")?.matches,
    );
  } catch {
    return false;
  }
}

type RowMenu = { key: string; view: "actions" | "rename" };

/** The selection box's side, shared by the row, its rename editor and the note under it. */
const CHECKBOX = 18;

function Checkbox({ c, checked }: { c: Colors; checked: boolean }) {
  return (
    <View
      style={{
        width: CHECKBOX,
        height: CHECKBOX,
        borderRadius: radius.control,
        borderWidth: control.border,
        borderColor: checked ? c.accent : c.foregroundMuted,
        backgroundColor: checked ? c.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked && <Icon name="Check" size={12} color={c.accentForeground} />}
    </View>
  );
}

/** A row's active and total counts, at the same place in the name row and rename editor. */
function Count({
  c,
  active,
  total,
}: {
  c: Colors;
  active: number;
  total: number;
}) {
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        color: c.foregroundMuted,
        fontSize: typeScale.metadata.fontSize,
        lineHeight: typeScale.metadata.lineHeight,
        fontVariant: ["tabular-nums"],
      }}
    >
      {active} / {total}
    </Text>
  );
}

/** A compact icon control in a project row (the disclosure chevron, Save and Cancel): the
 * compact control size, the touch target's reach, and the keyboard focus ring. */
function RowIcon({
  c,
  icon,
  label,
  color,
  expanded,
  hidden = false,
  disabled = false,
  onPress,
  onHoverIn,
  onHoverOut,
  onFocus,
  onBlur,
}: {
  c: Colors;
  icon: string;
  label: string;
  color: string;
  expanded?: boolean;
  hidden?: boolean;
  disabled?: boolean;
  onPress: () => void;
  onHoverIn?: () => void;
  onHoverOut?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const focus = useFocusVisible();
  const [hover, setHover] = useState(false);
  const size = control.compact.height;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={
        expanded === undefined ? { disabled } : { expanded, disabled }
      }
      disabled={disabled}
      hitSlop={touchSlop(size)}
      onHoverIn={() => {
        setHover(true);
        onHoverIn?.();
      }}
      onHoverOut={() => {
        setHover(false);
        onHoverOut?.();
      }}
      onFocus={() => {
        focus.onFocus();
        onFocus?.();
      }}
      onBlur={() => {
        focus.onBlur();
        onBlur?.();
      }}
      onPress={onPress}
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.control,
        opacity: hidden ? 0 : disabled ? 0.45 : 1,
        ...noOutline(),
      }}
    >
      <FocusRing c={c} visible={focus.visible} />
      <Icon
        name={icon}
        size={16}
        color={hover && !disabled ? c.foreground : color}
      />
    </Pressable>
  );
}

/** One action in a row's open panel: an icon in the checkbox's column and a label in the name's,
 * so the panel continues the row it belongs to. `tall` lifts it to the touch target on touch hosts. */
function PanelAction({
  c,
  icon,
  text,
  label,
  danger = false,
  tall,
  disabled = false,
  onPress,
}: {
  c: Colors;
  icon: string;
  text: string;
  label: string;
  danger?: boolean;
  tall: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const focus = useFocusVisible();
  const [hover, setHover] = useState(false);
  const r = roles(c);
  const color = danger ? r.danger : r.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      onFocus={focus.onFocus}
      onBlur={focus.onBlur}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: tall ? touchTarget : control.compact.height + space.xxs,
        paddingHorizontal: space.xxs,
        borderRadius: radius.control,
        backgroundColor: hover && !disabled ? c.surface2 : "transparent",
        opacity: disabled ? 0.45 : 1,
        ...noOutline(),
      }}
    >
      <FocusRing c={c} visible={focus.visible} />
      <View style={{ width: CHECKBOX, alignItems: "center" }}>
        <Icon name={icon} size={14} color={danger ? r.danger : r.muted} />
      </View>
      <Text
        style={{
          color,
          fontSize: typeScale.body.fontSize,
          lineHeight: typeScale.body.lineHeight,
        }}
      >
        {text}
      </Text>
    </Pressable>
  );
}

/** Spec 026 Board "Scope": the header's project selector (nucleus#1421:
 * single-select by default, Shift-click toggles one project). A popover at the
 * wide size, a modal at the compact size. An empty selection means all projects,
 * and selection is the only filter state (nucleus#1476): the picker's top row is
 * the project search with Clear project selection beside Settings, so the rows get
 * the rest of the height.
 * Each row's disclosure chevron (nucleus#1430, #1432) opens a panel attached to the
 * row with Rename and Remove from Nucleus, inside the picker so no
 * nested popover takes an outside press; Rename edits the name in its own slot. Project
 * settings live in Settings → Projects, which its settings icon opens (lane `nucleus-ui`,
 * task 946 build task 4). */
export function ProjectSelector({
  projects,
  tasks,
  leads,
  queuedCounts = [],
  projectActivity = [],
  value,
  onChange,
  onOpenChange,
  compact,
  c,
  onSettings,
  projectActions,
}: {
  projects: Project[];
  tasks: TaskSummary[];
  leads: readonly LeadListFacts[];
  queuedCounts?: readonly { repoPath: string; count: number }[];
  /** Spec 026 (nucleus#1446): the store-wide activity each project's Dormant group reads. */
  projectActivity?: readonly ProjectActivity[];
  value: string[];
  onChange: (keys: string[]) => void;
  /** Opens Settings at Projects; absent on a host without Settings. */ onSettings?: () => void;
  /** The row panel's actions; absent, rows have no disclosure chevron. */ projectActions?: ProjectSelectorActions;
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
    [actionError, setActionError] = useState(""),
    [editorFocused, setEditorFocused] = useState(false);
  // Hover and keyboard focus reveal a row's chevron on a pointer device.
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
  const filtering = value.length > 0;
  const label = selectionLabel(projects, value);
  const rows = projectSelectorRows(
    projects,
    value,
    search,
    tasks,
    leads,
    queuedCounts,
    projectActivity,
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
  // React Native Web's text input keeps its keydown from bubbling, so the editor handles its own
  // Escape. In the compact picker the modal closes on the same key's keyup; that one close is swallowed.
  const swallowClose = useRef(false);
  const onEditorKey = (event: { nativeEvent?: { key?: string } }) => {
    if (event?.nativeEvent?.key !== "Escape") return;
    setMenu(null);
    const documentHost = (globalThis as { document?: DocumentHost }).document;
    if (!compact || !documentHost) return;
    swallowClose.current = true;
    const release = () => {
      documentHost.removeEventListener("keyup", release);
      setTimeout(() => {
        swallowClose.current = false;
      }, 0);
    };
    documentHost.addEventListener("keyup", release);
  };
  const toggleMenu = (key: string) =>
    menuRef.current?.key === key
      ? setMenu(null)
      : setMenu({ key, view: "actions" });
  /** The row's control panel, attached under the row inside its frame, so the picker's outside-press check still sees it. */
  const renderPanel = (full: Project) => {
    const name = full.name;
    const failure = actionError ? (
      <Text
        accessibilityRole="alert"
        style={{
          color: roles(c).danger,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
          paddingHorizontal: space.xs,
          paddingBottom: space.xxs,
        }}
      >
        {actionError}
      </Text>
    ) : null;
    const frame = {
      borderTopWidth: control.border,
      borderTopColor: c.border,
      backgroundColor: c.surface1,
      padding: space.xxs,
      gap: space.xxs / 2,
    };
    const tall = compact || !fine;
    return (
      <View accessibilityLabel={`Actions for ${name}`} style={frame}>
        {projectActions!.rename && (
          <PanelAction
            c={c}
            tall={tall}
            icon={ACTION_ICONS.edit}
            text="Rename"
            label={`Rename ${name}`}
            disabled={pending}
            onPress={() => {
              setDraft(name);
              setMenu({ key: full.key, view: "rename" });
            }}
          />
        )}
        {projectActions!.remove && (
          <>
            {projectActions!.rename && (
              <View
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={{
                  height: control.border,
                  backgroundColor: c.border,
                  marginVertical: space.xxs / 2,
                  marginHorizontal: space.xs,
                }}
              />
            )}
            {/* Remove opens the shared removal dialog, which checks blockers and asks for confirmation. */}
            <PanelAction
              c={c}
              tall={tall}
              danger
              icon={ACTION_ICONS.remove}
              text="Remove from Nucleus"
              label={`Remove ${name} from Nucleus`}
              disabled={pending}
              onPress={() => {
                setOpen(false);
                projectActions!.remove!(full);
              }}
            />
          </>
        )}
        {failure}
      </View>
    );
  };
  /** Rename edits the name in its own slot: the input takes the label's place, so one name shows throughout. */
  const renderEditor = (
    full: Project,
    tasks: number,
    total: number,
    checked: boolean,
  ) => {
    const name = full.name;
    const problem = projectNameProblem(draft);
    const trimmed = draft.trim();
    const save = () => {
      if (pending || problem) return;
      if (trimmed === name) return setMenu(null);
      run(projectActions!.rename!(full, trimmed));
    };
    const message = problem ?? actionError;
    const line = (
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingVertical: space.xxs,
          paddingHorizontal: space.xs,
        }}
      >
        <Checkbox c={c} checked={checked} />
        <TextInput
          accessibilityLabel={`Name for ${name}`}
          accessibilityState={{ disabled: pending }}
          value={draft}
          onChangeText={(next) => {
            setDraft(next);
            if (actionError) setActionError("");
          }}
          onSubmitEditing={save}
          onKeyPress={onEditorKey}
          blurOnSubmit={false}
          onFocus={() => setEditorFocused(true)}
          onBlur={() => setEditorFocused(false)}
          editable={!pending}
          autoFocus
          selectTextOnFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          style={{
            ...controlFrame(c, {
              compact: true,
              focused: editorFocused,
              invalid: Boolean(message),
            }),
            ...controlText(c),
            // The frame's border and inset sit outside the text, so the typed name lines up with the label it replaces.
            paddingHorizontal: space.xxs,
            marginLeft: -(space.xxs + control.border),
            paddingVertical: 0,
            height: control.compact.height,
            fontWeight: "600",
            flex: 1,
            minWidth: 0,
            opacity: pending ? 0.6 : 1,
            ...noOutline(),
          }}
        />
        <View style={{ flexDirection: "row", gap: space.xxs }}>
          <RowIcon
            c={c}
            icon={pending ? "LoaderCircle" : "Check"}
            label={`Save name for ${name}`}
            color={c.accent}
            disabled={pending || Boolean(problem) || trimmed === name}
            onPress={save}
          />
          <RowIcon
            c={c}
            icon="X"
            label={`Cancel rename of ${name}`}
            color={c.foregroundMuted}
            disabled={pending}
            onPress={() => setMenu(null)}
          />
        </View>
        <Count c={c} active={tasks} total={total} />
      </View>
    );
    const note = message ? (
      <Text
        accessibilityRole="alert"
        style={{
          color: roles(c).danger,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
          paddingLeft: space.xs + CHECKBOX + space.sm,
          paddingRight: space.xs,
          paddingBottom: space.xs,
        }}
      >
        {message}
      </Text>
    ) : null;
    return { line, note };
  };
  const panel = (
    <View
      accessibilityLabel="Project selector"
      // Shrinks inside the compact modal's card so the project list scrolls there instead of overflowing it.
      style={{ gap: space.xs, padding: space.sm, flexShrink: 1, minHeight: 0 }}
    >
      <View style={{ ...row, gap: space.xs }}>
        <TextInput
          accessibilityLabel="Filter projects"
          value={search}
          onChangeText={setSearch}
          placeholder="Filter projects"
          placeholderTextColor={c.foregroundMuted}
          style={{
            ...controlFrame(c),
            ...controlText(c),
            flex: 1,
            minWidth: 0,
          }}
        />
        {/* The only filter state is the selection (nucleus#1476), so clearing it
          restores every project and keeps the picker open. It shares the row with
          the search and stands alone when the host has no Settings to open. */}
        <Button
          iconOnly
          c={c}
          icon="FolderX"
          text="Clear project selection"
          label="Clear project selection"
          onPress={() => onChange([])}
        />
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
      <ScrollView
        nestedScrollEnabled
        style={{ maxHeight: compact ? undefined : 380 }}
        contentContainerStyle={{ gap: space.xs }}
      >
        {rows.map((project, index) => (
          <React.Fragment key={project.key}>
            {project.dormant &&
              (index === 0 || !rows[index - 1].dormant) && (
                <Text
                  accessibilityRole="header"
                  accessibilityLabel="Dormant projects"
                  style={{ color: c.foreground, fontWeight: "600" }}
                >
                  Dormant projects
                </Text>
              )}
            {(() => {
              const full = byKey.get(project.key);
              const withActions = Boolean(projectActions && full);
              const mine = withActions && menuState?.key === project.key;
              const editing = mine && menuState?.view === "rename";
              const panelOpen = mine && !editing;
              const editor = editing
                ? renderEditor(
                    full!,
                    project.tasks,
                    project.total,
                    project.checked,
                  )
                : null;
              // Hidden until hover, focus or an open panel on a hover pointer; it keeps its place either way.
              const revealed =
                compact ||
                !fine ||
                hovered === project.key ||
                focused === project.key ||
                mine;
              const reveal = {
                onHoverIn: () => setHovered(project.key),
                onHoverOut: () =>
                  setHovered((current) =>
                    current === project.key ? null : current,
                  ),
                onFocus: () => setFocused(project.key),
                onBlur: () =>
                  setFocused((current) =>
                    current === project.key ? null : current,
                  ),
              };
              return (
                // Row and panel share one frame: the open panel reads as part of its row, not a tray below it.
                <View
                  style={{
                    borderRadius: radius.control,
                    borderWidth: control.border,
                    borderColor: project.checked ? c.accent : c.border,
                    backgroundColor: project.checked ? c.surface2 : c.surface0,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      paddingRight: withActions ? space.xxs : 0,
                    }}
                  >
                    {editor ? (
                      editor.line
                    ) : (
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityLabel={`Project ${project.name}, ${project.tasks} active, ${project.total} in total`}
                        accessibilityState={{ checked: project.checked }}
                        {...reveal}
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
                        <Checkbox c={c} checked={project.checked} />
                        <Text
                          numberOfLines={1}
                          style={{
                            color: c.foreground,
                            fontWeight: "600",
                            fontSize: typeScale.body.fontSize,
                            lineHeight: typeScale.body.lineHeight,
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {project.name}
                        </Text>
                        <Count
                          c={c}
                          active={project.tasks}
                          total={project.total}
                        />
                      </Pressable>
                    )}
                    {withActions && (
                      <RowIcon
                        c={c}
                        icon={panelOpen ? "ChevronUp" : "ChevronDown"}
                        label={`Project actions for ${full!.name}`}
                        expanded={panelOpen}
                        color={panelOpen ? c.foreground : c.foregroundMuted}
                        hidden={!revealed}
                        disabled={editing}
                        {...reveal}
                        onPress={() => toggleMenu(project.key)}
                      />
                    )}
                  </View>
                  {editor?.note}
                  {panelOpen && renderPanel(full!)}
                </View>
              );
            })()}
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
  //
  // The narrow header (nucleus#1511) has no room for the label: the trigger there
  // is the selector's folder icon alone, still opening the same picker, still
  // labelled "Projects, <selection>" for a screen reader.
  return (
    <View
      style={{
        minWidth: compact ? control.height : 210,
        maxWidth: "100%",
        position: "relative",
        zIndex: open ? 20 : 0,
      }}
    >
      <Pressable
        ref={trigger}
        accessibilityRole="button"
        accessibilityLabel={`Projects, ${label}`}
        accessibilityHint={compact ? `Projects: ${label}` : undefined}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{
          ...controlFrame(c, { focused: open }),
          flexDirection: "row",
          alignItems: "center",
          justifyContent: compact ? "center" : "space-between",
          gap: space.xs,
          ...(compact
            ? { width: control.height, minWidth: control.height, paddingHorizontal: 0 }
            : {}),
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
          {!compact && (
            <Text numberOfLines={1} style={{ ...controlText(c), flexShrink: 1 }}>
              {label}
            </Text>
          )}
        </View>
        {!compact && (
          <Icon
            name={open ? "ChevronUp" : "ChevronDown"}
            size={14}
            color={c.foregroundMuted}
          />
        )}
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
          // Escape (React Native Web) and the Android back button cancel an open row action before the picker.
          onRequestClose={() => {
            if (swallowClose.current) return;
            if (menuRef.current) setMenu(null);
            else setOpen(false);
          }}
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
