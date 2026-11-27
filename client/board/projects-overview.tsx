import React, { useEffect, useState } from "react";
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
  projectTriageCards,
} from "../../shared/inbox-board";
import type { ProjectBadge } from "../../shared/t3/project-badge";
import { muted, noOutline, type Colors } from "../controls";
import { localStore, type ScopeStorage } from "../project-scope-controls";
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
  groupRustTasks,
  rustTaskColumn,
  type RustBoardView,
  type RustTask,
} from "../web/rust-board";
import { CardProject } from "./cards";
import { RustListRows, type InboxListProps } from "./inbox-list";
import { TriageLeadCard } from "./triage-lead-card";

/** A column's tabs (nucleus#1667), in header order. Active is the default. */
export const projectColumnTabs = [
  "active",
  "leads",
  "papercuts",
  "queue",
] as const;
export type ProjectColumnTab = (typeof projectColumnTabs)[number];

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
  /** Active tasks in stage order; undefined until the task list loads. */
  active: RustTask[] | undefined;
  /** Open leads and open papercuts in each list's default order; undefined until the lead read loads. */
  leads: BoardLead[] | undefined;
  papercuts: BoardLead[] | undefined;
  /** Queued tasks in queue order; undefined until the task list loads. */
  queue: RustTask[] | undefined;
};

/**
 * One column per project (nucleus#1666), in the header project select's order.
 * The board state holds only non-archived projects. Each tab's cards are the
 * same set and order as the board list it mirrors, filtered to this project.
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
    const triage = leads && projectTriageCards(projects, leads, key);
    const own = tasks?.filter(({ identity }) =>
      projectHasRepository(project, identity.repository, identity.repository),
    );
    return [
      {
        project,
        active: own
          ?.filter((task) => activeStages.includes(rustTaskColumn(task)))
          .sort(compareRustTasks),
        leads: triage?.leads,
        papercuts: triage?.papercuts,
        queue: own && groupRustTasks(own).queue,
      },
    ];
  });
}

type RustRows = Omit<NonNullable<InboxListProps["rust"]>, "tasks">;

/** How lead and papercut cards open their detail and show the open one. */
export type ProjectItemRows = {
  /** The open lead or papercut and its project, to mark its card. */
  selected: { id: string; project?: string } | null;
  repositoryBadges?: Readonly<Record<string, ProjectBadge>>;
  onSelectLead: (id: string, project: string) => void;
  onSelectPapercut: (id: string, project: string) => void;
};

const tabStorageKey = (project: string) =>
  `nucleus.projects-overview.tab.${project}`;

/** A column's stored tab; Active when storage is missing, unreadable or holds something else. */
export function readColumnTab(
  storage: () => ScopeStorage | undefined,
  project: string,
): ProjectColumnTab {
  try {
    const value = storage()?.getItem(tabStorageKey(project));
    return projectColumnTabs.find((tab) => tab === value) ?? "active";
  } catch {
    return "active";
  }
}

function writeColumnTab(
  storage: () => ScopeStorage | undefined,
  project: string,
  tab: ProjectColumnTab,
) {
  try {
    storage()?.setItem(tabStorageKey(project), tab);
  } catch {
    // The tab still works for this visit; it is not remembered.
  }
}

/**
 * The Projects overview (nucleus#1666): a horizontally scrolling board with a
 * fixed-width column per project. Each column pins its header card and scrolls
 * its cards on its own. The header's four counts are the column's tabs
 * (nucleus#1667): Active, Leads, Papercuts and Queue, each remembered per
 * project in browser storage. A narrow board shows one column at a time.
 */
export function ProjectsOverview({
  c,
  columns,
  narrowWidth,
  badge,
  rust,
  items,
  storage = localStore,
}: {
  c: Colors;
  columns: ProjectOverviewColumn[] | undefined;
  /** On a narrow board, the board's width: one column fills it and the board pages by column. */
  narrowWidth: number | null;
  badge: (projectKey: string) => ProjectBadge | null;
  rust: RustRows;
  items: ProjectItemRows;
  storage?: () => ScopeStorage | undefined;
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
              items={items}
              storage={storage}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const tabLabels: Record<ProjectColumnTab, string> = {
  active: "Active",
  leads: "Leads",
  papercuts: "Papercuts",
  queue: "Queue",
};

const emptyText: Record<ProjectColumnTab, string> = {
  active: "No active tasks",
  leads: "No open leads",
  papercuts: "No open papercuts",
  queue: "Nothing queued",
};

function ProjectColumn({
  c,
  column,
  width,
  inset,
  badge,
  rust,
  items,
  storage,
}: {
  c: Colors;
  column: ProjectOverviewColumn;
  width: number;
  inset: number;
  badge: ProjectBadge | null;
  rust: RustRows;
  items: ProjectItemRows;
  storage: () => ScopeStorage | undefined;
}) {
  const { project } = column;
  const [tab, setTab] = useState<ProjectColumnTab>(() =>
    readColumnTab(storage, project.key),
  );
  useEffect(
    () => writeColumnTab(storage, project.key, tab),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project.key, tab],
  );
  const tasks = tab === "active" || tab === "queue" ? column[tab] : null;
  const triage = tab === "leads" || tab === "papercuts" ? column[tab] : null;
  const cards = tasks ?? triage;
  const empty = cards !== undefined && cards?.length === 0;
  return (
    <View
      accessibilityLabel={`${project.name} column`}
      style={{ width, minHeight: 0, gap: space.xs, padding: inset }}
    >
      <ProjectHeaderCard
        c={c}
        column={column}
        badge={badge}
        tab={tab}
        onTab={setTab}
      />
      <ScrollView
        accessibilityLabel={`${project.name} ${tabLabels[tab].toLowerCase()}`}
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ gap: space.xs, paddingBottom: space.sm }}
      >
        {empty ? (
          <Text style={{ ...muted(c), textAlign: "center", padding: space.md }}>
            {emptyText[tab]}
          </Text>
        ) : tasks !== null ? (
          <RustListRows
            key={tab}
            c={c}
            view={tab === "queue" ? "queue" : "working"}
            column={tab === "queue" ? "queue" : undefined}
            rust={{ ...rust, tasks }}
            hideProject
          />
        ) : triage ? (
          triage.map((lead) => (
            <TriageLeadCard
              key={lead.id}
              lead={lead}
              c={c}
              repositoryBadges={items.repositoryBadges}
              selected={
                items.selected?.id === lead.id &&
                items.selected.project === project.key
              }
              onSelectLead={(id) => items.onSelectLead(id, project.key)}
              onSelectPapercut={(id) => items.onSelectPapercut(id, project.key)}
              showKindWord={false}
              hideProject
            />
          ))
        ) : (
          <Text style={{ ...muted(c), textAlign: "center", padding: space.md }}>
            Loading…
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function ProjectHeaderCard({
  c,
  column,
  badge,
  tab,
  onTab,
}: {
  c: Colors;
  column: ProjectOverviewColumn;
  badge: ProjectBadge | null;
  tab: ProjectColumnTab;
  onTab: (tab: ProjectColumnTab) => void;
}) {
  const { project } = column;
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
        accessibilityRole="tablist"
        accessibilityLabel={`${project.name} tabs`}
        style={{ flexDirection: "row", alignItems: "stretch", gap: space.xxs }}
      >
        {projectColumnTabs.map((id) => (
          <CountTab
            key={id}
            c={c}
            project={project}
            label={tabLabels[id]}
            value={column[id]?.length ?? null}
            selected={tab === id}
            onPress={() => onTab(id)}
          />
        ))}
      </View>
    </View>
  );
}

/** A count and its label: one tab that shows that type's cards in the column. */
function CountTab({
  c,
  project,
  label,
  value,
  selected,
  onPress,
}: {
  c: Colors;
  project: Project;
  label: string;
  value: number | null;
  selected: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const focus = useFocusVisible();
  const highlighted = hovered || focus.visible;
  const color = cardTitleColor(c, selected || highlighted);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={
        value === null
          ? `${label} in ${project.name}`
          : `${value} ${label} in ${project.name}`
      }
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={focus.onFocus}
      onBlur={focus.onBlur}
      style={{
        flex: 1,
        minWidth: 0,
        paddingTop: space.xxs,
        paddingBottom: space.xxs - 2,
        paddingHorizontal: space.xxs,
        borderTopLeftRadius: radius.control,
        borderTopRightRadius: radius.control,
        borderBottomWidth: 2,
        borderBottomColor: selected ? c.accent : "transparent",
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
          color: selected || highlighted ? c.foreground : c.foregroundMuted,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
          fontWeight: selected ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
