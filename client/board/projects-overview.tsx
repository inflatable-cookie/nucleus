import React, { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type {
  BoardLead,
  LeadListFacts,
  Project,
  TaskSummary,
} from "../../shared/contracts";
import type { ProjectActivity } from "../../shared/project-activity";
import {
  projectHasRepository,
  projectSelectorRows,
} from "../../shared/project-scope";
import {
  projectColumnWidth,
  projectTriageCounts,
} from "../../shared/inbox-board";
import type { ProjectBadge } from "../../shared/t3/project-badge";
import {
  HelpPopover,
  HelpTip,
  muted,
  noOutline,
  type Colors,
} from "../controls";
import { useFocusVisible } from "../focus-modality";
import {
  cardTitleColor,
  hoverSurface,
  radius,
  roles,
  space,
  type as typeScale,
} from "../design";
import {
  compareRustTasks,
  rustTaskColumn,
  type RustBoardView,
  type RustTask,
} from "../web/rust-board";
import { CardProject } from "./cards";
import { RustListRows, type InboxListProps } from "./inbox-list";

/** The lists a header count opens, filtered to its project. */
export type ProjectListView = "leads" | "papercuts" | "queue";

/** Active stages, in the order a column lists them: queued and finished tasks stay out. */
const activeStages: readonly RustBoardView[] = [
  "needs",
  "working",
  "review",
  "merging",
  "closing",
];

/** The project selector's inputs. The overview orders its columns with the same call. */
export type ProjectSelectorInputs = {
  tasks: TaskSummary[];
  leads: readonly LeadListFacts[];
  queuedCounts: readonly { repoPath: string; count: number }[];
  projectActivity: readonly ProjectActivity[];
};

export type ProjectOverviewColumn = {
  project: Project;
  /** Open leads, open papercuts and queued tasks; null until the read loads. */
  leads: number | null;
  papercuts: number | null;
  queue: number | null;
  /** Active tasks in stage order; undefined until the task list loads. */
  active: RustTask[] | undefined;
};

/**
 * One column per project (nucleus#1666), in the header project select's order.
 * The board state holds only non-archived projects. Lead and papercut counts are
 * each list's default set with the filter on this project, so a count matches the
 * list its link opens.
 */
export function projectOverviewColumns({
  projects,
  selector,
  leads,
  tasks,
  nowMs = Date.now(),
}: {
  projects: Project[];
  selector: ProjectSelectorInputs;
  leads: readonly BoardLead[] | undefined;
  tasks: readonly RustTask[] | undefined;
  nowMs?: number;
}): ProjectOverviewColumn[] {
  const byKey = new Map(projects.map((project) => [project.key, project]));
  const order = projectSelectorRows(
    projects,
    [],
    "",
    selector.tasks,
    selector.leads,
    selector.queuedCounts,
    selector.projectActivity,
    nowMs,
  );
  return order.flatMap(({ key }) => {
    const project = byKey.get(key);
    if (!project) return [];
    const triage = leads && projectTriageCounts(projects, leads, key);
    const own = tasks?.filter(({ identity }) =>
      projectHasRepository(project, identity.repository, identity.repository),
    );
    return [
      {
        project,
        leads: triage ? triage.leads : null,
        papercuts: triage ? triage.papercuts : null,
        queue: own
          ? own.filter((task) => task.phase === "queued").length
          : null,
        active: own
          ?.filter((task) => activeStages.includes(rustTaskColumn(task)))
          .sort(compareRustTasks),
      },
    ];
  });
}

type RustRows = Omit<NonNullable<InboxListProps["rust"]>, "tasks">;

/**
 * The Projects overview (nucleus#1666): a horizontally scrolling board with a
 * fixed-width column per project. Each column pins its header card and scrolls
 * its active task cards on its own. A narrow board shows one column at a time.
 */
export function ProjectsOverview({
  c,
  columns,
  narrowWidth,
  badge,
  rust,
  onOpenList,
}: {
  c: Colors;
  columns: ProjectOverviewColumn[] | undefined;
  /** On a narrow board, the board's width: one column fills it and the board pages by column. */
  narrowWidth: number | null;
  badge: (projectKey: string) => ProjectBadge | null;
  rust: RustRows;
  onOpenList: (projectKey: string, view: ProjectListView) => void;
}) {
  const narrow = Boolean(narrowWidth);
  const columnWidth = narrowWidth || projectColumnWidth;
  const gap = narrow ? 0 : space.sm;
  return (
    <View
      accessibilityLabel="Projects overview"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        backgroundColor: roles(c).canvas,
      }}
    >
      {!columns ? (
        <Text style={{ ...muted(c), padding: space.md }}>
          Loading projects…
        </Text>
      ) : columns.length === 0 ? (
        <Text style={{ ...muted(c), padding: space.md }}>No projects yet.</Text>
      ) : (
        <ScrollView
          horizontal
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{
            gap,
            padding: narrow ? 0 : space.sm,
            alignItems: "stretch",
            minHeight: "100%",
          }}
        >
          {columns.map((column) => (
            <ProjectColumn
              key={column.project.key}
              c={c}
              column={column}
              width={columnWidth}
              inset={narrow ? space.sm : 0}
              badge={badge(column.project.key)}
              rust={rust}
              onOpenList={onOpenList}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function ProjectColumn({
  c,
  column,
  width,
  inset,
  badge,
  rust,
  onOpenList,
}: {
  c: Colors;
  column: ProjectOverviewColumn;
  width: number;
  inset: number;
  badge: ProjectBadge | null;
  rust: RustRows;
  onOpenList: (projectKey: string, view: ProjectListView) => void;
}) {
  const { project, active } = column;
  const rows = { ...rust, tasks: active };
  return (
    <View
      accessibilityLabel={`${project.name} column`}
      style={{ width, minHeight: 0, gap: space.xs, padding: inset }}
    >
      <ProjectHeaderCard
        c={c}
        column={column}
        badge={badge}
        onOpenList={onOpenList}
      />
      <ScrollView
        accessibilityLabel={`${project.name} active tasks`}
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ gap: space.xs, paddingBottom: space.sm }}
      >
        {active && active.length === 0 ? (
          <Text style={{ ...muted(c), textAlign: "center", padding: space.md }}>
            Nothing active
          </Text>
        ) : (
          <RustListRows c={c} view="working" rust={rows} hideProject />
        )}
      </ScrollView>
    </View>
  );
}

const countHelp =
  "Open leads, open papercuts and queued tasks. Each opens its list for this project.";

function ProjectHeaderCard({
  c,
  column,
  badge,
  onOpenList,
}: {
  c: Colors;
  column: ProjectOverviewColumn;
  badge: ProjectBadge | null;
  onOpenList: (projectKey: string, view: ProjectListView) => void;
}) {
  const { project } = column;
  const [help, setHelp] = useState(false);
  const anchor = useRef<View | null>(null);
  const r = roles(c);
  return (
    <View
      accessibilityLabel={`${project.name} overview`}
      style={{
        gap: space.xs,
        padding: space.sm,
        borderRadius: radius.card,
        backgroundColor: r.section,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.xxs,
          minWidth: 0,
        }}
      >
        <CardProject
          c={c}
          name={project.name}
          projectKey={project.key}
          badge={badge}
        />
      </View>
      <View
        ref={anchor}
        style={{ flexDirection: "row", alignItems: "center", gap: space.xxs }}
      >
        <CountLink
          c={c}
          project={project}
          view="leads"
          label="Leads"
          value={column.leads}
          onOpenList={onOpenList}
        />
        <CountLink
          c={c}
          project={project}
          view="papercuts"
          label="Papercuts"
          value={column.papercuts}
          onOpenList={onOpenList}
        />
        <CountLink
          c={c}
          project={project}
          view="queue"
          label="Queue"
          value={column.queue}
          onOpenList={onOpenList}
        />
        <HelpTip
          c={c}
          label={`${project.name} counts`}
          text={countHelp}
          open={help}
          onOpenChange={setHelp}
        />
      </View>
      {help && (
        <HelpPopover
          c={c}
          anchor={anchor}
          label={`${project.name} counts`}
          text={countHelp}
        />
      )}
    </View>
  );
}

/** A count and its label, one link to that list filtered to the project. */
function CountLink({
  c,
  project,
  view,
  label,
  value,
  onOpenList,
}: {
  c: Colors;
  project: Project;
  view: ProjectListView;
  label: string;
  value: number | null;
  onOpenList: (projectKey: string, view: ProjectListView) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const focus = useFocusVisible();
  const highlighted = hovered || focus.visible;
  const color = cardTitleColor(c, highlighted);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={
        value === null
          ? `${label} in ${project.name}`
          : `${value} ${label} in ${project.name}`
      }
      onPress={() => onOpenList(project.key, view)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={focus.onFocus}
      onBlur={focus.onBlur}
      style={{
        flex: 1,
        minWidth: 0,
        paddingVertical: space.xxs,
        paddingHorizontal: space.xs,
        borderRadius: radius.control,
        backgroundColor: highlighted ? hoverSurface(c) : "transparent",
        ...noOutline(),
      }}
    >
      <Text
        style={{
          color,
          fontSize: typeScale.section.fontSize,
          lineHeight: typeScale.section.lineHeight,
          fontWeight: "600",
        }}
      >
        {value ?? "–"}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          color: highlighted ? c.foreground : c.foregroundMuted,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
          textDecorationLine: highlighted ? "underline" : "none",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
