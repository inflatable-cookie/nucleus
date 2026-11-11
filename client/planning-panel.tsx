import React, { type ReactNode, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { LaneView, LeadListFacts, Project, ProjectPlan, ProjectQaRun } from "../shared/contracts";
import { chooserProjects, laneFinderCount, laneFinderRows, laneFinderScopeLabel, lanePlaceLabel, lanePlaces, type LaneFinderRow } from "../shared/lane-finder";
import { effectiveSelection } from "../shared/project-scope";
import { activeSteps, movePlan, planDraftStale, planningColumns, planningPlan, projectLanes, rebaseDraft, reorderPlan, roadmapView, sameOrder, type PlanDraft, type PlanEntry, type PlanningStep, type RoadmapStep } from "../shared/planning-tab";
import { decisionAge } from "../shared/pipeline-board";
import { formatTelemetryDuration } from "../shared/telemetry";
import { ActionButton, Button, Field, controlFrame, controlText, muted, row, type Colors } from "./controls";
import { overlay, radius, roles, space, touchTarget, type, type as typeScale } from "./design";
import { projectDormant } from "../shared/contracts";

/** `error` is set when the plan or its saved version could not be read; `latest` is then the last version read, if any. */
export type PlanSection = { project: Project; latest?: ProjectPlan; saved?: ProjectPlan; error?: string };
/** A draft: the order, horizons and idle change the operator is making, and the version it was based on. See `PlanDraft`. */
export type PlanEdit = PlanDraft;

/** #121: one milestone QA run's steps, each stage named with its outcome; shared by
 * the QA runs tab's detail and the task detail. */
export function ProjectQaSteps({ run, c, label = "QA steps" }: { run: ProjectQaRun; c: Colors; label?: string }) {
  if (!run.steps.length) return null;
  return <View accessibilityLabel={label} style={{ gap: 2 }}>
    {run.steps.map(step => <Text key={step.name} style={{ ...muted(c), fontSize: 11 }}>{step.name} · {step.timedOut ? 'timed out' : step.signal ? step.signal : step.exitCode === 0 ? 'passed' : `exit ${step.exitCode ?? '—'}`}{step.wallMs === undefined ? '' : ` · ${formatTelemetryDuration(step.wallMs)}`}</Text>)}
  </View>;
}
/**
 * #136: a run's full-output log-write failures, kept apart from its output tail so
 * later output can never truncate them. Shown on the task detail and the QA runs
 * tab's detail.
 */
export function ProjectQaLogWriteErrors({ run, c, label = "QA log-write errors" }: { run: ProjectQaRun; c: Colors; label?: string }) {
  const errors = run.logWriteErrors ?? [];
  if (!errors.length) return null;
  return <View accessibilityLabel={label} style={{ gap: 2 }}>
    {errors.map((entry, index) => <Text key={`${entry.step}-${entry.stream}-${index}`} selectable accessibilityLabel={`Log-write failure ${entry.step} ${entry.stream}`}
      style={{ color: c.statusWarning, fontSize: 11 }}>{entry.step} {entry.stream} log could not be written: {entry.error}</Text>)}
  </View>;
}
/**
 * Task 191: a run's extracted TAP failures, kept apart from the output tail so
 * a failure stays visible however much later output the byte cap keeps. Shown
 * on the task detail and the QA runs tab's detail.
 */
export function ProjectQaFailures({ run, c, label = "QA failures" }: { run: ProjectQaRun; c: Colors; label?: string }) {
  const indexes = run.failureIndexes ?? [];
  if (!run.failuresLog && !indexes.length) return null;
  return <View accessibilityLabel={label} style={{ gap: 2 }}>
    {indexes.map(index => <View key={index.stage} accessibilityLabel={`QA failure index ${index.stage}`} style={{ gap: 1 }}>
      <Text selectable style={{ color: c.statusWarning, fontSize: 11 }}>{index.stage}: {index.failed ?? "unknown"} failed, {index.cancelled ?? "unknown"} cancelled; {index.identities.length} identities retained, {index.omittedIdentities} omitted{index.truncated ? " (index truncated)" : ""}{index.diagnosticsTruncated ? " (diagnostics truncated)" : ""}</Text>
      {index.identities.map((identity, entry) => <Text key={`${identity.id ?? "unknown"}-${entry}`} selectable style={{ color: c.statusWarning, fontSize: 11 }}>
        {identity.status} {identity.id === null ? "" : `${identity.id} `}{identity.title}{identity.location ? ` — ${identity.location}` : ""}
      </Text>)}
    </View>)}
    {run.failuresLog && <Text selectable accessibilityLabel="QA failures log" style={{ color: c.statusWarning, fontSize: 11 }}>{run.failuresLog}</Text>}
  </View>;
}
/** A settled teardown failure can be retried without rerunning setup or QA (task 134). */
export function canRetryTeardown(run: ProjectQaRun | undefined): run is ProjectQaRun {
  const lastTeardown = run?.steps.filter(step => step.name === 'teardown').at(-1);
  return Boolean(run && (run.failedStep === 'teardown' || run.checkoutCleanupPending || (lastTeardown
    && (lastTeardown.exitCode !== 0 || lastTeardown.signal != null || lastTeardown.timedOut
      || lastTeardown.terminationError != null || lastTeardown.processGroupEmpty === false)))
    && run.state !== 'running' && run.state !== 'queued');
}
/** The milestone QA state in the operator's words. A queued run is waiting for a slot, never running. */
const milestoneStateLabel: Record<ProjectQaRun["state"], string> = {
  queued: "Queued · waiting, not running", running: "Running", passed: "Passed", failed: "Failed",
  cancelled: "Cancelled", timed_out: "Timed out", lost: "Lost", hold: "Needs attention",
};
function latestQaFailure(run: ProjectQaRun): string {
  const lines = [run.outputTail, ...run.steps.flatMap(step => [step.stderrTail, step.stdoutTail])]
    .flatMap(value => value?.split(/\r?\n/) ?? []).map(value => value.trim().replace(/\s+/g, " ")).filter(Boolean);
  const summary = lines.at(-1);
  if (summary) return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary;
  return run.failedStep ? `${run.failedStep} failed` : "QA failed without a recorded summary.";
}
/**
 * The project plan's latest milestone QA (nucleus#869): one compact line whose link
 * opens the same run detail as the QA runs tab (`client/qa-runs-tab.tsx`), which
 * alone launches, cancels, retries teardown and shows steps and output. Planning
 * duplicates none of those controls. `project.qa.list` returns the latest run per
 * repository, so the line is that run's own record and never a first page passed
 * off as a total. A first read, a failed read and a stale result stay distinct from
 * having no run, and a queued run waits rather than runs.
 */
export function ProjectQaLatest({ project, runs, loading = false, error, onOpenRun, onRetry, c }: {
  project: Project; runs?: ProjectQaRun[]; loading?: boolean; error?: string;
  onOpenRun?: (runId: string) => void; onRetry?: () => void; c: Colors;
}) {
  const identity = project.primary.origin ?? project.primary.path;
  const r = roles(c);
  const run = runs?.find(candidate => candidate.key === identity
    || (project.primary.origin && candidate.repository.origin === project.primary.origin)
    || (project.primary.path && candidate.repository.path === project.primary.path));
  // A read still in flight, or one that has not answered yet, is not an empty result.
  const reading = loading || (!runs && !error);
  const when = run?.finishedAt ? `Finished ${new Date(run.finishedAt).toLocaleString()}` : run ? `Started ${new Date(run.startedAt).toLocaleString()}` : "";
  const meta = { fontSize: typeScale.metadata.fontSize, lineHeight: typeScale.metadata.lineHeight } as const;
  const retry = onRetry && <View style={row}><Button small c={c} text="Retry QA" label={`Retry the latest QA read for ${project.name}`} onPress={onRetry} /></View>;
  return <View accessibilityLabel={`Latest QA for ${project.name}`} style={{ gap: space.xxs }}>
    <View style={{ ...row, justifyContent: "space-between" }}>
      <Text accessibilityRole="header" style={{ color: r.foreground, fontWeight: "600", fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight }}>Latest QA</Text>
      {run && onOpenRun && <Button small c={c} text="View QA" label={`View the latest QA run for ${project.name}`} onPress={() => onOpenRun(run.id)} />}
    </View>
    {!run && reading && <Text style={muted(c)}>Loading the latest QA run…</Text>}
    {!run && !reading && error && <View accessibilityRole="alert" style={{ gap: space.xxs }}>
      <Text style={{ color: r.foreground }}>Couldn’t load QA runs: {error}</Text>
      <Text style={{ ...muted(c), ...meta }}>Nothing here is an empty result until that read succeeds.</Text>
      {retry}
    </View>}
    {!run && !reading && !error && <Text style={muted(c)}>No full-QA run yet. Run it from QA runs.</Text>}
    {run && <View style={{ gap: space.xxs }}>
      {(run.state === "failed" && !run.capacityUnavailable) ? <Text accessibilityLabel={`QA failure for ${project.name}`} numberOfLines={2} style={{ color: r.danger, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight }}>
        {latestQaFailure(run)} · {project.name}
      </Text> : <Text style={{ color: r.foreground, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight }}>{project.name}</Text>}
      <Text style={{ ...muted(c), ...meta }}>{run.capacityUnavailable ? "Capacity unavailable" : milestoneStateLabel[run.state]}{run.capacityWait ? ` · waiting for QA capacity (position ${run.capacityWait.position})` : ""} · {when}</Text>
      {run.capacityUnavailable && <Text accessibilityRole="alert" style={{ color: r.warning, ...meta }}>QA capacity unavailable: Nucleus's capacity deadline lapsed. This is not a QA failure.</Text>}
      {run.escapedDescendants.length > 0 && <Text accessibilityRole="alert" style={{ color: r.warning, ...meta }}>Escaped descendants not proven dead: {run.escapedDescendants.length}</Text>}
      {error && <View accessibilityRole="alert" style={{ gap: space.xxs }}>
        <Text style={{ color: r.warning, ...meta }}>Showing the last result read. The QA runs could not be refreshed: {error}. It may be out of date.</Text>
        {retry}
      </View>}
    </View>}
  </View>;
}
const HORIZONS = ['now', 'next', 'later'] as const;
const horizonTitle = (horizon: PlanEntry['horizon']) => horizon[0].toUpperCase() + horizon.slice(1);
const day = (value: string | null) => value?.slice(0, 10) ?? 'No activity';
/** What ends an idle mark. Said in one place so the read and edit copy never drift. */
const IDLE_ENDS = 'Saving a changed plan or finishing new work ends it.';

/**
 * One project's plan. Reading is the default: Now, Next and Later in order, each with its aim and
 * completion condition. "Edit plan" opens a draft: move controls, Save and Cancel, and the idle mark.
 * The draft is kept when the plan changes underneath it; Reapply or Reload settles it.
 */
function ProjectRoadmap({ section, leads, lanes, edits, selectedLane, busy, saveErrors, qaRuns, qaLoading = false, qaError, onOpenQaRun, onRetryQa, onOpenLane, onEdit, onSave, onCancel, onRetry, onCloseLane, c }: {
  section: PlanSection; leads: LeadListFacts[]; lanes: LaneView[]; edits: Record<string, PlanEdit>; selectedLane: string; busy: boolean; saveErrors?: Record<string, string>;
  qaRuns?: ProjectQaRun[]; qaLoading?: boolean; qaError?: string; onOpenQaRun?: (runId: string) => void; onRetryQa?: () => void;
  onOpenLane: (lane: string) => void; onEdit: (project: string, edit: PlanEdit) => void;
  onSave: (project: string, edit: PlanEdit) => void; onCancel: (project: string) => void; onRetry?: () => void; onCloseLane?: (lane: string) => void; c: Colors;
}) {
  const [showDone, setShowDone] = useState(false), [showUnplanned, setShowUnplanned] = useState(false);
  const [moveOpen, setMoveOpen] = useState<string | null>(null), [showIdle, setShowIdle] = useState(false);
  const [idleReason, setIdleReason] = useState('');
  const { project, latest, saved, error } = section;
  const name = project.name;
  const r = roles(c);
  const ready = Boolean(latest);
  const groups = planningPlan(latest, saved, projectLanes(project, lanes).map(lane => lane.key));
  const basePlan = [...groups.now, ...groups.next, ...groups.later];
  const edit = edits[project.key];
  const editing = Boolean(edit);
  const pending = edit?.entries ?? basePlan;
  const stale = Boolean(edit && planDraftStale(edit.version, latest));
  // Ending an existing mark is a change; a draft that leaves the mark alone is not.
  const idleChanged = typeof edit?.idle === 'string' || (edit?.idle === null && Boolean(latest?.idle));
  const changed = Boolean(edit && (!sameOrder(edit.entries, basePlan) || idleChanged));
  const active = activeSteps(pending);
  const saveError = saveErrors?.[project.key];
  // Save is refused, with the reason shown, rather than sent and failed.
  const saveBlock = !edit ? '' : stale ? 'The plan changed. Reapply or reload before saving.' : !changed ? 'No changes to save.'
    : typeof edit.idle === 'string' && active.length ? 'An idle plan has no Now or Next steps. Move them to Later or clear idle.' : '';
  const change = (patch: Partial<PlanEdit>) => { if (edit) onEdit(project.key, { ...edit, ...patch }); };
  const startEdit = () => onEdit(project.key, { entries: basePlan, version: latest?.version ?? 0 });
  const roadmap = roadmapView({ entries: pending, unplanned: groups.unplanned.filter(entry => !pending.some(item => item.lane === entry.lane)), done: latest?.done, lanes, leads });
  const counts = (item: RoadmapStep) => `${item.tasksDone} done · ${item.tasksLive} live · ${item.openLeads} open leads`;
  const doneWhen = (item: RoadmapStep) => item.doneWhenMissing
    ? <Text accessibilityLabel={`Done-when not set for ${item.lane}`} style={{ color: c.statusWarning, fontSize: 12 }}>done-when not set</Text>
    : item.doneWhen ? <Text style={{ color: c.foreground, fontSize: 12 }}>Done when: {item.doneWhen}</Text> : null;
  const controls = (item: RoadmapStep, index: number, group: RoadmapStep[]) => <View style={{ gap: 5 }}>
    <View style={row}><Button small c={c} text={moveOpen === item.lane ? "Close move options" : "Move step"} label={`Move ${item.title} in ${name}`} disabled={busy} onPress={() => setMoveOpen(moveOpen === item.lane ? null : item.lane)} /></View>
    {moveOpen === item.lane && <View accessibilityLabel={`Move ${item.title}`} style={row}>
      <Button small c={c} text="Up" label={`Move ${item.title} up`} disabled={busy || index === 0} onPress={() => { change({ entries: reorderPlan(pending, item.lane, -1) }); setMoveOpen(null); }} />
      <Button small c={c} text="Down" label={`Move ${item.title} down`} disabled={busy || index === group.length - 1} onPress={() => { change({ entries: reorderPlan(pending, item.lane, 1) }); setMoveOpen(null); }} />
      {HORIZONS.filter(horizon => horizon !== item.horizon).map(horizon => <Button key={horizon} small c={c} text={`Move to ${horizonTitle(horizon)}`} label={`Move ${item.title} to ${horizonTitle(horizon)} in ${name}`} disabled={busy} onPress={() => { change({ entries: movePlan(pending, item.lane, horizon) }); setMoveOpen(null); }} />)}
    </View>}
  </View>;
  const open = (item: RoadmapStep) => <Pressable accessibilityRole="button" accessibilityLabel={`Open lane ${item.lane}`} onPress={() => onOpenLane(item.lane)}><Text style={{ color: c.foreground, fontWeight: '600' }}>{item.title}</Text></Pressable>;
  // Spec 041: the Drained flag carries the episode's age; the prompt already went to the plan owner.
  const drained = (item: RoadmapStep) => item.drained
    ? <Text accessibilityLabel={`Drained ${item.lane}`} style={{ color: c.statusWarning, fontSize: 12 }}>Drained · {decisionAge(item.drained.since)}</Text>
    : null;
  const frame = (lane: string) => ({ padding: 9, gap: 6, borderColor: selectedLane === lane ? c.accent : c.border, borderWidth: 1, borderRadius: 7, backgroundColor: c.surface0 });
  const band = (horizon: typeof HORIZONS[number]) => {
    const group = roadmap[horizon];
    return <View key={horizon} accessibilityLabel={`${horizonTitle(horizon)} band`} style={{ gap: 7 }}>
      <Text accessibilityRole="header" style={{ color: c.foreground, fontWeight: '600' }}>{horizonTitle(horizon)}</Text>
      {group.map((item, index) => horizon === 'now'
        ? <View key={item.lane} accessibilityLabel={`Now step ${item.lane}`} style={{ ...frame(item.lane), padding: 12, gap: 7 }}>
          {open(item)}
          {Boolean(item.aim) && <Text style={{ color: c.foreground, fontSize: 13 }}>{item.aim}</Text>}
          {doneWhen(item)}
          {Boolean(item.note) && <Text style={muted(c)}>{item.note}</Text>}
          <Text style={{ ...muted(c), fontSize: 11 }}>{counts(item)} · {day(item.lastActivityAt)}</Text>
          {drained(item)}
          {editing && controls(item, index, group)}
        </View>
        : <View key={item.lane} accessibilityLabel={`${horizonTitle(horizon)} step ${item.lane}`} style={frame(item.lane)}>
          <View style={{ ...row, justifyContent: 'space-between' }}>{open(item)}<Text style={{ ...muted(c), fontSize: 11 }}>{counts(item)}</Text></View>
          {Boolean(item.aim) && <Text style={{ color: c.foreground, fontSize: 13 }}>{item.aim}</Text>}
          {doneWhen(item)}
          {drained(item)}
          {editing && controls(item, index, group)}
        </View>)}
      {!group.length && <Text style={muted(c)}>No steps here.</Text>}
    </View>;
  };
  // Idle is a deliberate mark for a plan with nothing in Now or Next. Without that, the draft says how to get there.
  const idleEditor = () => {
    if (typeof edit?.idle === 'string') return <View style={{ gap: space.xs }}>
      <Text accessibilityLabel={`Idle on purpose in draft: ${edit.idle}`} style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>Idle on purpose: {edit.idle}. {IDLE_ENDS}</Text>
      <View style={row}><Button small c={c} text="Remove idle mark" label={`Remove idle mark from ${name} draft`} disabled={busy} onPress={() => change({ idle: undefined })} /></View>
    </View>;
    // The saved plan is idle and the draft leaves that alone: ending it is an explicit choice, and the save then carries no mark.
    if (edit?.idle === null) return <View style={{ gap: space.xs }}>
      <Text style={muted(c)}>The idle mark ends when you save this plan.</Text>
      <View style={row}><Button small c={c} text="Keep idle" label={`Keep ${name} idle`} disabled={busy} onPress={() => change({ idle: undefined })} /></View>
    </View>;
    if (latest?.idle) return <View style={{ gap: space.xs }}>
      <Text accessibilityLabel={`Idle on purpose: ${latest.idle.reason}`} style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>Idle on purpose since {day(latest.idle.at)}: {latest.idle.reason}. {IDLE_ENDS}</Text>
      <View style={row}><Button small c={c} text="End idle" label={`End idle mark on ${name} plan`} disabled={busy} onPress={() => change({ idle: null })} /></View>
    </View>;
    if (active.length) {
      const now = active.filter(item => item.horizon === 'now').length, next = active.filter(item => item.horizon === 'next').length;
      const counted = [now && `${now} Now`, next && `${next} Next`].filter(Boolean).join(' and ');
      return <View style={{ gap: space.xs }}>
      <Text style={muted(c)}>Idle is for a plan with nothing in Now or Next. To go idle, move the {counted} {active.length === 1 ? 'step' : 'steps'} to Later first.</Text>
      <View style={row}><Button small c={c} text="Move all to Later" label={`Move all ${name} steps to Later`} disabled={busy} onPress={() => change({ entries: pending.map(item => ({ ...item, horizon: 'later' as const })) })} /></View>
    </View>;
    }
    return <View style={{ gap: space.xs }}>
      <Field label="Idle reason" placeholder="Why nothing is planned now" value={idleReason} onChange={value => setIdleReason(value.slice(0, 300))} c={c} detail={`Idle is for a plan with nothing in Now or Next. ${IDLE_ENDS}`} disabled={busy} />
      <View style={row}><Button small c={c} text="Mark plan idle" label={`Mark ${name} plan idle`} disabled={busy || !idleReason.trim()} onPress={() => { change({ idle: idleReason.trim() }); setIdleReason(''); }} /></View>
    </View>;
  };
  const panelBox = { gap: space.xs, padding: space.sm, borderRadius: radius.control, borderWidth: 1, backgroundColor: r.section } as const;
  return <View accessibilityLabel={`Plan for ${name}`} style={{gap:10}}>
    <View style={{...row,justifyContent:'space-between'}}><Text accessibilityRole="header" style={{color:c.foreground,fontSize:16,fontWeight:'600'}}>Plan · {name}{project.visibility === 'parked' ? ' · parked' : ''}</Text><View style={row}>
      {ready && !editing && <ActionButton c={c} action="edit" label={`Edit ${name} plan`} disabled={busy} onPress={startEdit} />}</View></View>
    {!ready && (error
      ? <View accessibilityRole="alert" style={panelBox}><Text style={{ color: r.foreground }}>Couldn’t load this plan: {error}</Text>{onRetry && <View style={row}><Button small c={c} text="Retry plan" label={`Retry ${name} plan`} disabled={busy} onPress={onRetry} /></View>}</View>
      : <Text style={muted(c)}>Loading plan…</Text>)}
    {ready && latest && <>
    {error && <View accessibilityRole="alert" style={panelBox}><Text style={{ color: r.warning, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>Showing version {latest.version}. The latest plan could not be refreshed: {error}. It may be out of date.</Text>{onRetry && <View style={row}><Button small c={c} text="Retry refresh" label={`Retry refreshing ${name} plan`} disabled={busy} onPress={onRetry} /></View>}</View>}
    {edit && stale && <View accessibilityRole="alert" accessibilityLabel={`Plan changed for ${name}`} style={{ ...panelBox, borderColor: r.warning }}>
      <Text style={{ color: r.foreground, fontWeight: '600' }}>The plan changed while you were editing</Text>
      <Text style={muted(c)}>Version {latest.version} is saved now. Your draft is based on version {edit.version} and is kept.</Text>
      <Text style={muted(c)}>Reapply keeps your order and Now, Next and Later choices for steps the saved plan still has. Reload discards the draft.</Text>
      <View style={row}>
        <Button small c={c} text="Reapply my changes" label={`Reapply my changes to ${name} plan`} disabled={busy} onPress={() => onEdit(project.key, { ...edit, entries: rebaseDraft(edit.entries, basePlan), version: latest.version })} />
        <Button small c={c} text="Reload plan" label={`Reload ${name} plan and discard draft`} disabled={busy} onPress={() => onCancel(project.key)} />
      </View>
    </View>}
    {edit ? <View accessibilityLabel={`Draft plan for ${name}`} style={{ ...panelBox, borderColor: r.accent }}>
      <Text style={{ color: r.foreground, fontWeight: '600' }}>Draft · based on version {edit.version}</Text>
      <Text style={muted(c)}>{changed ? 'Unsaved changes. Nothing is saved until you press Save plan.' : 'No changes yet.'}</Text>
      {saveError && !stale && <Text accessibilityRole="alert" style={{ color: r.warning, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>Not saved: {saveError}. Your draft is kept.</Text>}
      <View style={row}>
        <Button small c={c} text="Save plan" label={`Save ${name} plan`} disabled={busy || Boolean(saveBlock)} hint={saveBlock || undefined} onPress={() => onSave(project.key, edit)} />
        <Button small c={c} text="Cancel" label={`Cancel ${name} plan changes`} disabled={busy} onPress={() => onCancel(project.key)} />
      </View>
      {saveBlock && <Text style={muted(c)}>{saveBlock}</Text>}
    </View> : <Text style={muted(c)}>Version {latest.version}</Text>}
    {!edit && latest.idle && <Text accessibilityLabel={`Idle on purpose: ${latest.idle.reason}`} style={{color:c.foreground,fontSize:12}}>Idle on purpose since {day(latest.idle.at)}: {latest.idle.reason}. {IDLE_ENDS}</Text>}
    {edit && <View style={{gap:space.xs}}>
      <View style={row}><Button small c={c} text={showIdle ? "Hide idle options" : "Idle options"} label={`${showIdle ? "Hide" : "Show"} idle options for ${name} plan`} onPress={() => setShowIdle(!showIdle)} /></View>
      {showIdle && idleEditor()}
    </View>}
    {!latest.version && !pending.length && <Text style={muted(c)}>No plan yet.{roadmap.unplanned.length ? (editing ? ' Add the unplanned lanes below to start one.' : ' Edit plan to start one from the unplanned lanes below.') : ' No lanes for this project yet.'}</Text>}
    {HORIZONS.map(band)}
    <View accessibilityLabel="Done band" style={{gap:6}}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Done, ${roadmap.done.length}`} accessibilityState={{expanded:showDone}} onPress={()=>setShowDone(!showDone)}><Text style={{color:c.foreground,fontWeight:'600'}}>{showDone?'▾':'▸'} Done · {roadmap.done.length}</Text></Pressable>
      {showDone&&roadmap.done.map(item=><View key={item.lane} accessibilityLabel={`Done step ${item.lane}`} style={frame(item.lane)}>
        <View style={{...row,justifyContent:'space-between'}}><Pressable accessibilityRole="button" accessibilityLabel={`Open lane ${item.lane}`} onPress={()=>onOpenLane(item.lane)}><Text style={{color:c.foreground,fontWeight:'600'}}>{item.title}</Text></Pressable><Text style={{...muted(c),fontSize:11}}>{item.status} · {day(item.closedAt)}</Text></View>
        {Boolean(item.note)&&<Text style={muted(c)}>{item.note}</Text>}
      </View>)}
      {showDone&&!roadmap.done.length&&<Text style={muted(c)}>Nothing finished yet.</Text>}
    </View>
    {roadmap.unplanned.length>0&&<View accessibilityLabel="Unplanned lanes" style={{gap:6}}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${roadmap.unplanned.length} unplanned lanes`} accessibilityState={{expanded:showUnplanned}} onPress={()=>setShowUnplanned(!showUnplanned)}><Text style={{color:c.foreground,fontWeight:'600'}}>{showUnplanned?'▾':'▸'} {roadmap.unplanned.length} unplanned lanes</Text></Pressable>
      {showUnplanned&&roadmap.unplanned.map(item=><View key={item.lane} style={{...row,justifyContent:'space-between',borderColor:c.border,borderWidth:1,borderRadius:7,padding:8}}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Open lane ${item.lane}`} onPress={()=>onOpenLane(item.lane)}><Text style={{color:c.foreground}}>{item.title}</Text></Pressable>
        <View style={row}>{editing ? <ActionButton c={c} action="add" label={`Add ${item.lane} to ${name} plan`} disabled={busy} onPress={()=>change({entries:[...pending,{lane:item.lane,note:item.note,horizon:'later'}]})}/> : <Text style={muted(c)}>Edit plan to add</Text>}{onCloseLane&&<Button small c={c} text="Close" label={`Close lane ${item.lane}`} disabled={busy} onPress={()=>onCloseLane(item.lane)}/>}</View>
      </View>)}
    </View>}
    </>}
    <View style={{ gap: 6, borderTopColor: c.border, borderTopWidth: 1, paddingTop: 10 }}><ProjectQaLatest project={project} runs={qaRuns} loading={qaLoading} error={qaError} onOpenRun={onOpenQaRun} onRetry={onRetryQa} c={c} /></View>
  </View>;
}

/** Spec 041 Planning tab, following the header's project selector. One project in scope shows
 * its roadmap; several show one compact row each, expanded one at a time. Beside it the Lane
 * column; at the compact size a plan, then lane, drill-down with a back control. */
/** The collapsed group of projects with no planner and no live owner record: silent, and read-only. */
function DormantGroup({ projects, c, children }: { projects: Project[]; c: Colors; children?: (project: Project) => ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!projects.length) return null;
  return <View accessibilityLabel="Dormant projects" style={{ gap: 6 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Dormant projects, ${projects.length}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
      <Text style={{ color: c.foreground, fontWeight: "600" }}>{open ? "▾" : "▸"} Dormant projects</Text><Text style={muted(c)}>{projects.length}</Text></Pressable>
    {open && projects.map(project => <View key={project.key} style={{ gap: 6, padding: 8, borderWidth: 1, borderColor: c.border, borderRadius: 7, backgroundColor: c.surface0 }}>
      <Text numberOfLines={1} style={{ color: c.foreground, fontWeight: "600", fontSize: 13 }}>{project.name}</Text>
      {children?.(project)}
    </View>)}
  </View>;
}

export function PlanningProjectChooser({ projects, selection, onSelect, compact, c }: {
  projects: Project[]; selection: readonly string[]; onSelect: (keys: string[]) => void; compact: boolean; c: Colors;
}) {
  const [open, setOpen] = useState(false);
  const chosen = effectiveSelection(projects, selection);
  const label = laneFinderScopeLabel(projects, selection);
  const r = roles(c);
  const pick = (keys: string[]) => { onSelect(keys); setOpen(false); };
  const option = (name: string, keys: string[], selected: boolean, a11y: string) => <Pressable key={a11y} accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ selected }}
    onPress={() => pick(keys)} style={{ ...row, justifyContent: "space-between", minHeight: 40, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.control,
      borderWidth: 1, borderColor: selected ? r.accent : r.border, backgroundColor: selected ? r.raised : r.section }}>
    <Text numberOfLines={1} style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, flexShrink: 1 }}>{name}</Text>
    {selected && <Text style={{ color: r.accent, fontSize: type.metadata.fontSize }}>Selected</Text>}
  </Pressable>;
  const panel = <View accessibilityLabel="Planning project chooser" style={{ gap: space.xxs, padding: space.sm }}>
    {option("All projects", [], !chosen.length, "Choose all projects")}
    {chooserProjects(projects).map(project => option(`${project.name}${project.visibility === "parked" ? " · parked" : ""}`, [project.key], chosen.includes(project.key), `Choose project ${project.name}`))}
    {!projects.length && <Text style={muted(c)}>No projects yet.</Text>}
  </View>;
  return <View style={{ minWidth: 150, maxWidth: "100%", position: "relative", zIndex: open ? 30 : 0 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Project: ${label}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
      style={{ minHeight: 34, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs, paddingHorizontal: space.sm, paddingVertical: space.xs,
        borderRadius: radius.control, borderWidth: 1, borderColor: chosen.length ? r.accent : r.border, backgroundColor: r.section }}>
      <Text numberOfLines={1} style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, flexShrink: 1 }}>{label}</Text>
      <Text style={{ color: r.muted, fontSize: type.metadata.fontSize }}>{open ? "▴" : "▾"}</Text>
    </Pressable>
    {open && !compact && <View style={{ position: "absolute", top: 38, right: 0, width: 300, borderWidth: 1, borderColor: r.border, borderRadius: radius.panel, backgroundColor: r.section,
      shadowColor: overlay.shadow, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.38, shadowRadius: 14, elevation: 12, zIndex: 30 }}>{panel}</View>}
    {open && compact && <Modal visible transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={{ flex: 1, justifyContent: "center", padding: space.md, backgroundColor: overlay.scrim }}>
        <View accessibilityViewIsModal style={{ width: "100%", maxWidth: 520, maxHeight: "90%", alignSelf: "center", borderRadius: radius.panel, borderWidth: 1, borderColor: r.border, backgroundColor: r.section }}>
          <View style={{ ...row, justifyContent: "space-between", paddingHorizontal: space.sm, paddingTop: space.sm }}>
            <Text accessibilityRole="header" style={{ color: r.foreground, fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, fontWeight: "600" }}>Project</Text>
            <ActionButton c={c} action="close" label="Close project chooser" onPress={() => setOpen(false)} />
          </View>
          {panel}
        </View>
      </View>
    </Modal>}
  </View>;
}

const statusWord: Record<LaneView["status"], string> = { active: "Active", paused: "Paused", done: "Done", abandoned: "Abandoned" };

/**
 * A lane's projects and its place in each project's own plan (nucleus#866). A
 * lane lists repositories, so it can belong to several projects; each project's
 * plan orders it separately and there is no single global order. "Show plan"
 * moves the chooser to that project and keeps the lane open, so the originating
 * context is never lost.
 */
export function LaneProjects({ lane, projects, plans, selected = [], busy = false, onSelectProject, c }: {
  lane: Pick<LaneView, "key" | "title" | "repositories">; projects: Project[]; plans: ProjectPlan[]; selected?: readonly string[];
  busy?: boolean; onSelectProject?: (project: string) => void; c: Colors;
}) {
  const places = lanePlaces(lane, projects, plans);
  const shared = places.length > 1;
  const r = roles(c);
  return <View accessibilityLabel={`Projects for ${lane.title}`} style={{ gap: space.xs }}>
    <Text accessibilityRole="header" style={{ color: r.foreground, fontWeight: "600", fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>Projects</Text>
    {!places.length && <Text style={muted(c)}>No project lists this lane's repositories yet.</Text>}
    {places.map(place => <View key={place.key} accessibilityLabel={`${place.name}: ${lanePlaceLabel(place)}`}
      style={{ ...row, justifyContent: "space-between", gap: space.xs, padding: space.xs, borderWidth: 1, borderColor: selected.includes(place.key) ? r.accent : r.border, borderRadius: radius.control, backgroundColor: r.section }}>
      <View style={{ flexShrink: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>{place.name}{place.parked ? " · parked" : ""}</Text>
        <Text style={{ color: r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{lanePlaceLabel(place)}</Text>
      </View>
      {onSelectProject && !selected.includes(place.key) && <Button small c={c} text="Show plan" label={`Show the ${place.name} plan with this lane open`} disabled={busy} onPress={() => onSelectProject(place.key)} />}
    </View>)}
    {shared && <Text style={{ ...muted(c), fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>Shared by {places.length} projects, so each project's plan orders this lane separately. There is no single order across projects.</Text>}
  </View>;
}

/**
 * "Find lanes": the search that replaces the separate Lanes destination
 * (nucleus#866). It searches the lane records the agent CLI reads, with a scope
 * that is either the chosen project or a clearly labelled all-projects scope. A
 * result names its project and status; opening it keeps the originating plan
 * context, because the plan column stays where it was.
 */
export function LaneFinderResults({ rows, total, query, loading, error, plansError, allProjects = true, onRetry, onOpenLane, selectedLane, c }: {
  rows: LaneFinderRow[]; total: number; query: string; loading: boolean; error?: string; plansError?: string;
  /** Whether the search already spans every project, so the copy never offers a scope that is already in force. */
  allProjects?: boolean;
  onRetry?: () => void; onOpenLane: (lane: string) => void; selectedLane: string; c: Colors;
}) {
  const r = roles(c);
  // A failed read is said first: the board has no lane list yet while it is failing, and
  // "Loading…" would hide the failure behind a spinner that never resolves (#866 review).
  if (error) return <View accessibilityRole="alert" style={{ gap: space.xs, padding: space.sm, borderRadius: radius.control, borderWidth: 1, borderColor: r.danger, backgroundColor: r.section }}>
    <Text style={{ color: r.foreground }}>Couldn't load lanes: {error}</Text>
    <Text style={{ ...muted(c), fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>The list may be incomplete. Nothing found here is a total until it loads.</Text>
    {onRetry && <View style={row}><Button small c={c} text="Retry lanes" label="Retry loading lanes" onPress={onRetry} /></View>}
  </View>;
  if (loading) return <Text style={muted(c)}>Loading lanes…</Text>;
  const needle = query.trim();
  return <View style={{ gap: space.xs }}>
    <View style={{ ...row, justifyContent: "space-between" }}>
      <Text accessibilityLabel="Lane search count" style={{ ...muted(c), fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{laneFinderCount(rows.length, total)}</Text>
      {plansError && <Text accessibilityRole="alert" style={{ color: r.warning, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight, flexShrink: 1 }}>Plan positions may be out of date: {plansError}</Text>}
    </View>
    {!rows.length && (needle
      ? <Text style={{ color: r.foreground }}>No lanes match “{needle}”. Clear the search{allProjects ? '' : ' or search all projects'}.</Text>
      : <Text style={{ color: r.foreground }}>No lanes in this scope.{allProjects ? '' : ' Search all projects to look wider.'}</Text>)}
    {rows.map(row => <Pressable key={row.key} accessibilityRole="button" accessibilityLabel={`Open lane ${row.title}, ${row.places.map(place => place.name).join(" and ")}, ${statusWord[row.status]}`}
      onPress={() => onOpenLane(row.key)} style={{ gap: space.xxs, padding: space.sm, borderRadius: radius.card, borderWidth: 1, borderColor: selectedLane === row.key ? r.accent : r.border, backgroundColor: r.section }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.xs }}>
        <Text numberOfLines={1} style={{ color: r.foreground, fontWeight: "600", fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, flexShrink: 1, minWidth: 0 }}>{row.title}</Text>
        <Text style={{ flexShrink: 0, color: row.status === "active" ? r.foreground : r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{statusWord[row.status]}</Text>
      </View>
      {Boolean(row.aim) && <Text numberOfLines={2} style={{ color: r.foreground, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{row.aim}</Text>}
      <Text style={{ color: r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>
        {row.places.map(place => `${place.name} · ${lanePlaceLabel(place)}`).join("  ·  ")}
      </Text>
    </Pressable>)}
  </View>;
}

export function PlanningTab({ sections: allSections, leads = [], lanes, projects: allProjects, selection = [], plans: allPlans, plansError, lanesLoading = false, lanesError, edits, saveErrors, selectedLane, step, compact, busy, lanePanel, qaRuns, qaLoading = false, qaError, onOpenQaRun, onRetryQa, onRetryPlans, onRetryLanes, onStep, onOpenLane, onSelectProjects, onEdit, onSave, onCancel, onCloseLane, c }: {
  sections: PlanSection[]; leads?: LeadListFacts[]; lanes: LaneView[]; edits: Record<string, PlanEdit>; saveErrors?: Record<string, string>; selectedLane: string; step: PlanningStep; compact: boolean; busy: boolean; lanePanel: ReactNode;
  /** The latest milestone QA per repository; `qaLoading` and `qaError` keep a first and a failed read apart from no run. */
  qaRuns?: ProjectQaRun[]; qaLoading?: boolean; qaError?: string; onOpenQaRun?: (runId: string) => void; onRetryQa?: () => void;
  /** Every project and its plan, so the chooser and the lane search see past the tab's own scope. */
  projects?: Project[]; selection?: readonly string[]; plans?: ProjectPlan[];
  /** A plan read that failed keeps its last version; the lane search then says its positions may be stale. */
  plansError?: string; lanesLoading?: boolean; lanesError?: string;
  onSelectProjects?: (keys: string[]) => void; onRetryLanes?: () => void;
  /** Reads the plans again after a failed read. */
  onRetryPlans?: () => void;
  onStep: (step: PlanningStep) => void; onOpenLane: (lane: string) => void; onEdit: (project: string, edit: PlanEdit) => void;
  onSave: (project: string, edit: PlanEdit) => void; onCancel: (project: string) => void; onCloseLane?: (lane: string) => void; c: Colors;
}) {
  const [query, setQuery] = useState("");
  const [browse, setBrowse] = useState(false);
  const [allScope, setAllScope] = useState(false);
  const projects = allProjects ?? allSections.map(section => section.project);
  const plans = allPlans ?? allSections.flatMap(section => [section.latest, section.saved]).filter((plan): plan is ProjectPlan => Boolean(plan));
  // The search follows the chooser unless the operator asks for the all-projects scope, which is always labelled.
  const searching = Boolean(query.trim()) || browse;
  const searchSelection = allScope || !effectiveSelection(projects, selection).length ? [] : selection;
  const scopeLabel = laneFinderScopeLabel(projects, searchSelection);
  // The finder reads the lane records only while it is open; the plan column costs nothing otherwise.
  const scoped = searching ? laneFinderRows({ lanes, projects, plans, selection: searchSelection }) : [];
  const rows = searching ? laneFinderRows({ lanes, projects, plans, selection: searchSelection, query }) : [];
  const dormant = allSections.filter(section => projectDormant(section.project) && section.project.visibility !== 'parked').map(section => section.project);
  const sections = allSections.filter(section => !dormant.includes(section.project));
  const visible = planningColumns(compact, step);
  const [expanded, setExpanded] = useState<string | null>(null);
  const roadmapProps = { leads, lanes, edits, saveErrors, selectedLane, busy, qaRuns, qaLoading, qaError, onOpenQaRun, onRetryQa, onOpenLane, onEdit, onSave, onCancel, onCloseLane, c };
  const roadmapFor = (section: PlanSection) => <ProjectRoadmap section={section} {...roadmapProps} onRetry={onRetryPlans} />;
  const summary = (section: PlanSection) => {
    const planError = section.error ?? plansError;
    if (planError) return { state: 'error' as const, subject: 'the plan', error: planError };
    if (lanesError) return { state: 'error' as const, subject: 'lanes', error: lanesError };
    if (lanesLoading || !section.latest)
      return { state: 'loading' as const };
    const groups = planningPlan(section.latest, section.saved, projectLanes(section.project, lanes).map(lane => lane.key));
    const view = roadmapView({ entries: [...groups.now, ...groups.next, ...groups.later], unplanned: [], lanes, leads });
    const steps = [...view.now, ...view.next, ...view.later];
    const projectLaneKeys = new Set(projectLanes(section.project, lanes).map(lane => lane.key));
    const attention = lanes.filter(lane => projectLaneKeys.has(lane.key)).reduce((sum, lane) => sum + (lane.liveByPhase.blocked ?? 0) + (lane.liveByPhase.error ?? 0) + (lane.liveByPhase.needs_attention ?? 0), 0);
    return { state: 'ready' as const, aim: view.now[0]?.aim || view.now[0]?.title || (section.latest.idle ? `Idle on purpose · ${section.latest.idle.reason}` : 'No current aim'), attention };
  };
  const clearSearch = () => { setQuery(""); setBrowse(false); };
  const chosenScope = effectiveSelection(projects, selection);
  const allScopeOn = !chosenScope.length || allScope;
  const planColumn = <ScrollView accessibilityLabel="Planning plan" style={{flex:1,minHeight:0,backgroundColor:c.surface1,borderColor:c.border,borderWidth:1,borderRadius:8}} contentContainerStyle={{padding:12,gap:14}}>
    {!allSections.length&&<Text style={muted(c)}>No projects yet.</Text>}
    {sections.length===1&&roadmapFor(sections[0])}
    {sections.length>1&&sections.map(section=>{
      const open=expanded===section.project.key, info=summary(section);
      return <View key={section.project.key} style={{gap:10}}>
        <View style={{gap:5,padding:10,borderColor:c.border,borderWidth:1,borderRadius:7,backgroundColor:c.surface0}}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Project row ${section.project.name}`} accessibilityState={{expanded:open}} onPress={()=>setExpanded(open?null:section.project.key)} style={{gap:3}}>
            <Text style={{color:c.foreground,fontWeight:'600'}}>{open?'▾':'▸'} {section.project.name}{section.project.visibility==='parked'?' · parked':''}</Text>
            {info.state==='ready' ? <>
              {info.attention > 0 && <Text accessibilityLabel={`${info.attention} blocked or attention tasks`} style={{color:c.statusWarning,fontSize:12,fontWeight:'600'}}>{info.attention} need attention</Text>}
              <Text numberOfLines={2} style={{...muted(c),fontSize:12}}>{info.aim}</Text>
            </> : <Text accessibilityLabel={`${info.state === 'loading' ? 'Loading plan' : 'Plan unavailable'} for ${section.project.name}`} accessibilityRole={info.state === 'error' ? 'alert' : undefined} style={muted(c)}>
              {info.state === 'loading' ? 'Loading…' : `Couldn’t load ${info.subject}: ${info.error}`}
            </Text>}
          </Pressable>
          {info.state==='error'&&onRetryPlans&&<Button small c={c} text="Retry" label={`Retry plan and lane reads for ${section.project.name}`} onPress={onRetryPlans} />}
        </View>
        {open&&roadmapFor(section)}
      </View>;
    })}
    <DormantGroup projects={dormant} c={c}/>
  </ScrollView>;
  const laneColumn = <ScrollView accessibilityLabel="Planning lane" style={{flex:1,minHeight:0,backgroundColor:c.surface1,borderColor:c.border,borderWidth:1,borderRadius:8}} contentContainerStyle={{padding:12,gap:10}}>
    {lanePanel}
  </ScrollView>;
  const searchColumn = <ScrollView accessibilityLabel="Lane search results" style={{flex:1,minHeight:0,backgroundColor:c.surface1,borderColor:c.border,borderWidth:1,borderRadius:8}} contentContainerStyle={{padding:12,gap:10}}>
    <LaneFinderResults rows={rows} total={scoped.length} query={query} loading={lanesLoading} error={lanesError} plansError={plansError} allProjects={allScopeOn} onRetry={onRetryLanes} onOpenLane={onOpenLane} selectedLane={selectedLane} c={c}/>
  </ScrollView>;
  return <>
      {compact && step==='lane' && <Button small c={c} icon="ChevronLeft" text="Back to plan" onPress={()=>onStep('plan')}/>}
      {/* The chooser and the search live inside Planning: nothing joins the board header (Tom, 2026-11-07). */}
      <View accessibilityLabel="Planning header" style={{gap:space.xs,paddingBottom:space.xs}}>
        <View style={{...row,justifyContent:'space-between'}}>
          <Text accessibilityRole="header" style={{color:c.foreground,fontSize:type.page.fontSize,lineHeight:type.page.lineHeight,fontWeight:'600'}}>Planning</Text>
          {Boolean(projects.length)&&onSelectProjects&&<PlanningProjectChooser projects={projects} selection={selection} onSelect={onSelectProjects} compact={compact} c={c}/>}
        </View>
        <View style={row}>
          <View style={{flexGrow:1,flexShrink:1,minWidth:170,maxWidth:420}}>
            <TextInput accessibilityLabel="Find lanes" value={query} onChangeText={setQuery} placeholder="Find lanes" placeholderTextColor={roles(c).muted} autoCapitalize="none" autoCorrect={false}
              style={{...controlFrame(c),...controlText(c)}}/>
          </View>
          <View style={row}>
            {Boolean(chosenScope.length)&&<Button small c={c} text={laneFinderScopeLabel(projects,chosenScope)}
              label={`Search lanes in ${laneFinderScopeLabel(projects,chosenScope)}`} selected={!allScopeOn} onPress={()=>setAllScope(false)}/>}
            <Button small c={c} text="All projects" label="Search lanes in all projects" selected={allScopeOn} onPress={()=>setAllScope(true)}/>
          </View>
          {searching?<Button small c={c} text="Back to plan" label="Close lane search" onPress={clearSearch}/>:<Button small c={c} text="Browse all lanes" label="Browse all lanes" onPress={()=>setBrowse(true)}/>}
        </View>
        {searching&&<Text accessibilityLabel="Lane search scope" style={{...muted(c),fontSize:type.metadata.fontSize,lineHeight:type.metadata.lineHeight}}>Searching {scopeLabel==='All projects'?'all projects':scopeLabel}. {query.trim()?'Results match the title, aim or project.':'Every lane in scope is listed.'}</Text>}
      </View>
      <View style={{flex:1,minHeight:0,flexDirection:compact?'column':'row',gap:12}}>
        {searching
          ? (compact && step==='lane' ? laneColumn : <>{searchColumn}{!compact&&visible.includes('lane')&&laneColumn}</>)
          : <>{visible.includes('plan')&&planColumn}{visible.includes('lane')&&laneColumn}</>}
      </View>
  </>;
}
