import { useArchiveProject } from "./project-selector-actions";
import { errorText } from "./error-text";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Icon, useRpc } from "./shell";
import {
  Button,
  Field,
  HelpPanel,
  muted,
  row,
  type Colors,
} from "./controls";
import { roles, space, touchSlop, touchTarget, type } from "./design";
import { Popover } from "./popover";
import { ProjectEditor, type ProjectEditActions } from "./project-editor";
import {
  folderName,
  withoutHostPaths,
  } from "./project-helpers";
import {
  type Project,
  type ProjectSettings,
  type ProjectSettingsRow,
  } from "../shared/contracts";

/*
 * Settings → Projects (lane `nucleus-ui`, "Projects in Settings, replacing
 * Repositories", build task 2): the list of projects with one problem icon per
 * row, and the Add project sheet. Everything reads from the
 * one `project.settings` read; writes stay on the existing RPCs. A row opens
 * the project (build task 3, `project-editor.tsx`).
 */

/** The filter field appears only above this many rows. */
export const PROJECT_FILTER_MIN = 13;
export {
  implicitRepositories,
  projectKeyFor,
  repositoryLabel,
  withoutHostPaths,
} from "./project-helpers";

/** Names compare without case, then by key. */
export function sortProjectRows(
  rows: readonly ProjectSettingsRow[],
): ProjectSettingsRow[] {
  return [...rows].sort(
    (a, b) =>
      a.project.name.localeCompare(b.project.name, undefined, {
        sensitivity: "base",
      }) || a.project.key.localeCompare(b.project.key),
  );
}

/** Rows whose name, or a repository's `owner/name`, contains the filter text. */
export function filterProjectRows(
  rows: readonly ProjectSettingsRow[],
  filter: string,
): ProjectSettingsRow[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (entry) =>
      entry.project.name.toLowerCase().includes(needle) ||
      entry.repositories.some((repo) =>
        (repo.repository.origin ?? "").toLowerCase().includes(needle),
      ),
  );
}

const OTHER = "__other__";

/**
 * A row's problem icon: one icon however many problems, its tooltip listing them
 * worst first in the popover layer. Hover, focus and press open it.
 */
function ProblemIcon({
  c,
  name,
  problems,
  color,
}: {
  c: Colors;
  name: string;
  problems: readonly string[];
  color: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  const text = problems.join("\n");
  return (
    <View ref={anchor}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name} problems`}
        accessibilityHint={problems.join(". ")}
        accessibilityState={{ expanded: open }}
        onHoverIn={() => setOpen(true)}
        onHoverOut={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onPress={() => setOpen((was) => !was)}
        hitSlop={touchSlop(20)}
        style={{
          width: 20,
          height: 20,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="TriangleAlert" size={16} color={color} />
      </Pressable>
      {open && (
        <Popover
          anchor={anchor}
          align="end"
          pointerEvents="none"
          maxWidth={320}
          inlineStyle={{ top: "100%", right: 0, marginTop: space.xxs }}
        >
          <HelpPanel c={c} label={`${name} problems`} text={text} />
        </Popover>
      )}
    </View>
  );
}

function ProjectRow({
  c,
  entry,
  onOpen,
  archive,
}: {
  c: Colors;
  entry: ProjectSettingsRow;
  onOpen?: () => void;
  /** Rust engine (Spec 070 ruling 8): shows Archive or Restore; called after a change. */
  archive?: () => unknown;
}) {
  const r = roles(c);
  const name = entry.project.name;
  const label = `${name}${entry.problems.length ? `, ${entry.problems.join(", ")}` : ""}`;
  const face = (
    <>
      <Text
        numberOfLines={1}
        style={{
          color: r.foreground,
          fontSize: type.body.fontSize,
          lineHeight: type.body.lineHeight,
          flex: 1,
          minWidth: 0,
        }}
      >
        {name}
      </Text>
    </>
  );
  const faceStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    flex: 1,
    minWidth: 0,
    minHeight: touchTarget,
  };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingHorizontal: space.sm,
        borderBottomWidth: 1,
        borderBottomColor: r.hairline,
      }}
    >
      {onOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Opens the project"
          onPress={onOpen}
          style={faceStyle}
        >
          {face}
        </Pressable>
      ) : (
        <View accessibilityLabel={label} style={faceStyle}>
          {face}
        </View>
      )}
      {archive && <ArchiveButton c={c} entry={entry} name={name} changed={archive} />}
      {/* A fixed slot, so status words line up whether or not a row has a problem. */}
      <View style={{ width: 20, alignItems: "center" }}>
        {entry.problems.length > 0 && (
          <ProblemIcon
            c={c}
            name={name}
            problems={entry.problems}
            color={r.warning}
          />
        )}
      </View>
    </View>
  );
}

/** Rust engine (Spec 070 ruling 8): archive or restore one project. */
function ArchiveButton({
  c,
  entry,
  name,
  changed,
}: {
  c: Colors;
  entry: ProjectSettingsRow;
  name: string;
  changed: () => unknown;
}) {
  const archiveProject = useArchiveProject();
  const [busy, setBusy] = useState(false);
  const verb = entry.archived ? "Restore" : "Archive";
  return (
    <Button
      c={c}
      small
      text={verb}
      label={`${verb} ${name}`}
      disabled={busy}
      onPress={() => {
        setBusy(true);
        void archiveProject(entry.project.key, !entry.archived)
          .then(changed)
          .finally(() => setBusy(false));
      }}
    />
  );
}

export type ProjectsQuery = {
  data: ProjectSettings | undefined;
  error: unknown;
  isPending: boolean;
  refetch: () => unknown;
};

/**
 * The Projects section: the list. The list reads `project.settings`;
 * Add project writes `project.upsert`. A failed refresh keeps the rows it had,
 * with a warning on the header.
 */
export function ProjectsSection({
  c,
  compact,
  inset,
  query,
  onFocus,
  edit,
}: {
  c: Colors;
  compact: boolean;
  inset: number;
  query: ProjectsQuery;
  /** Reports the project open in the editor, or null at the list; its live state is read only then. */
  onFocus?: (key: string | null) => void;
  /** The opened project's writes; without them rows do not open. */
  edit?: ProjectEditActions;
}) {
  const [view, setView] = useState<"list" | "project">("list");
  const [opened, setOpened] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const scroll = useRef<{
    scrollTo?: (to: { y: number; animated: boolean }) => void;
  } | null>(null);
  const offset = useRef(0);
  // Back returns to the list where it was.
  useEffect(() => {
    if (view === "list" && offset.current)
      scroll.current?.scrollTo?.({ y: offset.current, animated: false });
  }, [view]);
  const r = roles(c);
  const data = query.data;
  const openProject = (key: string) => {
    setOpened(key);
    setView("project");
    onFocus?.(key);
  };
  const backToList = () => {
    setView("list");
    onFocus?.(null);
  };
  if (view === "project" && opened && edit)
    return (
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingBottom: inset, maxWidth: 780 }}
        keyboardShouldPersistTaps="handled"
      >
        <ProjectEditor
          c={c}
          compact={compact}
          projectKey={opened}
          data={data}
          error={query.error}
          refetch={query.refetch}
          actions={edit}
          onBack={backToList}
          onOpenProject={openProject}
        />
      </ScrollView>
    );
  const rows = data ? sortProjectRows(data.projects) : [];
  const shown = filterProjectRows(rows, filter);
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <ScrollView
        ref={scroll as never}
        onScroll={(event) => {
          offset.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={64}
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{
          paddingBottom: inset,
          maxWidth: 780,
          gap: space.sm,
        }}
      >
        <View style={{ ...row, flexWrap: "nowrap" }}>
          <Text
            accessibilityRole="header"
            style={{
              color: r.foreground,
              fontWeight: "600",
              fontSize: type.section.fontSize,
              lineHeight: type.section.lineHeight,
              flex: 1,
            }}
          >
            Projects
          </Text>
          {data && Boolean(query.error) && (
            <ProblemIcon
              c={c}
              name="Projects"
              problems={[
                `Couldn't refresh projects: ${withoutHostPaths(errorText(query.error))}`,
              ]}
              color={r.warning}
            />
          )}
        </View>
        {!data && query.isPending && (
          <Text style={muted(c)}>Loading projects…</Text>
        )}
        {!data && Boolean(query.error) && (
          <View style={{ gap: space.xs, alignItems: "flex-start" }}>
            <Text
              accessibilityRole="alert"
              style={{ color: r.danger, fontSize: type.body.fontSize }}
            >
              Couldn't load projects
            </Text>
            <Text style={{ ...muted(c), fontSize: type.metadata.fontSize }}>
              {withoutHostPaths(errorText(query.error))}
            </Text>
            <Button
              small
              c={c}
              text="Retry"
              label="Retry projects"
              onPress={() => void query.refetch()}
            />
          </View>
        )}
        {data && rows.length >= PROJECT_FILTER_MIN && (
          <Field
            c={c}
            label=""
            a11yLabel="Filter projects"
            placeholder="Filter"
            value={filter}
            onChange={setFilter}
          />
        )}
        {data && (
          <View>
            {!rows.length && (
              <Text
                style={{
                  ...muted(c),
                  paddingVertical: space.sm,
                  paddingHorizontal: space.sm,
                }}
              >
                No projects
              </Text>
            )}
            {rows.length > 0 && !shown.length && (
              <Text
                style={{
                  ...muted(c),
                  paddingVertical: space.sm,
                  paddingHorizontal: space.sm,
                }}
              >
                No projects match
              </Text>
            )}
            {shown.map((entry) => (
              <ProjectRow
                key={entry.project.key}
                c={c}
                entry={entry}
                onOpen={edit ? () => openProject(entry.project.key) : undefined}
                archive={() => query.refetch()}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
