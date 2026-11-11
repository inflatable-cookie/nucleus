import { errorText } from "./error-text";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "./shell";
import { ActionButton, Button, Dialog, DropdownSelect, Field, HelpPanel, muted, row, type Colors } from "./controls";
import { roles, space, touchSlop, touchTarget, type } from "./design";
import { Popover } from "./popover";
import { ProjectEditor, type ProjectEditActions } from "./project-editor";
import { OWNER_NAME, folderName, identityOf, implicitRepositories, projectKeyFor, repositoryLabel, withoutHostPaths, type ProjectRepository } from "./project-helpers";
import { type Project, type ProjectSettings, type ProjectSettingsRow, type ProjectUpsertInput } from "../shared/contracts";

/*
 * Settings → Projects (lane `nucleus-ui`, "Projects in Settings, replacing
 * Repositories", build task 2): the list of projects with one problem icon per
 * row, and the Add project sheet. Everything reads from the
 * one `project.settings` read; writes stay on the existing RPCs. A row opens
 * the project (build task 3, `project-editor.tsx`).
 */

/** The filter field appears only above this many rows. */
export const PROJECT_FILTER_MIN = 13;
export { implicitRepositories, projectKeyFor, repositoryLabel, withoutHostPaths } from "./project-helpers";

/** Parked sorts last; names compare without case. */
export function sortProjectRows(rows: readonly ProjectSettingsRow[]): ProjectSettingsRow[] {
  return [...rows].sort((a, b) =>
    Number(a.project.visibility === "parked") - Number(b.project.visibility === "parked")
    || a.project.name.localeCompare(b.project.name, undefined, { sensitivity: "base" })
    || a.project.key.localeCompare(b.project.key));
}

/** Rows whose name, or a repository's `owner/name`, contains the filter text. */
export function filterProjectRows(rows: readonly ProjectSettingsRow[], filter: string): ProjectSettingsRow[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(entry => entry.project.name.toLowerCase().includes(needle)
    || entry.repositories.some(repo => (repo.repository.origin ?? "").toLowerCase().includes(needle)));
}

const OTHER = "__other__";

/**
 * A row's problem icon: one icon however many problems, its tooltip listing them
 * worst first in the popover layer. Hover, focus and press open it.
 */
function ProblemIcon({ c, name, problems, color }: { c: Colors; name: string; problems: readonly string[]; color: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  const text = problems.join("\n");
  return <View ref={anchor}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${name} problems`} accessibilityHint={problems.join(". ")} accessibilityState={{ expanded: open }}
      onHoverIn={() => setOpen(true)} onHoverOut={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onPress={() => setOpen(was => !was)}
      hitSlop={touchSlop(20)} style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}>
      <Icon name="TriangleAlert" size={16} color={color} />
    </Pressable>
    {open && <Popover anchor={anchor} align="end" pointerEvents="none" maxWidth={320} inlineStyle={{ top: "100%", right: 0, marginTop: space.xxs }}>
      <HelpPanel c={c} label={`${name} problems`} text={text} />
    </Popover>}
  </View>;
}

const statusWord = (entry: ProjectSettingsRow) => entry.project.visibility === "parked" ? "Parked" : "Active";

function ProjectRow({ c, entry, onOpen }: { c: Colors; entry: ProjectSettingsRow; onOpen?: () => void }) {
  const r = roles(c);
  const name = entry.project.name;
  const label = `${name}, ${statusWord(entry)}${entry.problems.length ? `, ${entry.problems.join(", ")}` : ""}`;
  const face = <>
    <Text numberOfLines={1} style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, flex: 1, minWidth: 0 }}>{name}</Text>
    <Text style={{ color: entry.project.visibility === "parked" ? r.muted : r.foreground, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{statusWord(entry)}</Text>
  </>;
  const faceStyle = { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, flex: 1, minWidth: 0, minHeight: touchTarget };
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, borderBottomWidth: 1, borderBottomColor: r.border }}>
    {onOpen
      ? <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Opens the project" onPress={onOpen} style={faceStyle}>{face}</Pressable>
      : <View accessibilityLabel={label} style={faceStyle}>{face}</View>}
    {/* A fixed slot, so status words line up whether or not a row has a problem. */}
    <View style={{ width: 20, alignItems: "center" }}>
      {entry.problems.length > 0 && <ProblemIcon c={c} name={name} problems={entry.problems} color={r.warning} />}
    </View>
  </View>;
}

export type ProjectsQuery = { data: ProjectSettings | undefined; error: unknown; isPending: boolean; refetch: () => unknown };

/**
 * The Projects section: the list. The list reads `project.settings`;
 * Add project writes `project.upsert`. A failed refresh keeps the rows it had,
 * with a warning on the header.
 */
export function ProjectsSection({ c, compact, inset, query, createProject, edit }: {
  c: Colors; compact: boolean; inset: number; query: ProjectsQuery;
  createProject: (input: ProjectUpsertInput) => Promise<unknown>;
  /** The opened project's writes; without them rows do not open. */
  edit?: ProjectEditActions;
}) {
  const [view, setView] = useState<"list" | "project">("list");
  const [opened, setOpened] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const scroll = useRef<{ scrollTo?: (to: { y: number; animated: boolean }) => void } | null>(null);
  const offset = useRef(0);
  // Back returns to the list where it was.
  useEffect(() => { if (view === "list" && offset.current) scroll.current?.scrollTo?.({ y: offset.current, animated: false }); }, [view]);
  const r = roles(c);
  const data = query.data;
  if (view === "project" && opened && edit) return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: inset, maxWidth: 780 }} keyboardShouldPersistTaps="handled">
    <ProjectEditor c={c} compact={compact} projectKey={opened} data={data} error={query.error} refetch={query.refetch} actions={edit} onBack={() => setView("list")} onOpenProject={setOpened} />
  </ScrollView>;
  const rows = data ? sortProjectRows(data.projects) : [];
  const shown = filterProjectRows(rows, filter);
  return <View style={{ flex: 1, minHeight: 0 }}>
    <ScrollView ref={scroll as never} onScroll={event => { offset.current = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={64}
      style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: inset, maxWidth: 780, gap: space.sm }}>
      <View style={{ ...row, flexWrap: "nowrap" }}>
        <Text accessibilityRole="header" style={{ color: r.foreground, fontWeight: "600", fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, flex: 1 }}>Projects</Text>
        {data && Boolean(query.error) && <ProblemIcon c={c} name="Projects" problems={[`Couldn't refresh projects: ${withoutHostPaths(errorText(query.error))}`]} color={r.warning} />}
        <ActionButton c={c} action="add" label="Add project" disabled={!data} onPress={() => setAdding(true)} />
      </View>
      {!data && query.isPending && <Text style={muted(c)}>Loading projects…</Text>}
      {!data && Boolean(query.error) && <View style={{ gap: space.xs, alignItems: "flex-start" }}>
        <Text accessibilityRole="alert" style={{ color: r.danger, fontSize: type.body.fontSize }}>Couldn't load projects</Text>
        <Text style={{ ...muted(c), fontSize: type.metadata.fontSize }}>{withoutHostPaths(errorText(query.error))}</Text>
        <Button small c={c} text="Retry" label="Retry projects" onPress={() => void query.refetch()} />
      </View>}
      {data && rows.length >= PROJECT_FILTER_MIN && <Field c={c} label="" a11yLabel="Filter projects" placeholder="Filter" value={filter} onChange={setFilter} />}
      {data && <View style={{ borderTopWidth: 1, borderTopColor: r.border }}>
        {!rows.length && <Text style={{ ...muted(c), paddingVertical: space.sm, paddingHorizontal: space.sm }}>No projects</Text>}
        {rows.length > 0 && !shown.length && <Text style={{ ...muted(c), paddingVertical: space.sm, paddingHorizontal: space.sm }}>No projects match</Text>}
        {shown.map(entry => <ProjectRow key={entry.project.key} c={c} entry={entry} onOpen={edit ? () => { setOpened(entry.project.key); setView("project"); } : undefined} />)}
      </View>}
    </ScrollView>
    {adding && data && <AddProjectSheet c={c} rows={data.projects} onClose={() => setAdding(false)}
      onCreate={async input => { await createProject(input); setAdding(false); }} />}
  </View>;
}


/**
 * Add project: a dialog that writes only on Create,
 * since a project with no repositories cannot exist. The key is derived from the
 * name and never shown. A refusal reads under the title in the server's words.
 */
export function AddProjectSheet({ c, rows, onClose, onCreate }: {
  c: Colors; rows: readonly ProjectSettingsRow[]; onClose: () => void;
  onCreate: (input: ProjectUpsertInput) => Promise<void>;
}) {
  const r = roles(c);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<ProjectRepository[]>([]);
  const [other, setOther] = useState<string | null>(null);
  const [refusal, setRefusal] = useState("");
  const [busy, setBusy] = useState(false);
  const offered = implicitRepositories(rows).filter(repo => !chosen.some(pick => identityOf(pick) === identityOf(repo)));
  const options = [...offered.map(repo => ({ value: identityOf(repo), label: repositoryLabel(repo) })), { value: OTHER, label: "Other…" }];
  const add = (repo: ProjectRepository) => setChosen(list => list.some(pick => identityOf(pick) === identityOf(repo)) ? list : [...list, repo]);
  const choose = (value: string) => {
    if (value === OTHER) { setOther(""); return; }
    const repo = offered.find(candidate => identityOf(candidate) === value);
    if (repo) add(repo);
  };
  const otherValid = other !== null && OWNER_NAME.test(other.trim());
  const addOther = () => {
    if (!otherValid) return;
    const origin = other!.trim();
    // A typed origin that is already a known repository takes its record, path hint included.
    const known = implicitRepositories(rows).find(repo => repo.origin?.toLowerCase() === origin.toLowerCase());
    add(known ?? { origin, path: "" });
    setOther(null);
  };
  const ready = name.trim().length > 0 && chosen.length > 0 && !busy;
  const create = async () => {
    if (!ready) return;
    setBusy(true); setRefusal("");
    try {
      const key = projectKeyFor(name.trim(), rows.map(entry => entry.project.key));
      await onCreate({ key, name: name.trim(), repositories: chosen, ...(chosen.length > 1 ? { primary: chosen[0] } : {}), create: true });
    } catch (error) { setRefusal(withoutHostPaths(errorText(error))); }
    finally { setBusy(false); }
  };
  return <Dialog c={c} title="Add project" label="Add project dialog" closeLabel="Close Add project" onClose={onClose} bodyLabel="Add project fields"
    footer={<View style={{ ...row, justifyContent: "flex-end" }}>
      <Button c={c} selected text={busy ? "Creating…" : "Create"} label="Create project" disabled={!ready} onPress={() => void create()} />
    </View>}>
    {refusal ? <Text accessibilityRole="alert" style={{ color: r.danger, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>{refusal}</Text> : null}
    <Field c={c} label="Name" value={name} onChange={setName} />
    <View style={{ gap: space.xs }}>
      <DropdownSelect c={c} label="Repositories" value="" placeholder="Choose" options={options} onChange={choose} />
      {other !== null && <View style={{ ...row, flexWrap: "nowrap", alignItems: "flex-end" }}>
        <View style={{ flex: 1, minWidth: 0 }}><Field c={c} label="Repository" a11yLabel="Other repository (owner/name)" placeholder="owner/name" value={other} onChange={setOther} /></View>
        <ActionButton c={c} action="add" label="Add repository" disabled={!otherValid} onPress={addOther} />
      </View>}
      {chosen.map((repo, index) => {
        const label = repositoryLabel(repo);
        return <View key={identityOf(repo)} accessibilityLabel={`${label}${index === 0 ? ", primary" : ""}`} style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touchTarget }}>
          <Text numberOfLines={1} style={{ color: r.foreground, fontSize: type.body.fontSize, flexShrink: 1, minWidth: 0 }}>{label}</Text>
          {index === 0
            ? <Icon name="Star" size={14} color={r.accent} />
            : <ActionButton c={c} action="primary" label={`Make ${label} primary`} onPress={() => setChosen(list => [repo, ...list.filter(pick => pick !== repo)])} />}
          <View style={{ flex: 1 }} />
          <ActionButton c={c} action="remove" label={`Remove ${label}`} onPress={() => setChosen(list => list.filter(pick => pick !== repo))} />
        </View>;
      })}
    </View>
  </Dialog>;
}
