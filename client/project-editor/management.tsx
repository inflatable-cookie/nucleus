import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../shell";
import { ActionButton, Button, DropdownSelect, Field, row, type Colors } from "../controls";
import { radius, roles, space, touchTarget, type } from "../design";
import { OWNER_NAME, identityOf, implicitRepositories, repositoryLabel, type ProjectRepository } from "../project-helpers";
import type { Project, ProjectSettingsRow, RepositorySettings } from "../../shared/contracts";
import { RepositoryFields } from "./repository-fields";
import type { ProjectEditActions, ProjectSaves } from "./types";

const OTHER = "__other__";

/**
 * [+]: repositories still in implicit projects (added as a member), repositories
 * of other projects (labelled with their project; picking one asks how to move
 * it, nucleus#969), and "Other…" for an `owner/name`.
 */
export function AddRepository({ c, rows, projectKey, members, disabled, onAdd, onMove }: {
  c: Colors; rows: readonly ProjectSettingsRow[]; projectKey: string; members: readonly ProjectRepository[]; disabled: boolean;
  onAdd: (repo: ProjectRepository) => void; onMove: (repo: ProjectRepository, source: Project) => void;
}) {
  const [other, setOther] = useState<string | null>(null);
  const known = implicitRepositories(rows);
  const absent = (repo: ProjectRepository) => !members.some(member => identityOf(member) === identityOf(repo));
  const offered = known.filter(absent);
  const implicitIds = new Set(known.map(identityOf));
  const elsewhere = rows.filter(entry => entry.project.key !== projectKey)
    .flatMap(entry => entry.project.repositories.filter(repo => absent(repo) && !implicitIds.has(identityOf(repo))).map(repo => ({ repo, source: entry.project })))
    .sort((a, b) => repositoryLabel(a.repo).localeCompare(repositoryLabel(b.repo), undefined, { sensitivity: "base" }));
  const valid = other !== null && OWNER_NAME.test(other.trim())
    && !members.some(member => member.origin?.toLowerCase() === other.trim().toLowerCase());
  const choose = (value: string) => {
    if (value === OTHER) { setOther(""); return; }
    const repo = offered.find(candidate => identityOf(candidate) === value);
    if (repo) { onAdd(repo); return; }
    const moved = elsewhere.find(candidate => `${candidate.source.key}\0${identityOf(candidate.repo)}` === value);
    if (moved) onMove(moved.repo, moved.source);
  };
  const addOther = () => {
    if (!valid) return;
    const origin = other!.trim().toLowerCase();
    const moved = elsewhere.find(candidate => candidate.repo.origin?.toLowerCase() === origin);
    if (moved) onMove(moved.repo, moved.source);
    else onAdd(known.find(repo => repo.origin?.toLowerCase() === origin) ?? { origin: other!.trim(), path: "" });
    setOther(null);
  };
  return <View style={{ alignItems: "flex-end", gap: space.xs, flexShrink: 1 }}>
    <DropdownSelect compact c={c} label="Add repository" value="" placeholder="+" minWidth={52} disabled={disabled}
      options={[...offered.map(repo => ({ value: identityOf(repo), label: repositoryLabel(repo) })),
        ...elsewhere.map(({ repo, source }) => ({ value: `${source.key}\0${identityOf(repo)}`, label: `${repositoryLabel(repo)} · ${source.name}` })),
        { value: OTHER, label: "Other…" }]} onChange={choose} />
    {other !== null && <View style={{ ...row, flexWrap: "nowrap", alignItems: "flex-end" }}>
      <View style={{ width: 220, maxWidth: "100%" }}><Field c={c} label="" hideLabel a11yLabel="Other repository (owner/name)" placeholder="owner/name" value={other} onChange={setOther} /></View>
      <ActionButton c={c} action="add" label="Add other repository" disabled={!valid} onPress={addOther} />
      <ActionButton c={c} action="close" label="Cancel other repository" onPress={() => setOther(null)} />
    </View>}
  </View>;
}

/**
 * One repository: a one-line row (`owner/name`, ★ on the primary). With one
 * repository its settings show inline; with several one opens at a time and holds
 * ★ to make it primary and ✕ to remove it (Separate project or Remove from Nucleus;
 * the primary can't go until ★ moves).
 */
export function RepositoryBlock({ c, repo, primary, single, open, disabled, settings, saves, setRepository, onToggle }: {
  c: Colors; repo: ProjectRepository; primary: boolean; single: boolean; open: boolean; disabled: boolean;
  settings: RepositorySettings | null; saves: ProjectSaves; setRepository: ProjectEditActions["setRepository"];
  onToggle: () => void;
}) {
  const r = roles(c);
  const label = repositoryLabel(repo);
  const title = <>
    <Text numberOfLines={1} style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, fontWeight: "600", flexShrink: 1, minWidth: 0 }}>{label}</Text>
    {primary && <Icon name="Star" size={14} color={r.accent} />}
  </>;
  return <View style={{ gap: space.sm, ...(single ? {} : { borderRadius: radius.card, backgroundColor: open ? r.section : "transparent", paddingHorizontal: space.sm, paddingBottom: open ? space.sm : 0 }) }}>
    {single
      ? <View accessibilityLabel={`${label}${primary ? ", primary" : ""}`} style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touchTarget }}>{title}</View>
      : <Pressable accessibilityRole="button" accessibilityLabel={`${label}${primary ? ", primary" : ""}`} accessibilityState={{ expanded: open }} onPress={onToggle}
          style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touchTarget }}>
          {title}
          <View style={{ flex: 1 }} />
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={16} color={r.muted} />
        </Pressable>}
    {open && <RepositoryFields c={c} repo={repo} label={label} settings={settings} disabled={disabled} saves={saves} setRepository={setRepository} />}
  </View>;
}


const note = { fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight };

/**
 * Add repository picked a repository of another project (nucleus#969): it moves here
 * in one server step, and the project it leaves keeps its name and other repositories.
 */
export function MoveRepositoryConfirm({ c, repo, source, target, onMoveRepository, onCancel }: {
  c: Colors; repo: ProjectRepository; source: Project; target: string;
  onMoveRepository: () => void; onCancel: () => void;
}) {
  const r = roles(c);
  const label = repositoryLabel(repo);
  return <View accessibilityRole="alert" accessibilityLabel={`Add ${label} from ${source.name}`} style={{ gap: space.xs }}>
    <Text style={{ color: r.warning, ...note }}>
      {`Move ${label} from ${source.name} to ${target}?`}
    </Text>
    <View style={row}>
      <Button small c={c} text="Move repository" label={`Move ${label} into ${target}`} onPress={onMoveRepository} />
      <Button small c={c} text="Cancel" label={`Cancel moving ${label}`} onPress={onCancel} />
    </View>
  </View>;
}
