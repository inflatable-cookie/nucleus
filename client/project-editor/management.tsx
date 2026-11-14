import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../shell";
import { ActionButton, Button, DropdownSelect, Field, HelpPopover, HelpTip, InlineConfirm, NumberStepper, muted, row, type Colors } from "../controls";
import { radius, roles, space, touchTarget, type } from "../design";
import { projectCarriedText, projectRemovalBlockerText } from "../../shared/project-removal";
import { errorText } from "../error-text";
import { OWNER_NAME, identityOf, implicitRepositories, repositoryLabel, withoutHostPaths, type ProjectRepository } from "../project-helpers";
import type { Project, ProjectMergeCheck, ProjectRemovalBlocker, ProjectSettingsRow, RepositorySetInput, RepositorySettings } from "../../shared/contracts";
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
export function RepositoryBlock({ c, repo, primary, single, open, disabled, settings, saves, setRepository, onToggle, onPrimary, checkBlockers, onSeparate, alsoDeletes, onRemoveFromNucleus }: {
  c: Colors; repo: ProjectRepository; primary: boolean; single: boolean; open: boolean; disabled: boolean;
  settings: RepositorySettings | null; saves: ProjectSaves; setRepository: ProjectEditActions["setRepository"];
  onToggle: () => void; onPrimary: () => void; checkBlockers: () => Promise<ProjectRemovalBlocker[]>; onSeparate: () => void; alsoDeletes?: string; onRemoveFromNucleus: () => void;
}) {
  const r = roles(c);
  const label = repositoryLabel(repo);
  const [confirming, setConfirming] = useState(false);
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
    {open && !single && <View style={{ ...row, justifyContent: "flex-end" }}>
      {!primary && <ActionButton c={c} action="primary" label={`Make ${label} primary`} disabled={disabled} onPress={onPrimary} />}
      <ActionButton c={c} action="remove" label={`Remove ${label}`} tip={primary ? "Move ★ to another repository first" : undefined} disabled={disabled || primary || confirming} onPress={() => setConfirming(true)} />
    </View>}
    {confirming && <RemoveRepositoryConfirm c={c} label={label} check={checkBlockers} alsoDeletes={alsoDeletes}
      onSeparate={() => { setConfirming(false); onSeparate(); }} onRemove={() => { setConfirming(false); onRemoveFromNucleus(); }} onCancel={() => setConfirming(false)} />}
    {open && <RepositoryFields c={c} repo={repo} label={label} settings={settings} disabled={disabled} saves={saves} setRepository={setRepository} />}
  </View>;
}

const REMOVE_HELP = "Separate project: it leaves this project and becomes a project of its own. Remove from Nucleus: it leaves this project and that project is deleted too. Task history stays readable either way. Open work blocks Remove from Nucleus.";

/**
 * The ✕'s confirmation (nucleus#967): Separate project, or Remove from Nucleus
 * (danger), which stays disabled while `project.removal-blockers` names anything
 * for this repository, worded as the refusal words it.
 */
export function RemoveRepositoryConfirm({ c, label, check, alsoDeletes, onSeparate, onRemove, onCancel }: {
  c: Colors; label: string; check: () => Promise<ProjectRemovalBlocker[]>; /** Another project holding this repository, which Remove from Nucleus deletes too. */ alsoDeletes?: string;
  onSeparate: () => void; onRemove: () => void; onCancel: () => void;
}) {
  const r = roles(c);
  const [help, setHelp] = useState(false);
  const anchor = useRef<View | null>(null);
  const { state, loading, blocked, why, retry } = useBlockerCheck(check);
  return <View accessibilityRole="alert" accessibilityLabel={`Remove ${label}`} style={{ gap: space.xs }}>
    <View ref={anchor} style={{ ...row, flexWrap: "nowrap" }}>
      <Text style={{ color: r.warning, ...note, flexShrink: 1, minWidth: 0 }}>Remove {label}?</Text>
      <HelpTip c={c} label="Remove repository" text={REMOVE_HELP} open={help} onOpenChange={setHelp} />
    </View>
    {help && <HelpPopover c={c} anchor={anchor} label="Remove repository" text={REMOVE_HELP} />}
    <View style={row}>
      <Button small c={c} text="Separate project" label={`Separate ${label} into its own project`} onPress={onSeparate} />
      <Button small danger c={c} text="Remove from Nucleus" label={`Remove ${label} from Nucleus`} disabled={Boolean(why)} hint={why} onPress={onRemove} />
      <Button small c={c} text="Keep" label={`Keep ${label}`} onPress={onCancel} />
    </View>
    {alsoDeletes && <Text style={{ color: r.warning, ...note }}>Remove from Nucleus also deletes project {alsoDeletes}.</Text>}
    <CheckStatus c={c} label={label} loading={loading} error={state.error} retry={retry} />
    {blocked ? <Text style={{ color: r.warning, ...note }}>Can't remove from Nucleus: {blocked}</Text> : null}
  </View>;
}

const note = { fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight };

/** One read of removal blockers, rerun by Retry; `why` is the disabled hint while loading, unreadable or blocked. */
function useBlockerCheck(check: () => Promise<ProjectRemovalBlocker[]>) {
  const [state, setState] = useState<{ blockers?: ProjectRemovalBlocker[]; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  const checkRef = useRef(check); checkRef.current = check;
  useEffect(() => {
    let alive = true;
    setState({});
    checkRef.current().then(blockers => { if (alive) setState({ blockers }); }, error => { if (alive) setState({ error: withoutHostPaths(errorText(error)) }); });
    return () => { alive = false; };
  }, [attempt]);
  const loading = !state.blockers && state.error === undefined;
  const blocked = state.blockers?.length ? projectRemovalBlockerText(state.blockers) : "";
  const why = loading ? "Checking open work…" : state.error !== undefined ? "Couldn't check open work" : blocked ? `Blocked by ${blocked}` : undefined;
  return { state, loading, blocked, why, retry: () => setAttempt(value => value + 1) };
}

/** One read of `project.merge-check`, rerun by Retry: `why` disables the move; `carried` counts what comes along (nucleus#984). */
function useMergeCheck(check: () => Promise<ProjectMergeCheck>) {
  const [state, setState] = useState<{ result?: ProjectMergeCheck; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  const checkRef = useRef(check); checkRef.current = check;
  useEffect(() => {
    let alive = true;
    setState({});
    checkRef.current().then(result => { if (alive) setState({ result }); }, error => { if (alive) setState({ error: withoutHostPaths(errorText(error)) }); });
    return () => { alive = false; };
  }, [attempt]);
  const loading = !state.result && state.error === undefined;
  const blocked = state.result?.blockers.length ? projectRemovalBlockerText(state.result.blockers) : "";
  const carried = state.result ? projectCarriedText(state.result.carried) : "";
  const why = loading ? "Checking open work…" : state.error !== undefined ? "Couldn't check open work" : blocked ? `Blocked by ${blocked}` : undefined;
  return { state, loading, blocked, carried, why, retry: () => setAttempt(value => value + 1) };
}

function CheckStatus({ c, label, loading, error, retry }: { c: Colors; label: string; loading: boolean; error?: string; retry: () => void }) {
  return <>
    {loading && <Text accessibilityLiveRegion="polite" style={{ ...muted(c), ...note }}>Checking open work…</Text>}
    {error !== undefined && <View style={row}>
      <Text style={{ color: roles(c).warning, ...note, flexShrink: 1 }}>Couldn't check open work: {error}</Text>
      <Button small c={c} text="Retry" label={`Retry checking ${label}`} onPress={retry} />
    </View>}
  </>;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Move into (nucleus#969): pick a target; every repository of this project joins
 * it with its tasks, leads, papercuts and lanes, and this project goes. The
 * confirm counts what comes along; disabled with the reason only while
 * `project.merge-check` names a blocker (nucleus#984).
 */
export function MoveIntoPanel({ c, project, others, check, onMove, onCancel }: {
  c: Colors; project: Project; others: readonly Project[]; check: () => Promise<ProjectMergeCheck>; onMove: (target: Project) => void; onCancel: () => void;
}) {
  const r = roles(c);
  const [chosen, setChosen] = useState("");
  const { state, loading, blocked, carried, why, retry } = useMergeCheck(check);
  const choices = [...others].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const target = choices.find(other => other.key === chosen);
  const count = project.repositories.length;
  return <View accessibilityLabel={`Move ${project.name} into another project`} style={{ gap: space.xs, padding: space.sm, borderRadius: radius.card, backgroundColor: r.section }}>
    <DropdownSelect c={c} label="Move into" value={chosen} placeholder="Project" emptyText="No other project" options={choices.map(other => ({ value: other.key, label: other.name }))} onChange={setChosen} />
    {target && <Text accessibilityRole="alert" style={{ color: r.warning, ...note }}>
      Move {project.name} into {target.name}? {count === 1 ? "Its repository joins" : `Its ${count} repositories join`} {target.name}{carried ? ` with ${carried}` : ""}. {target.name}'s name, planner, slots and primary stay; {project.name}'s name, planner and slots are dropped.
    </Text>}
    <View style={row}>
      <Button small danger c={c} text="Move" label={target ? `Move ${project.name} into ${target.name}` : `Move ${project.name}`} disabled={!target || Boolean(why)} hint={why ?? (target ? undefined : "Choose a project")}
        onPress={() => target && onMove(target)} />
      <Button small c={c} text="Cancel" label={`Cancel moving ${project.name}`} onPress={onCancel} />
    </View>
    <CheckStatus c={c} label={project.name} loading={loading} error={state.error} retry={retry} />
    {blocked ? <Text style={{ color: r.warning, ...note }}>Can't move: {blocked}</Text> : null}
  </View>;
}

/**
 * Add repository picked a repository of another project (nucleus#969). Its only
 * repository: Move, and that project goes. One of several: Move repository (not
 * that project's primary) or Move whole project. Its records come along; only a
 * `project.merge-check` blocker disables the move (nucleus#984).
 */
export function MoveRepositoryConfirm({ c, repo, source, target, check, onMoveRepository, onMoveProject, onCancel }: {
  c: Colors; repo: ProjectRepository; source: Project; target: string; check: () => Promise<ProjectMergeCheck>;
  onMoveRepository: () => void; onMoveProject: () => void; onCancel: () => void;
}) {
  const r = roles(c);
  const label = repositoryLabel(repo);
  const { state, loading, blocked, carried, why, retry } = useMergeCheck(check);
  const sole = source.repositories.length === 1;
  const primary = identityOf(source.primary) === identityOf(repo);
  const rest = source.repositories.length - 1;
  return <View accessibilityRole="alert" accessibilityLabel={`Add ${label} from ${source.name}`} style={{ gap: space.xs }}>
    <Text style={{ color: r.warning, ...note }}>
      {sole
        ? `Move ${label} here${carried ? ` with ${carried}` : ""}? It's the only repository in ${source.name}, so ${source.name} goes: its name, planner and slots are dropped.`
        : `${label} is in ${source.name} with ${plural(rest, "other repository", "other repositories")}. Move just it, or all of ${source.name}? Moving all drops ${source.name}'s name, planner and slots.`}
    </Text>
    <View style={row}>
      {sole
        ? <Button small danger c={c} text="Move" label={`Move ${label} into ${target}`} disabled={Boolean(why)} hint={why} onPress={onMoveRepository} />
        : <>
            <Button small c={c} text="Move repository" label={`Move only ${label} into ${target}`} disabled={primary} hint={primary ? `${label} is ${source.name}'s primary: move ★ there first` : undefined} onPress={onMoveRepository} />
            <Button small danger c={c} text="Move whole project" label={`Move all of ${source.name} into ${target}`} disabled={Boolean(why)} hint={why} onPress={onMoveProject} />
          </>}
      <Button small c={c} text="Cancel" label={`Cancel moving ${label}`} onPress={onCancel} />
    </View>
    <CheckStatus c={c} label={source.name} loading={loading} error={state.error} retry={retry} />
    {blocked ? <Text style={{ color: r.warning, ...note }}>Can't move {source.name}: {blocked}</Text> : null}
  </View>;
}
