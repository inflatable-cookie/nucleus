import { errorText } from "./error-text";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "./shell";
import { ActionButton, Button, DropdownSelect, Field, FieldCaption, InlineConfirm, NumberStepper, muted, row, type Colors } from "./controls";
import { roles, space, type } from "./design";
import { ProjectManagementView } from "./project-management-view";
import { identityOf, withoutHostPaths, type ProjectRepository } from "./project-helpers";
import {
  type Project, type ProjectSettings, type ProjectSettingsRow, type ProjectUpsertInput,
} from "../shared/contracts";
import { AddRepository, AgentsSection, MoveIntoPanel, MoveRepositoryConfirm, Pair, RepositoryBlock, SaveWord, useProjectSaves, type OwnerCandidate, type ProjectEditActions } from "./project-editor/index";
export type { OwnerCandidate, ProjectEditActions } from "./project-editor/index";

/*
 * Settings → Projects → an opened project (lane `nucleus-ui`, "Projects in
 * Settings", build task 3, as amended by Tom's rulings of 2026-11-08): name,
 * planner, Slots only (in flight is always twice the slots), park/unpark, Remove
 * (build task 4: the scoped removal sheet behind the trash icon) and the
 * repositories with their settings. Every field autosaves through one ordered
 * queue per project; writes stay on `project.upsert`, `project.set-planner`,
 * `queue.project-dispatch-limit`, `project.park`/`unpark`, `repository.set`,
 * `project.remove-repository` (nucleus#967) and `project.merge` (nucleus#969:
 * Move into, and Add repository taking a repository out of another project).
 */

const SLOTS_HELP = "Empty uses the Per project limit. A project may have twice its slots in flight.";
const NONE = "__none__", OTHER = "__other__";
export function plannerOptions(entry: ProjectSettingsRow, candidates: readonly OwnerCandidate[] | undefined, chosen: string | null) {
  const planners = (candidates ?? []).filter(candidate => candidate.kind === "planner");
  const options = [{ value: NONE, label: "None" }, ...planners.map(candidate => ({ value: candidate.id, label: candidate.title.trim() || candidate.id }))];
  for (const id of new Set([entry.project.planner?.agentId, chosen].filter((id): id is string => Boolean(id)))) {
    if (planners.some(candidate => candidate.id === id)) continue;
    const live = candidates?.find(candidate => candidate.id === id);
    const gone = candidates ? !live : id === entry.project.planner?.agentId && entry.plannerLive === false;
    options.push({ value: id, label: live ? live.title.trim() || id : gone ? "Gone" : id });
  }
  return options;
}

export function ProjectEditor({ c, compact = false, projectKey, data, error, refetch, actions, onBack, onOpenProject }: {
  c: Colors; compact?: boolean; projectKey: string; data: ProjectSettings | undefined; error: unknown; refetch: () => unknown;
  actions: ProjectEditActions; onBack: () => void; /** Opens another project: where Move into lands. */ onOpenProject?: (key: string) => void;
}) {
  const r = roles(c);
  const entry = data?.projects.find(candidate => candidate.project.key === projectKey);
  const back = <Button small c={c} icon="ChevronLeft" text="Projects" label="Back to Projects" onPress={onBack} />;
  if (!entry) return <View style={{ gap: space.sm }}>
    <View style={{ ...row, flexWrap: "nowrap" }}>{back}</View>
    {data ? <Text style={muted(c)}>This project no longer exists.</Text>
      : error ? <LoadFailure c={c} name="the project" error={error} refetch={refetch} />
      : <Text style={muted(c)}>Loading…</Text>}
  </View>;
  return <OpenedProject key={projectKey} c={c} compact={compact} entry={entry} data={data!} error={error} refetch={refetch} actions={actions} back={back} onBack={onBack} onOpenProject={onOpenProject} r={r} />;
}

function LoadFailure({ c, name, error, refetch }: { c: Colors; name: string; error: unknown; refetch: () => unknown }) {
  return <View style={{ gap: space.xs, alignItems: "flex-start" }}>
    <Text accessibilityRole="alert" style={{ color: roles(c).danger, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>Couldn't load {name}</Text>
    <Text style={{ ...muted(c), fontSize: type.metadata.fontSize }}>{withoutHostPaths(errorText(error))}</Text>
    <Button small c={c} text="Retry" label={`Retry ${name}`} onPress={() => void refetch()} />
  </View>;
}

function OpenedProject({ c, compact, entry, data, error, refetch, actions, back, onBack, onOpenProject, r }: {
  c: Colors; compact: boolean; entry: ProjectSettingsRow; data: ProjectSettings; error: unknown; refetch: () => unknown;
  actions: ProjectEditActions; back: React.ReactNode; onBack: () => void; onOpenProject?: (key: string) => void; r: ReturnType<typeof roles>;
}) {
  const project = entry.project;
  const saves = useProjectSaves(actions.refresh);
  // Fields stay, never blank, but take no edits while the project could not be re-read.
  const disabled = Boolean(error);
  const [name, setName] = useState(project.name);
  const [members, setMembers] = useState<ProjectRepository[]>(project.repositories);
  const [planner, setPlanner] = useState<string | null>(project.planner?.agentId ?? null);
  const [slots, setSlots] = useState<number | null>(entry.slots.override);
  const [parking, setParking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState<{ repo: ProjectRepository; source: Project } | null>(null);
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  // Writes read the newest draft when they run, so a rename and a repository change
  // queued together never undo each other; versions follow every reply.
  const draft = useRef({ name, members }); draft.current = { name, members };
  const version = useRef(project.version); version.current = Math.max(version.current, project.version);
  const took = (result: Project) => { version.current = Math.max(version.current, result.version); return result; };
  // The server's values come back only when nothing is waiting, so a re-read after one save never replaces a newer draft.
  const serverMembers = JSON.stringify(project.repositories);
  useEffect(() => {
    if (!saves.quiet()) return;
    setName(project.name); setMembers(project.repositories);
    setPlanner(project.planner?.agentId ?? null); setSlots(entry.slots.override);
  }, [saves.landed, project.name, serverMembers, project.planner?.agentId, entry.slots.override]);

  // A repository change while the name is held back (empty) keeps the stored name.
  const storedName = useRef(project.name); storedName.current = project.name;
  const projectInput = (): ProjectUpsertInput => {
    const { name: nextName, members: list } = draft.current;
    const trimmed = nextName.trim();
    return { key: project.key, name: trimmed && trimmed.length <= 200 ? trimmed : storedName.current, repositories: list, ...(list.length > 1 ? { primary: list[0] } : {}) };
  };
  const saveProject = (delay = 0) => saves.queue("project", { run: () => actions.saveProject(projectInput()).then(took) }, delay);
  const rename = (text: string) => {
    setName(text);
    // Held under "name", not "project": a repository change queues "project" and must not clear the name's reason.
    if (!text.trim()) { saves.hold("name", "Name is empty"); return; }
    if (text.trim().length > 200) { saves.hold("name", "Name is over 200 characters"); return; }
    saves.release("name");
    saveProject(600);
  };
  const changeMembers = (list: ProjectRepository[]) => { setMembers(list); draft.current = { ...draft.current, members: list }; saveProject(); };
  // Remove from Nucleus runs in the same ordered queue, so an earlier upsert lands first and its
  // version is the one checked; the row goes once the server step has landed (nucleus#967).
  const removeFromNucleus = (repo: ProjectRepository) => {
    const id = identityOf(repo);
    setOpenRepo(null);
    saves.queue(`remove:${id}`, { run: () => actions.removeRepository({ key: project.key, version: version.current, repository: id, reason: `Removed from ${storedName.current} in Settings` })
      .then(result => {
        took(result.project);
        const rest = draft.current.members.filter(other => identityOf(other) !== id);
        draft.current = { ...draft.current, members: rest };
        setMembers(rest);
      }) });
  };
  // Move into: queued behind any pending edit, then the target opens; this project is gone (nucleus#969).
  const moveInto = (target: Project) => {
    setMoving(false);
    saves.queue("merge", { run: () => actions.merge({ source: project.key, target: target.key, versions: { source: version.current, target: target.version }, reason: `Moved into ${target.name} in Settings` })
      .then(result => { if (onOpenProject) onOpenProject(result.project.key); else onBack(); }) });
  };
  // Add repository from another project: the repository (or its whole project) moves here in one server step.
  const moveHere = (source: Project, repository?: string) => {
    setAdding(null);
    saves.queue(`merge:${source.key}`, { run: () => actions.merge({ source: source.key, target: project.key, versions: { source: source.version, target: version.current },
      ...(repository ? { repository } : {}), reason: `Added to ${storedName.current} in Settings` })
      .then(result => {
        took(result.project);
        const moved = result.project.repositories.filter(repo => !draft.current.members.some(member => identityOf(member) === identityOf(repo)));
        const next = [...draft.current.members, ...moved];
        draft.current = { ...draft.current, members: next };
        setMembers(next);
      }) });
  };
  const choosePlanner = (value: string) => {
    const agentId = value === NONE ? null : value;
    setPlanner(agentId);
    saves.queue("planner", { run: () => actions.setPlanner({ key: project.key, agentId }).then(took) });
  };
  const changeSlots = (next: number | null) => {
    setSlots(next);
    saves.queue("slots", { run: () => actions.setSlots({ projectKey: project.key, limit: next }) }, next === null ? 0 : 600);
  };
  const toggleParked = () => {
    const parked = project.visibility === "parked";
    setParking(false);
    saves.queue("visibility", { run: () => (parked ? actions.unpark : actions.park)({ key: project.key, version: version.current }).then(took) });
  };
  const parked = project.visibility === "parked";
  const candidates = actions.candidates;
  const single = members.length === 1;
  const others = data.projects.map(item => item.project).filter(other => other.key !== project.key);
  // Another project that also holds this repository goes too when it is removed from Nucleus (nucleus#969).
  const alsoIn = (repo: ProjectRepository) => others.find(other => other.repositories.some(member => identityOf(member) === identityOf(repo)))?.name;
  const settingsFor = (repo: ProjectRepository) => entry.repositories.find(item => identityOf(item.repository) === identityOf(repo))?.settings ?? null;

  return <View accessibilityLabel={`${project.name} project`} style={{ gap: space.sm }}>
    <View style={{ ...row, flexWrap: "nowrap" }}>
      {back}
      <View style={{ flex: 1 }} />
      <ActionButton c={c} action={parked ? "resume" : "pause"} label={`${parked ? "Unpark" : "Park"} ${project.name}`}
        disabled={disabled || parking} onPress={() => parked ? toggleParked() : setParking(true)} />
      <ActionButton c={c} action="moveInto" label={`Move ${project.name} into another project`} disabled={disabled || moving} onPress={() => setMoving(true)} />
      {actions.removal && <ActionButton c={c} action="remove" label={`Remove ${project.name}`} disabled={disabled} onPress={() => setRemoving(true)} />}
    </View>
    {removing && actions.removal && <ProjectManagementView c={c} project={project} rpc={actions.removal}
      onClose={() => setRemoving(false)}
      onRemoved={() => { setRemoving(false); void actions.refresh().catch(() => { void refetch(); }); onBack(); }} />}
    <View style={{ ...row, flexWrap: "nowrap" }}>
      <Text accessibilityRole="header" numberOfLines={2} style={{ color: r.foreground, fontWeight: "600", fontSize: type.page.fontSize, lineHeight: type.page.lineHeight, flex: 1, minWidth: 0 }}>{project.name}</Text>
      {parked && <Text style={{ color: r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>Parked</Text>}
      <SaveWord c={c} status={saves.status} name={project.name} />
    </View>
    {moving && <MoveIntoPanel c={c} project={project} others={others} check={() => actions.mergeCheck({ source: project.key })} onMove={moveInto} onCancel={() => setMoving(false)} />}
    {parking && <InlineConfirm c={c} question={`Park ${project.name}? No new work starts.`} confirmLabel="Park" label={`project ${project.name}`} onConfirm={toggleParked} onCancel={() => setParking(false)} />}
    {disabled && <LoadFailure c={c} name={project.name} error={error} refetch={refetch} />}
    <Pair>
      <Field c={c} label="Name" a11yLabel="Project name" value={name} disabled={disabled} onChange={rename} onBlur={saves.flush} />
      <View style={{ gap: space.xs }}>
        <DropdownSelect c={c} label="Planner" value={planner ?? NONE} disabled={disabled} options={plannerOptions(entry, candidates.data, planner)} onChange={choosePlanner} />
        {Boolean(candidates.error) && <Text style={{ color: r.warning, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>Couldn't load threads</Text>}
      </View>
    </Pair>
    <View style={{ gap: space.xxs }}>
      <FieldCaption c={c} text="Slots" help={SLOTS_HELP} />
      <View style={{ flexDirection: "row" }}>
        <NumberStepper c={c} a11yLabel={`Slots for ${project.name}`} value={slots} placeholder={data.defaultSlots} min={0} max={64} disabled={disabled}
          onChange={changeSlots} onClear={() => changeSlots(null)} onCommit={saves.flush} />
      </View>
    </View>
    <AgentsSection c={c} project={project} agents={entry.agents ?? []} disabled={disabled} actions={actions} r={r} />
    <View style={{ gap: space.xs, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: r.border }}>
      <View style={{ ...row, flexWrap: "nowrap" }}>
        <Text accessibilityRole="header" style={{ color: r.foreground, fontWeight: "600", fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, flex: 1 }}>Repositories</Text>
        <AddRepository c={c} rows={data.projects} projectKey={project.key} members={members} disabled={disabled}
          onAdd={repo => changeMembers([...members, repo])} onMove={(repo, source) => setAdding({ repo, source })} />
      </View>
      {adding && <MoveRepositoryConfirm key={`${adding.source.key}:${identityOf(adding.repo)}`} c={c} repo={adding.repo} source={adding.source} target={project.name}
        check={() => actions.mergeCheck({ source: adding.source.key })}
        onMoveRepository={() => moveHere(adding.source, identityOf(adding.repo))} onMoveProject={() => moveHere(adding.source)} onCancel={() => setAdding(null)} />}
      {members.map((repo, index) => {
        const id = identityOf(repo);
        const open = single || openRepo === id;
        return <RepositoryBlock key={id} c={c} repo={repo} primary={index === 0} single={single} open={open} disabled={disabled}
          settings={settingsFor(repo)} saves={saves} setRepository={actions.setRepository}
          onToggle={() => setOpenRepo(open ? null : id)}
          onPrimary={() => changeMembers([repo, ...members.filter(other => identityOf(other) !== id)])}
          checkBlockers={() => actions.repositoryBlockers({ key: project.key, repository: id })}
          onSeparate={() => { setOpenRepo(null); changeMembers(members.filter(other => identityOf(other) !== id)); }}
          alsoDeletes={alsoIn(repo)} onRemoveFromNucleus={() => removeFromNucleus(repo)} />;
      })}
    </View>
  </View>;
}
