import { errorText as failureText } from "./error-text";
import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc } from "./shell";
import { ActionButton, Button, Disclosure, DropdownSelect, HelpPopover, HelpTip, InlineConfirm, NumberStepper, SaveStatus, Section, StopSlider, muted, row, sectionCard, useSectionAutoSave, type Colors } from "./controls";
import { radius, roles, space, type } from "./design";
import { DateTimeLink, formatLocalDateTime } from "./date-time-field";
import { USAGE_LABELS } from "../shared/pool";
import * as api from "../shared/contracts";
import { MAX_HOLD_MINUTES, MAX_PASEO_CALL_LIMIT, MAX_STALL_THRESHOLD_MINUTES, usageLevels, type UiQueueState, type UsageLevel } from "../shared/contracts";

/*
 * Settings → Dispatch limits. One place for what the host runs with: the usage
 * level, the task slots, project overrides, role demand and frontier grants.
 * Every limit reads as its value in force when that
 * differs from what is entered. The RPCs and their authority are unchanged; this
 * module only changes how they read (Tom, 2026-11-08: half the height, same controls).
 */

/** A project override write: its slot limit, or null to remove it. The in-flight cap is always twice the slots (Tom, 2026-11-08). */
export type ProjectLimitPatch = { projectKey?: string; limit: number | null };

export type DispatchLimitsProps = {
  c: Colors;
  state: UiQueueState;
  busy: boolean;
  /** `queue.capacity-state`, read on its own. Undefined until the first read settles. */
  authority: api.CapacityAuthorityState | undefined;
  authorityError: unknown;
  retryAuthority: () => void;
  refreshBoard: () => Promise<unknown>;
  saveUsage: (level: UsageLevel, until: string | null) => Promise<void>;
  saveDemandOffsets: (value: UiQueueState["demandOffsets"]) => Promise<void>;
  saveCapacity: (values: api.CapacityAuthorityValues) => Promise<void>;
  saveProjectLimit: (value: ProjectLimitPatch & { projectKey: string }) => Promise<void>;
};

const small = (c: Colors) => ({ ...muted(c), fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight });

/**
 * One grant on one full-width row (Tom, 2026-11-08): the planner, its profiles, the (?)
 * holding reason, since, until and run count, and Revoke as an icon button that asks first.
 */
function GrantCard({ c, grant, planner, profiles, busy, onRevoke }: {
  c: Colors; grant: api.RoutingGrantView; planner: string; profiles: string; busy: boolean; onRevoke: () => void;
}) {
  const [reasonOpen, setReasonOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const anchor = useRef<View | null>(null);
  const runs = `${grant.runCount} run${grant.runCount === 1 ? "" : "s"}`;
  const detail = `${grant.reason ? `${grant.reason}. ` : ""}Since ${formatLocalDateTime(grant.activatedAt ?? grant.requestedAt)}${grant.until ? ` · until ${formatLocalDateTime(grant.until)}` : ""} · ${runs}.`;
  return <View accessibilityLabel={`Grant for ${planner}, ${runs}`} style={{ ...sectionCard(c), gap: space.xs }}>
    <View ref={anchor} style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
      <Text numberOfLines={1} style={{ color: roles(c).foreground, fontWeight: "600", fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, flexShrink: 0, maxWidth: "50%" }}>{planner}</Text>
      <Text numberOfLines={1} style={{ color: roles(c).foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, flexShrink: 1, minWidth: 0 }}>{profiles}</Text>
      <HelpTip c={c} label={`Grant for ${planner}`} text={detail} open={reasonOpen} onOpenChange={setReasonOpen} />
      {reasonOpen && <HelpPopover c={c} anchor={anchor} label={`Grant for ${planner}`} text={detail} />}
      <View style={{ flex: 1 }} />
      <ActionButton c={c} action="remove" label={`Revoke the grant for ${planner}`} disabled={busy || confirming} onPress={() => setConfirming(true)} />
    </View>
    {confirming && <InlineConfirm c={c} question={`Revoke ${planner}'s grant?`} confirmLabel="Revoke" label={`grant for ${planner}`} busy={busy}
      onConfirm={() => { setConfirming(false); onRevoke(); }} onCancel={() => setConfirming(false)} />}
  </View>;
}

/** Spec 052: planners holding a frontier grant. Tom, 2026-11-06: this belongs in Limits, not the board header. */
function FrontierGrants({ c, state, refresh }: { c: Colors; state: UiQueueState; refresh: () => Promise<unknown> }) {
  const routingGrant = useRpc(api.routingGrant);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plannerName = (agentId: string) => {
    const project = state.projects.find(item => item.planner?.agentId === agentId);
    return project ? `${project.name} planner` : agentId;
  };
  const profileName = (id: string) => state.profiles.find(profile => profile.id === id)?.name ?? id;
  const revoke = async (grant: api.RoutingGrantView) => {
    setBusy(true); setError(null);
    try {
      await routingGrant({ action: "revoke", caller: "operator (board)", grantId: grant.id, reason: "revoked from Settings" });
      await refresh();
    } catch (failure) { setError(failureText(failure)); }
    finally { setBusy(false); }
  };
  return <Section c={c} title="Frontier grants" last status={error ? `Not saved: ${error}` : null}
    description="While a grant stands, this planner's requests for these profiles need no per-task question. Automatic selection is unchanged. The planner ends a grant when its work is done; you can revoke it here.">
    {!state.routingGrants.length && <Text style={muted(c)}>None. A planner asks once, and the request arrives on the board.</Text>}
    {state.routingGrants.length > 0 && <View style={{ gap: space.sm }}>
      {state.routingGrants.map(grant => <GrantCard key={grant.id} c={c} grant={grant} planner={plannerName(grant.planner)}
        profiles={grant.profiles.length ? grant.profiles.map(profileName).join(", ") : "All frontier and above-ceiling profiles"} busy={busy} onRevoke={() => void revoke(grant)} />)}
    </View>}
  </Section>;
}

const USAGE_EFFECT: Record<UsageLevel, string> = {
  minimal: "Runs need two fewer capability steps. High-cost profiles need an explicit request.",
  low: "Runs need one fewer capability step. The highest-cost profiles need an explicit request.",
  normal: "Runs match the task's capability need. The highest-cost profiles need an explicit request.",
  high: "Runs need one extra capability step. High-cost profiles can be selected automatically.",
  maximum: "Runs need two extra capability steps. High-cost profiles can be selected automatically.",
};

/** The levels that can carry an end time: above Normal, where returning to Normal means something. */
const LIFTED: ReadonlySet<UsageLevel> = new Set(["high", "maximum"]);

/**
 * Spec 052: the operator's overall usage level as a five-stop slider. What a level does sits behind the (?).
 * At High and Maximum, an end time sits as small text on the heading row's right, so the slider keeps
 * its full width (Tom, 2026-11-09); it opens the date picker and returns the level to Normal when reached.
 */
function UsageSlider({ c, usage, save }: { c: Colors; usage: UiQueueState["usage"]; save: (level: UsageLevel, until: string | null) => Promise<void> }) {
  const [level, setLevelDraft] = useState<UsageLevel>(usage.level);
  const [until, setUntilDraft] = useState<string | null>(usage.expired ? null : usage.until);
  const auto = useSectionAutoSave<{ level: UsageLevel; until: string | null }>(value => save(value.level, value.until));
  // A level with no end-time control carries no end time: a hidden date would be one nobody can see or clear.
  const setLevel = (next: UsageLevel) => {
    const nextUntil = LIFTED.has(next) ? until : null;
    setLevelDraft(next); setUntilDraft(nextUntil); auto.enqueue({ level: next, until: nextUntil });
  };
  const setUntil = (next: string | null) => { setUntilDraft(next); auto.enqueue({ level, until: next }); };
  // The board's value is adopted whenever nothing is pending and the last save did
  // not fail, so an open picker and an unsaved draft survive re-projections.
  useEffect(() => {
    if (auto.saver.busy || auto.failed) return;
    setLevelDraft(usage.level);
    setUntilDraft(usage.expired ? null : usage.until);
  }, [usage.level, usage.until, usage.expired, auto.failed]);
  // Normal in force shows only when it differs from the level set: an ended level has returned to Normal.
  const note = usage.expired ? "Normal in force" : undefined;
  const end = LIFTED.has(level)
    ? <View style={{ marginLeft: "auto", flexShrink: 1, minWidth: 0, maxWidth: "100%" }}><DateTimeLink c={c} label="Return to Normal" prefix="until " emptyText="No end" value={until} onChange={setUntil} /></View>
    : undefined;
  return <Section c={c} title="Usage level" label="Usage level" note={note} status={auto.status} action={end} description={`${USAGE_EFFECT[level]} At High or Maximum, the end time returns the level to Normal when it is reached.`}>
    <StopSlider c={c} a11yLabel="Usage level" stops={usageLevels} value={level} labelFor={stop => USAGE_LABELS[stop].label} stopLabel={stop => `Usage ${USAGE_LABELS[stop].label}`} onChange={setLevel} />
  </Section>;
}

/** Spec 053: how far each role's demand sits from the task's complexity (Tom, 2026-10-22: "Build it in #592"). */
function DemandOffsets({ c, offsets, save }: { c: Colors; offsets: UiQueueState["demandOffsets"]; save: (value: UiQueueState["demandOffsets"]) => Promise<void> }) {
  const [draft, setDraft] = useState(offsets);
  const auto = useSectionAutoSave(save);
  useEffect(() => { if (!auto.saver.busy && !auto.failed) setDraft(offsets); }, [offsets.worker, offsets.reviewer, offsets.coordinator, auto.failed]);
  // A short pause lets repeated − or + presses, or typed digits, land as one save.
  const set = (role: keyof typeof offsets, value: number) => {
    const next = { ...draft, [role]: value };
    setDraft(next); auto.enqueue(next, 400);
  };
  const signed = (value: number) => value > 0 ? `+${value}` : value < 0 ? `−${-value}` : "0";
  return <Section c={c} title="Role demand" label="Role demand offsets" status={auto.status}
    description="Each run needs the task's complexity plus its role's offset and the usage level's. Negative asks less of a role than the task.">
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>{(["worker", "reviewer", "coordinator"] as const).map(role =>
      <NumberStepper key={role} card c={c} label={role[0].toUpperCase() + role.slice(1)} a11yLabel={`${role} demand offset`} value={draft[role]} min={-4} max={4} format={signed}
        decreaseLabel={`Lower ${role} demand`} increaseLabel={`Raise ${role} demand`} onChange={value => set(role, value)} onCommit={() => void auto.saver.flush()} />)}</View>
  </Section>;
}

/* ------------------------------------------------------------------------- */
/* Settings-only capacity writes: the limits and their reads                 */
/* ------------------------------------------------------------------------- */

/*
 * Settings-only capacity writes (service-boundary contract, "Settings-only capacity
 * writes"): Settings is the only route that changes the host's dispatch limits, and
 * every applied change is recorded with its time, surface and the full values before
 * and after. The CLI and every agent route refuse, so a field saves on its own. The
 * record is read through `queue.capacity-state`; Settings shows no view of it (Tom, 2026-11-08).
 */

/**
 * Every limit, in the shared schema's own order and bounds; the schema still refuses
 * anything else. The first three are the ordinary task slots; the rest sit under Advanced.
 */
const CAPACITY_FIELD_LABELS: Record<keyof api.CapacityAuthorityValues, string> = {
  globalLimit: "Global", projectLimit: "Per project", papercutProjectLimit: "Papercuts",
  paseoCallLimit: "Paseo calls", stallThresholdMinutes: "Stall threshold",
  holdReminderMinutes: "Hold reminder", holdEscalationMinutes: "Hold escalation",
  laneDrainMinutes: "Lane drain", laneDrainEscalationMinutes: "Lane drain escalation",
};
type CapacityKey = keyof api.CapacityAuthorityValues;
type LimitSpec = { key: CapacityKey; min: number; max: number; unit: "slots" | "calls" | "minutes"; advanced?: true };
const CAPACITY_FIELDS: LimitSpec[] = [
  { key: "globalLimit", min: 1, max: 64, unit: "slots" },
  { key: "projectLimit", min: 1, max: 32, unit: "slots" },
  { key: "papercutProjectLimit", min: 1, max: 32, unit: "slots" },
  { key: "paseoCallLimit", min: 1, max: MAX_PASEO_CALL_LIMIT, unit: "calls", advanced: true },
  { key: "stallThresholdMinutes", min: 1, max: MAX_STALL_THRESHOLD_MINUTES, unit: "minutes", advanced: true },
  { key: "holdReminderMinutes", min: 1, max: MAX_HOLD_MINUTES, unit: "minutes", advanced: true },
  { key: "holdEscalationMinutes", min: 1, max: MAX_HOLD_MINUTES, unit: "minutes", advanced: true },
  { key: "laneDrainMinutes", min: 1, max: MAX_HOLD_MINUTES, unit: "minutes", advanced: true },
  { key: "laneDrainEscalationMinutes", min: 1, max: MAX_HOLD_MINUTES, unit: "minutes", advanced: true },
];
const UNIT_SHORT: Record<LimitSpec["unit"], string> = { slots: "slots", calls: "calls", minutes: "min" };

/** A limits read that has not settled: loading, a failed first read, or a failed refresh. Nothing here writes, so Try again is always safe. */
function ReadNotice({ c, hasValues, error, retry }: { c: Colors; hasValues: boolean; error: unknown; retry: () => void }) {
  if (!error) return hasValues ? null : <Text accessibilityLiveRegion="polite" style={muted(c)}>Reading the dispatch limits…</Text>;
  return <View style={{ gap: space.xs }}>
    <Text accessibilityRole="alert" style={{ color: roles(c).warning, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>
      {hasValues ? "Couldn't refresh the dispatch limits. The values shown may be out of date; nothing was changed." : "Couldn't read the dispatch limits, so none is shown as applied. Nothing was changed."}
    </Text>
    <Text style={small(c)}>{failureText(error)}</Text>
    <View style={row}><Button small c={c} text="Retry" label="Retry reading the dispatch limits" onPress={retry} /></View>
  </View>;
}

/** The task slots: the three ordinary limits first, the six timing and call limits under Advanced. */
function TaskSlots({ c, values, authorityError, retry, save }: {
  c: Colors; values: api.CapacityAuthorityValues | null; authorityError: unknown; retry: () => void;
  save: (values: api.CapacityAuthorityValues) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Partial<Record<CapacityKey, number>>>({});
  // Local UI state: opening Advanced never writes, and collapsing keeps every draft and pending save.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const auto = useSectionAutoSave(save);
  // The applied values are adopted whenever nothing is pending and the last save did
  // not fail, so a refresh (or a change made elsewhere) never fights a live draft.
  const valuesJson = values ? JSON.stringify(values) : "";
  useEffect(() => {
    if (!values || auto.saver.busy || auto.failed) return;
    setDrafts(Object.fromEntries(CAPACITY_FIELDS.map(field => [field.key, values[field.key]])));
  }, [valuesJson, auto.failed]);
  // The control keeps each value in its range, so every edit is sendable. Typing saves
  // after a pause and a step after the same pause, so repeated presses land as one save.
  // One field at a time still writes the whole state, so a change never carries a stale
  // value for a limit it did not touch.
  const edit = (key: CapacityKey, value: number) => {
    const next = { ...drafts, [key]: value };
    setDrafts(next);
    if (!values) return;
    auto.enqueue(Object.fromEntries(CAPACITY_FIELDS.map(field => [field.key, next[field.key] ?? values[field.key]])) as api.CapacityAuthorityValues, 600);
  };
  // A labelled card per limit. The line under it names the value in force only when the
  // entered value differs, so an unsaved draft never reads as applied.
  const field = (spec: LimitSpec, current: api.CapacityAuthorityValues) => {
    const name = CAPACITY_FIELD_LABELS[spec.key], unit = UNIT_SHORT[spec.unit];
    const draft = drafts[spec.key] ?? current[spec.key];
    return <NumberStepper key={spec.key} card stacked={spec.advanced} c={c} label={name} a11yLabel={`${name} dispatch limit (${spec.unit}, ${spec.min}–${spec.max})`} value={draft} min={spec.min} max={spec.max}
      unit={spec.unit === "slots" ? undefined : unit} onChange={value => edit(spec.key, value)} onCommit={() => void auto.saver.flush()}>
      {draft !== current[spec.key] && <Text style={small(c)}>In force {current[spec.key]} {unit}</Text>}
    </NumberStepper>;
  };
  return <Section c={c} title="Task slots" status={auto.status}
    description="Only Settings changes these. Parked tasks hold no slot, lowering a limit lets running work finish, and papercuts also count toward Global.">
    <ReadNotice c={c} hasValues={Boolean(values)} error={authorityError} retry={retry} />
    {values && <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>{CAPACITY_FIELDS.filter(spec => !spec.advanced).map(spec => field(spec, values))}</View>
      <Disclosure c={c} gapAbove label="Advanced limits" expanded={advancedOpen} onToggle={() => setAdvancedOpen(open => !open)} />
      {advancedOpen && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>{CAPACITY_FIELDS.filter(spec => spec.advanced).map(spec => field(spec, values))}</View>}
    </>}
  </Section>;
}

/**
 * Project overrides, one line each (Tom, 2026-11-08): the project, its slot limit and a
 * trash icon that asks first. The slot limit is the server's effective value
 * (`projectCapacities`); its in-flight cap is always twice that, so it has no control.
 * Only Settings' + picker creates an override.
 */
function ProjectOverrides({ c, state, busy, saveProjectLimit }: { c: Colors; state: UiQueueState; busy: boolean; saveProjectLimit: (value: ProjectLimitPatch & { projectKey: string }) => Promise<void> }) {
  // Choosing a project creates its override at once with the per-project limit;
  // a failure to create it is shown here, beside the picker.
  const [addStatus, setAddStatus] = useState("");
  // One create at a time: + and the picker wait for it, so a second pick can
  // never overwrite an edit made after the first (review #596).
  const [creating, setCreating] = useState<string | null>(null);
  const overrides = state.projectLimitOverrides ?? {};
  const effective = new Map((state.projectCapacities ?? []).map(entry => [entry.projectKey, entry]));
  const configuredProjects = Object.keys(overrides);
  const availableProjects = state.projects.filter(project => !Object.prototype.hasOwnProperty.call(overrides, project.key) && project.key !== creating);
  // The key tells two projects with one name apart; it shows nowhere else.
  const pickerLabel = (project: UiQueueState["projects"][number]) => state.projects.filter(other => other.name === project.name).length > 1 ? `${project.name} · ${project.key}` : project.name;
  // A simple choice opens as the anchored section menu, never a full-screen
  // dialog: picking a project creates its override at once (task 923).
  const chooseProject = (projectKey: string) => {
    const projectRecord = availableProjects.find(candidate => candidate.key === projectKey);
    if (!projectRecord) return;
    setAddStatus("Saving…"); setCreating(projectRecord.key);
    void saveProjectLimit({ projectKey: projectRecord.key, limit: state.projectLimit })
      .then(() => setAddStatus(""), error => setAddStatus(`Not saved: ${failureText(error)}`))
      .finally(() => setCreating(null));
  };
  return <Section c={c} title="Project overrides" description="Slots run 0–64, where 0 admits nothing. A project may have twice its slots in flight. A project without an override uses the per-project limit."
    action={<DropdownSelect compact label="Add project limit override" value="" placeholder="+" disabled={busy || Boolean(creating) || !availableProjects.length} emptyText="Every project already has an override."
      options={availableProjects.map(projectRecord => ({ value: projectRecord.key, label: pickerLabel(projectRecord) }))} onChange={chooseProject} c={c} minWidth={52} />}>
    {!configuredProjects.length && <Text style={muted(c)}>None. Every project uses the per-project limit.</Text>}
    {addStatus && <SaveStatus c={c} status={addStatus} label="Project override" />}
    {configuredProjects.sort().map(projectKey => {
      const projectRecord = state.projects.find(project => project.key === projectKey);
      const limit = effective.get(projectKey)?.slotLimit ?? overrides[projectKey];
      return <ProjectLimitRow key={projectKey} c={c} projectName={projectRecord?.name ?? projectKey} value={limit} canSave={Boolean(projectRecord)}
        save={next => saveProjectLimit({ projectKey, ...next })} />;
    })}
  </Section>;
}

function ProjectLimitRow({ c, projectName, value, canSave, save }: { c: Colors; projectName: string; value: number; canSave: boolean; save: (patch: ProjectLimitPatch) => Promise<void> }) {
  const [limit, setLimit] = useState(value);
  // Edits and removals (null) share one ordered queue: a removal replaces any pending
  // edit and runs after one already in flight, so it is never overtaken.
  const auto = useSectionAutoSave(save);
  useEffect(() => { if (!auto.saver.busy && !auto.failed) setLimit(value); }, [value, auto.failed]);
  // Once a removal starts the row takes no edits, so nothing pending can recreate the
  // override when it unmounts; a failed removal gives editing back.
  const [removing, setRemoving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (removing && auto.failed) setRemoving(false); }, [removing, auto.failed]);
  const change = (next: number) => {
    if (removing) return;
    setLimit(next);
    if (canSave) auto.enqueue({ limit: next }, 600);
  };
  const remove = () => { setConfirming(false); setRemoving(true); auto.enqueue({ limit: null }); };
  return <View accessibilityLabel={`${projectName} override`} style={{ gap: space.xs, paddingVertical: space.xxs, paddingLeft: space.sm, paddingRight: space.xxs, borderRadius: radius.card, backgroundColor: roles(c).section }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Text style={{ color: roles(c).foreground, fontWeight: "600", fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, flex: 1, flexShrink: 1, minWidth: 0 }}>{projectName}</Text>
      <SaveStatus c={c} status={auto.status} label={`${projectName} override`} />
      <NumberStepper c={c} a11yLabel={`Task slots for ${projectName} (0–64; 0 admits nothing)`} value={limit} min={0} max={64} disabled={removing || !canSave}
        onChange={change} onCommit={() => void auto.saver.flush()} />
      <ActionButton c={c} action="remove" label={`Remove the ${projectName} override`} disabled={removing || confirming} onPress={() => setConfirming(true)} />
    </View>
    {!canSave && <Text style={{ color: roles(c).warning, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>This project is no longer available. Remove its override to clear it.</Text>}
    {confirming && <InlineConfirm c={c} question="Remove this override?" confirmLabel="Remove" label={`${projectName} dispatch limit override`} busy={removing} onConfirm={remove} onCancel={() => setConfirming(false)} />}
  </View>;
}

/**
 * Settings → Dispatch limits, in the order the operator reads it: usage level, task
 * slots, project overrides, role demand, then frontier grants.
 */
export function DispatchLimits(props: DispatchLimitsProps) {
  const { c, state, authority } = props;
  const values = authority?.effective ?? null;
  return <View>
    <UsageSlider c={c} usage={state.usage} save={props.saveUsage} />
    <TaskSlots c={c} values={values} authorityError={props.authorityError} retry={props.retryAuthority} save={props.saveCapacity} />
    <ProjectOverrides c={c} state={state} busy={props.busy} saveProjectLimit={props.saveProjectLimit} />
    <DemandOffsets c={c} offsets={state.demandOffsets} save={props.saveDemandOffsets} />
    <FrontierGrants c={c} state={state} refresh={props.refreshBoard} />
  </View>;
}
