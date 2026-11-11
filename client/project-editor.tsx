import { errorText } from "./error-text";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "./shell";
import { ActionButton, Button, DropdownSelect, Field, FieldCaption, HelpPopover, HelpTip, InlineConfirm, NumberStepper, muted, row, useSectionAutoSave, type Colors } from "./controls";
import { radius, roles, space, touchTarget, type } from "./design";
import { ProjectManagementView, type ProjectManagementApi } from "./project-management-view";
import { projectCarriedText, projectRemovalBlockerText } from "../shared/project-removal";
import { OWNER_NAME, identityOf, implicitRepositories, joinCommand, repositoryLabel, splitCommand, withoutHostPaths, type ProjectRepository } from "./project-helpers";
import {
  PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES, PROJECT_QA_TIMEOUT_MAX_MS, VALIDATION_TIMEOUT_MAX_MS,
  type Project, type ProjectOwnerCandidateKind, type ProjectMergeCheck, type ProjectMergeInput, type ProjectMergeResult, type ProjectRemovalBlocker, type ProjectRemoveRepositoryInput, type ProjectSettings, type ProjectSettingsRow, type ProjectUpsertInput, type RepositorySetInput, type RepositorySettings,
} from "../shared/contracts";

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

export type OwnerCandidate = { id: string; title: string; workspaceId: string | null; kind: ProjectOwnerCandidateKind };
export type ProjectEditActions = {
  saveProject: (input: ProjectUpsertInput) => Promise<Project>;
  setPlanner: (input: { key: string; agentId: string | null }) => Promise<Project>;
  /** Null clears the override: the project inherits Per project again. */
  setSlots: (input: { projectKey: string; limit: number | null }) => Promise<unknown>;
  setRepository: (input: RepositorySetInput) => Promise<unknown>;
  park: (input: { key: string; version: number }) => Promise<Project>;
  unpark: (input: { key: string; version: number }) => Promise<Project>;
  /** One member's removal blockers (`project.removal-blockers` with `repository`). */
  repositoryBlockers: (input: { key: string; repository: string }) => Promise<ProjectRemovalBlocker[]>;
  /** Remove from Nucleus: out of the project and its one-repository project deleted, in one server step. */
  removeRepository: (input: ProjectRemoveRepositoryInput) => Promise<{ project: Project; tombstone: unknown }>;
  /** What stops a project moving into another, and what comes along (`project.merge-check`, nucleus#984). */
  mergeCheck: (input: { source: string }) => Promise<ProjectMergeCheck>;
  /** Move into, and Add repository from another project: one server step (`project.merge`). */
  merge: (input: ProjectMergeInput) => Promise<ProjectMergeResult>;
  /** Remove's preview, cancellation and delete calls; without them the trash icon is absent. */
  removal?: ProjectManagementApi;
  /** Re-read `project.settings` (and the board) after a batch of writes. */
  refresh: () => Promise<unknown>;
  candidates: { data: OwnerCandidate[] | undefined; error: unknown; isPending: boolean };
};

const CHECKS_HELP = "Required gates only the checks GitHub requires for the base branch; the rest are recorded as advisory. Needs GitHub's required-check settings to be readable for this repository.";
const REVIEWER_HELP = "Account that posts formal reviews. Its token stays in the login keychain.";
const MERGE_HELP = "Runs on every task's prospective merge.";
const STAGED_HELP = "A staged QA is edited with `nucleus repository.set`.";
const SLOTS_HELP = "Empty uses the Per project limit. A project may have twice its slots in flight.";
const QA_TIMEOUT_MAX_MIN = PROJECT_QA_TIMEOUT_MAX_MS / 60_000;
const MERGE_TIMEOUT_MAX_MIN = VALIDATION_TIMEOUT_MAX_MS / 60_000;
/** Shown, and written with a first command, when a repository has no timeout yet. */
const QA_TIMEOUT_DEFAULT_MIN = 60, MERGE_TIMEOUT_DEFAULT_MIN = 15, AFTER_MERGES_DEFAULT = 10;
const NONE = "__none__", OTHER = "__other__";
const minutes = (ms: number | undefined, fallback: number, max: number) => ms ? Math.min(max, Math.max(1, Math.round(ms / 60_000))) : fallback;

type SaveOp = { run: () => Promise<unknown>; revert?: () => void };
export type ProjectSaves = ReturnType<typeof useProjectSaves>;

/**
 * One ordered save queue per project, as Limits has: each field queues its own
 * write under a key (a newer edit replaces its pending write and moves to the
 * back), a 600 ms pause or a blur sends the batch in order, and the project is
 * re-read once after it. A refused write reverts the field that asked for it when
 * it can (Checks), and every refusal shows as "Not saved" with its reason.
 * A draft that cannot be sent (a bad login, an open quote) is held back with its
 * reason, without holding back anything else.
 */
function useProjectSaves(refresh: () => Promise<unknown>) {
  const pending = useRef(new Map<string, SaveOp>());
  const inFlight = useRef(false);
  // Bumped when a batch lands cleanly with nothing behind it: the moment fields may take the server's values again.
  const [landed, setLanded] = useState(0);
  const auto = useSectionAutoSave<number>(async () => {
    inFlight.current = true;
    const batch = [...pending.current.values()];
    pending.current.clear();
    const failures: string[] = [];
    try {
      for (const op of batch) {
        try { await op.run(); } catch (error) { op.revert?.(); failures.push(withoutHostPaths(errorText(error))); }
      }
      await refresh().catch(() => undefined);
    } finally { inFlight.current = false; }
    if (failures.length) throw new Error(failures.join("; "));
    if (!pending.current.size) setLanded(count => count + 1);
  });
  const [held, setHeld] = useState<Record<string, string>>({});
  const sequence = useRef(0);
  const clearHeld = (key: string) => setHeld(was => { if (!(key in was)) return was; const next = { ...was }; delete next[key]; return next; });
  const heldReason = Object.values(held)[0];
  return {
    status: heldReason ? `Not saved: ${heldReason}` : auto.status,
    /** Changes when fields may follow the server: a clean landing. Pair it with `quiet()` in a resync effect. */
    landed,
    /** Read inside an effect: nothing queued, in flight, failed or held back. */
    quiet: () => !inFlight.current && !pending.current.size && !auto.failed && !heldReason,
    queue(key: string, op: SaveOp, delay = 0) {
      pending.current.delete(key);
      pending.current.set(key, op);
      auto.enqueue(++sequence.current, delay);
      clearHeld(key);
    },
    /** Hold back a draft that cannot be sent, under its own key: other writes, even to the same record, never clear it. */
    hold(key: string, reason: string) { pending.current.delete(key); setHeld(was => ({ ...was, [key]: reason })); },
    /** A held draft became valid again. */
    release: clearHeld,
    flush: () => void auto.saver.flush(),
  };
}

/** Two columns where they fit (688 and wider), one at 390. */
function Pair({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "flex-start" }}>
    {React.Children.toArray(children).map((child, index) => <View key={index} style={{ flexGrow: 1, flexBasis: 260, minWidth: 0, gap: space.xs }}>{child}</View>)}
  </View>;
}

/** "Saved", or "Not saved" with its reason behind a (?). Saving… stays quiet. */
function SaveWord({ c, status, name }: { c: Colors; status: string; name: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  const r = roles(c);
  if (status === "Saved") return <Text accessibilityLabel={`${name} save status`} accessibilityLiveRegion="polite" style={{ color: r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>Saved</Text>;
  if (!status.startsWith("Not saved")) return null;
  const reason = status.replace(/^Not saved:\s*/, "");
  return <View ref={anchor} style={{ ...row, flexWrap: "nowrap" }}>
    <Text accessibilityLabel={`${name} save status`} accessibilityLiveRegion="polite" style={{ color: r.warning, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>Not saved</Text>
    <HelpTip c={c} label="Not saved" text={reason} open={open} onOpenChange={setOpen} />
    {open && <HelpPopover c={c} anchor={anchor} label="Not saved" text={reason} />}
  </View>;
}

/** The planner picker: live standing threads by title, plus None. A planner that is not live stays selected as "Gone". */
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
      onRemoved={() => { setRemoving(false); void actions.refresh().catch(() => undefined); onBack(); }} />}
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

/**
 * [+]: repositories still in implicit projects (added as a member), repositories
 * of other projects (labelled with their project; picking one asks how to move
 * it, nucleus#969), and "Other…" for an `owner/name`.
 */
function AddRepository({ c, rows, projectKey, members, disabled, onAdd, onMove }: {
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
function RepositoryBlock({ c, repo, primary, single, open, disabled, settings, saves, setRepository, onToggle, onPrimary, checkBlockers, onSeparate, alsoDeletes, onRemoveFromNucleus }: {
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

/** The operator's per-repository settings. Each field is its own `repository.set` patch; an empty field clears its setting. */
function RepositoryFields({ c, repo, label, settings, disabled, saves, setRepository }: {
  c: Colors; repo: ProjectRepository; label: string; settings: RepositorySettings | null; disabled: boolean;
  saves: ProjectSaves; setRepository: ProjectEditActions["setRepository"];
}) {
  const r = roles(c);
  const id = identityOf(repo);
  const key = (field: string) => `repo:${id}:${field}`;
  const patch = (field: string, value: Omit<RepositorySetInput, "repository">, op: Partial<SaveOp> = {}, delay = 0) =>
    saves.queue(key(field), { run: () => setRepository({ repository: id, ...value }), ...op }, delay);
  const server = useRef(settings); server.current = settings;
  const qa = settings?.qa ?? null, validation = settings?.validation ?? null;
  const [command, setCommand] = useState(qa?.argv ? joinCommand(qa.argv) : "");
  const [qaTimeout, setQaTimeout] = useState(minutes(qa?.timeoutMs, QA_TIMEOUT_DEFAULT_MIN, QA_TIMEOUT_MAX_MIN));
  const [scheduled, setScheduled] = useState(Boolean(qa?.schedule));
  const [afterMerges, setAfterMerges] = useState(qa?.schedule?.afterMerges ?? AFTER_MERGES_DEFAULT);
  const [checks, setChecks] = useState(settings?.checksPolicy ?? "all");
  const [reviewer, setReviewer] = useState(settings?.reviewer?.login ?? "");
  const [mergeCommand, setMergeCommand] = useState(validation ? joinCommand(validation.argv) : "");
  const [mergeTimeout, setMergeTimeout] = useState(minutes(validation?.timeoutMs, MERGE_TIMEOUT_DEFAULT_MIN, MERGE_TIMEOUT_MAX_MIN));
  // Follow the server when nothing is waiting.
  const revision = `${settings?.revision ?? -1}:${settings?.updatedAt ?? ""}`;
  useEffect(() => {
    if (!saves.quiet()) return;
    setCommand(qa?.argv ? joinCommand(qa.argv) : "");
    setQaTimeout(minutes(qa?.timeoutMs, QA_TIMEOUT_DEFAULT_MIN, QA_TIMEOUT_MAX_MIN));
    setScheduled(Boolean(qa?.schedule)); setAfterMerges(qa?.schedule?.afterMerges ?? AFTER_MERGES_DEFAULT);
    setChecks(settings?.checksPolicy ?? "all");
    setReviewer(settings?.reviewer?.login ?? "");
    setMergeCommand(validation ? joinCommand(validation.argv) : "");
    setMergeTimeout(minutes(validation?.timeoutMs, MERGE_TIMEOUT_DEFAULT_MIN, MERGE_TIMEOUT_MAX_MIN));
  }, [saves.landed, revision]);
  const writeQa = (next: { command?: string; timeout?: number; scheduled?: boolean; afterMerges?: number }) => {
    const value = { command, timeout: qaTimeout, scheduled, afterMerges, ...next };
    const parsed = splitCommand(value.command);
    if ("error" in parsed) { saves.hold(key("qa"), `QA: ${parsed.error}`); return; }
    if (!parsed.argv.length) { patch("qa", { qa: null }, {}, 600); return; }
    if (parsed.argv.length > 32) { saves.hold(key("qa"), "QA takes at most 32 words"); return; }
    const kept = qa && !qa.stages ? { maxOutputBytes: qa.maxOutputBytes, terminationGraceMs: qa.terminationGraceMs } : {};
    patch("qa", { qa: { ...kept, argv: parsed.argv, timeoutMs: value.timeout * 60_000,
      schedule: value.scheduled ? { afterMerges: value.afterMerges, maxIntervalHours: qa?.schedule?.maxIntervalHours ?? 24 } : null } }, {}, 600);
  };
  const writeMerge = (next: { command?: string; timeout?: number }) => {
    const value = { command: mergeCommand, timeout: mergeTimeout, ...next };
    const parsed = splitCommand(value.command);
    if ("error" in parsed) { saves.hold(key("validation"), `Merge check: ${parsed.error}`); return; }
    if (!parsed.argv.length) { patch("validation", { validation: null }, {}, 600); return; }
    if (parsed.argv.length > 32) { saves.hold(key("validation"), "Merge check takes at most 32 words"); return; }
    patch("validation", { validation: { argv: parsed.argv, timeoutMs: value.timeout * 60_000,
      maxOutputBytes: validation?.maxOutputBytes ?? PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES,
      ...(validation ? { terminationGraceMs: validation.terminationGraceMs } : {}) } }, {}, 600);
  };
  const changeReviewer = (text: string) => {
    setReviewer(text);
    const login = text.trim();
    if (login && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login)) { saves.hold(key("reviewer"), "Reviewer must be a GitHub login"); return; }
    if (login.length > 200) { saves.hold(key("reviewer"), "Reviewer is over 200 characters"); return; }
    patch("reviewer", { reviewer: login ? { login } : null }, {}, 600);
  };
  const changeChecks = (value: string) => {
    const policyValue = value === "required" ? "required" : "all";
    setChecks(policyValue);
    // A refusal (GitHub's required checks unreadable) puts the dropdown back.
    patch("checksPolicy", { checksPolicy: policyValue }, { revert: () => setChecks(server.current?.checksPolicy ?? "all") });
  };
  const hasCommand = Boolean(command.trim());
  const hasMerge = Boolean(mergeCommand.trim());

  return <View style={{ gap: space.sm }}>
    {qa?.stages
      ? <View style={{ ...row }}>
          <FieldCaption c={c} text="QA" help={STAGED_HELP} />
          <Text accessibilityLabel={`QA for ${label}`} style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>Staged · {qa.stages.length} {qa.stages.length === 1 ? "step" : "steps"}</Text>
        </View>
      : <>
          <Pair>
            <Field c={c} label="QA" a11yLabel={`QA command for ${label}`} placeholder="Command" value={command} disabled={disabled}
              onChange={text => { setCommand(text); writeQa({ command: text }); }} onBlur={saves.flush} />
            <View style={{ gap: space.xxs }}>
              <FieldCaption c={c} text="Timeout" />
              <View style={{ flexDirection: "row" }}>
                <NumberStepper c={c} a11yLabel={`QA timeout for ${label}`} unit="min" value={qaTimeout} min={1} max={QA_TIMEOUT_MAX_MIN} disabled={disabled || !hasCommand}
                  onChange={next => { setQaTimeout(next); writeQa({ timeout: next }); }} onCommit={saves.flush} />
              </View>
            </View>
          </Pair>
          <View style={{ ...row }}>
            <FieldCaption c={c} text="Schedule" />
            <Button matchField c={c} checked={scheduled} text={scheduled ? "On" : "Off"} label={`QA schedule for ${label}`} disabled={disabled || !hasCommand}
              onPress={() => { setScheduled(!scheduled); writeQa({ scheduled: !scheduled }); }} />
            {scheduled && <>
              <Text style={muted(c)}>After</Text>
              <NumberStepper c={c} a11yLabel={`Merges between QA runs for ${label}`} unit="merges" value={afterMerges} min={1} max={1000} disabled={disabled || !hasCommand}
                onChange={next => { setAfterMerges(next); writeQa({ afterMerges: next }); }} onCommit={saves.flush} />
            </>}
          </View>
        </>}
    <Pair>
      <View style={{ gap: space.xxs }}>
        <FieldCaption c={c} text="Checks" help={CHECKS_HELP} />
        <DropdownSelect c={c} hideLabel label={`Checks for ${label}`} value={checks} disabled={disabled} options={[{ value: "all", label: "All" }, { value: "required", label: "Required" }]} onChange={changeChecks} />
      </View>
      <View style={{ gap: space.xxs }}>
        <FieldCaption c={c} text="Reviewer" help={REVIEWER_HELP} />
        <Field c={c} label="" hideLabel a11yLabel={`Reviewer for ${label}`} placeholder="GitHub login" value={reviewer} disabled={disabled} onChange={changeReviewer} onBlur={saves.flush} />
      </View>
    </Pair>
    <Pair>
      <View style={{ gap: space.xxs }}>
        <FieldCaption c={c} text="Merge check" help={MERGE_HELP} />
        <Field c={c} label="" hideLabel a11yLabel={`Merge check for ${label}`} placeholder="Command" value={mergeCommand} disabled={disabled}
          onChange={text => { setMergeCommand(text); writeMerge({ command: text }); }} onBlur={saves.flush} />
      </View>
      <View style={{ gap: space.xxs }}>
        <FieldCaption c={c} text="Timeout" />
        <View style={{ flexDirection: "row" }}>
          <NumberStepper c={c} a11yLabel={`Merge check timeout for ${label}`} unit="min" value={mergeTimeout} min={1} max={MERGE_TIMEOUT_MAX_MIN} disabled={disabled || !hasMerge}
            onChange={next => { setMergeTimeout(next); writeMerge({ timeout: next }); }} onCommit={saves.flush} />
        </View>
      </View>
    </Pair>
  </View>;
}
