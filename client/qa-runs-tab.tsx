import { errorText } from "./error-text";
import React, { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ActionButton, Button, Disclosure, TextLink, controlFrame, controlText, muted, row, type Colors } from "./controls";
import { overlay, radius, touchTarget, type as typeScale, space } from "./design";
import { canRetryTeardown, ProjectQaFailures, ProjectQaLogWriteErrors } from "./planning-panel";
import { formatTelemetryDuration } from "../shared/telemetry";
import { scopeContains } from "../shared/project-scope";
import { taskNumberLabel, type HostRunAccountingList, type HostRunAccountingListEntry, type HostRunRecord, type Project, type ProjectQaRun, type QaFence, type QaInventoryItem, type TaskSummary } from "../shared/contracts";
import { QaFenceNotice } from "./qa-fence-notice";

type RunKind = "Milestone QA" | "Task validation" | "Client run";
type QaRunRow = {
  run: HostRunRecord;
  qa?: ProjectQaRun;
  project?: Project;
  taskId?: string;
  task?: TaskSummary;
  kind: RunKind;
  commit: string | null;
  /** Queue's private accounting retirement bound to this exact run and epoch, if any. */
  retirement?: HostRunAccountingListEntry;
  /** A stored retirement this build could not bind: the run stays charged and live. */
  retirementUnreadable?: boolean;
};

/**
 * Spec 035 "Retired runs on the board": which unsettled runs the bulk
 * accounting read says are retired, bound to each run's exact id and epoch.
 * A run the read does not cover, a different epoch, an unreadable record or a
 * failed read all leave the run charged and on the live list.
 */
export type RunAccounting = {
  retired: Map<string, HostRunAccountingListEntry>;
  unreadable: Set<string>;
  /** Shown on the live list when some retired runs may still appear there. */
  notice: string | null;
};
export function runAccounting(runs: HostRunRecord[] | undefined, list: HostRunAccountingList | undefined, error: unknown): RunAccounting {
  const retired = new Map<string, HostRunAccountingListEntry>();
  const unreadable = new Set<string>();
  if (error) return { retired, unreadable, notice: `Retired-run status could not be read (${errorText(error)}); runs whose slot was freed may still show here.` };
  if (!list) return { retired, unreadable, notice: null };
  const live = new Map((runs ?? []).filter(run => run.state !== "settled").map(run => [run.id, run] as const));
  for (const entry of list.entries) {
    const run = live.get(entry.runId);
    if (!run || run.epoch !== entry.epoch) continue;
    if (entry.accounting === "retired") retired.set(entry.runId, entry);
    else unreadable.add(entry.runId);
  }
  return { retired, unreadable, notice: list.complete ? null : "More runs have retired accounting than one read returns; some may still show here." };
}
/** Live board work: queued, admitted or running runs whose accounting is not retired, and settled runs still holding capacity. */
export function liveHostRun(run: HostRunRecord, accounting?: RunAccounting): boolean {
  if (run.state === "settled") return hostRunHoldsCapacity(run);
  return !accounting?.retired.has(run.id);
}

const hostRunHoldsCapacity = (run: HostRunRecord) => {
  const holdsContainer = run.containers.some(container => container.removed !== true);
  const holdsEscapedDescendants = Boolean(run.settlement?.result?.escapedDescendants.length && !run.escapedDescendantsProvenDeadAt);
  return !run.capacityReleasedAt && (holdsContainer || holdsEscapedDescendants);
};

function validationIdentity(caller: string): { taskId: string; commit: string } | null {
  const match = /^queue:validation:(.+):([a-f0-9]{40})$/.exec(caller);
  return match ? { taskId: match[1], commit: match[2] } : null;
}

function projectForRun(projects: Project[], run: HostRunRecord): Project | undefined {
  return projects.find(project => project.repositories.some(repository =>
    repository.origin && run.repository.origin
      ? repository.origin === run.repository.origin
      : Boolean(repository.path && run.repository.path && repository.path === run.repository.path)));
}

function rowsForRuns(runs: HostRunRecord[] = [], qaRuns: ProjectQaRun[] = [], projects: Project[], tasks: TaskSummary[], accounting?: RunAccounting): QaRunRow[] {
  const qaById = new Map(qaRuns.map(run => [run.id, run] as const));
  return runs.map(run => {
    const qa = qaById.get(run.id);
    const validation = validationIdentity(run.caller);
    const kind: RunKind = run.caller.startsWith("queue:milestone:") ? "Milestone QA"
      : run.caller.startsWith("queue:validation:") ? "Task validation" : "Client run";
    return {
      run, qa, project: projectForRun(projects, run),
      taskId: validation?.taskId,
      task: validation ? tasks.find(task => task.id === validation.taskId) : undefined,
      kind, commit: qa?.base ?? validation?.commit ?? null,
      retirement: accounting?.retired.get(run.id),
      retirementUnreadable: accounting?.unreadable.has(run.id) ?? false,
    };
  });
}

function runOutcome(row: QaRunRow): string | null {
  if (row.qa?.capacityUnavailable || row.run.settlement?.outcome === "capacity_timeout") return "Capacity unavailable";
  if (row.qa?.state === "passed") return "Passed";
  if (row.qa?.state === "failed") return "Failed";
  if (row.qa?.state === "cancelled") return "Cancelled";
  if (row.qa?.state === "timed_out") return "Timed out";
  if (row.qa?.state === "lost") return "Lost";
  if (row.qa?.state === "hold") return "Needs attention";
  const outcome = row.run.settlement?.outcome;
  if (outcome === "passed") return "Passed";
  if (outcome === "failed") return "Failed";
  if (outcome === "cancelled") return "Cancelled";
  if (outcome === "timed_out") return "Timed out";
  if (outcome === "lost") return "Lost";
  return row.run.state === "settled" ? "Unknown result" : null;
}

function badgeColor(label: string, c: Colors): string {
  const outcome = label.split(" · ", 1)[0];
  if (outcome === "Failed" || outcome === "Lost") return c.statusDanger;
  if (outcome === "Timed out" || outcome === "Capacity unavailable" || outcome === "Needs attention") return c.statusWarning;
  if (outcome === "Passed") return c.accent;
  return c.foregroundMuted;
}

function OutcomeBadge({ label, c }: { label: string; c: Colors }) {
  const color = badgeColor(label, c);
  return <View accessible accessibilityLabel={`Outcome ${label}`} style={{ borderRadius: radius.control, borderWidth: 1, borderColor: color, paddingHorizontal: space.xs, paddingVertical: space.xxs }}>
    <Text style={{ color, fontSize: typeScale.metadata.fontSize, fontWeight: "600" }}>{label}</Text>
  </View>;
}

/** The honest history label for a retired run: accounting only, the pinned outcome and custody unknown, the producer's verdict attributed. */
function retiredLabel(entry: HostRunAccountingListEntry): string {
  return `Retired · outcome unknown · custody unknown${entry.producer ? ` · producer reported ${entry.producer.verdict}` : ""}`;
}

function rowState(row: QaRunRow): string {
  if (row.retirement) return retiredLabel(row.retirement);
  if (row.retirementUnreadable && row.run.state === "running") return "Running · retirement unreadable";
  if (row.run.state === "queued") return `Queued${row.run.position ? ` #${row.run.position}` : ""}`;
  if (row.run.state === "admitted") return "Admitted";
  if (row.run.state === "running") return "Running";
  return `${runOutcome(row) ?? "Finished"}${hostRunHoldsCapacity(row.run) ? " · capacity held" : ""}`;
}

function firstLine(value: string | null | undefined): string | null {
  const lines = value?.split(/\r?\n/).map(line => line.trim()).filter(Boolean) ?? [];
  const line = lines.at(-1)?.replace(/\s+/g, " ");
  if (!line) return null;
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

function failureSummary(row: QaRunRow): string {
  const fromOutput = firstLine(row.qa?.outputTail)
    ?? firstLine(row.qa?.steps.flatMap(step => [step.stderrTail, step.stdoutTail]).join("\n"));
  if (fromOutput) return fromOutput;
  const result = row.run.settlement?.result;
  if (result?.signal) return `Run ended with ${result.signal}`;
  if (result?.exitCode !== null && result?.exitCode !== undefined) return `Run exited with code ${result.exitCode}`;
  return "No failure details were recorded.";
}

/** Who retired a run's accounting, in the board's words. */
function retiredBy(format: string | null): string {
  if (format === "queue.host-run.accounting-retirement") return "on the producer's cleanup";
  if (format === "queue.host-run.accounting-absence-retirement") return "its hook died and Effigy holds no record of it";
  return "by the operator";
}

function activityText(row: QaRunRow, now: boolean): string {
  const { run, qa } = row;
  if (row.retirement) {
    const at = row.retirement.disposedAt;
    return `Accounting retired ${at ? new Date(at).toLocaleString() : "time unavailable"} · ${retiredBy(row.retirement.format)}`;
  }
  if (now && run.state !== "settled") {
    const queuedFor = Math.max(0, Date.now() - Date.parse(run.submittedAt));
    if (!run.launchedAt) return `Waiting ${formatTelemetryDuration(queuedFor)}`;
    return `Running ${formatTelemetryDuration(Math.max(0, Date.now() - Date.parse(run.launchedAt)))}`;
  }
  if (now) {
    const settledAt = run.settledAt ?? qa?.finishedAt;
    const age = settledAt ? formatTelemetryDuration(Math.max(0, Date.now() - Date.parse(settledAt))) : "—";
    return `Finished ${age} ago · ran ${formatTelemetryDuration(run.wallMs ?? qa?.durationMs ?? 0)}`;
  }
  const finishedAt = run.settledAt ?? qa?.finishedAt;
  return `Finished ${finishedAt ? new Date(finishedAt).toLocaleString() : "time unavailable"} · ran ${formatTelemetryDuration(run.wallMs ?? qa?.durationMs ?? 0)}`;
}

function RunRow({ row, now, onSelect, onOpenTask, onRelease, c }: {
  row: QaRunRow; now: boolean; onSelect: () => void; onOpenTask: (taskId: string) => void;
  onRelease: (runId: string, reason: string) => void; c: Colors;
}) {
  const [reason, setReason] = useState("");
  const held = hostRunHoldsCapacity(row.run);
  const outcome = runOutcome(row);
  const badge = rowState(row);
  const accessibleResult = outcome === "Failed" ? failureSummary(row) : activityText(row, now);
  const taskLabel = row.task?.number ? taskNumberLabel(row.task, false) : row.task?.reference ?? row.task?.title ?? row.taskId ?? "—";
  const containerHeld = row.run.containers.some(container => container.removed !== true);
  const escapedCount = row.run.settlement?.result?.escapedDescendants.length ?? 0;
  const escapedHeld = escapedCount > 0 && !row.run.escapedDescendantsProvenDeadAt;

  return <View accessibilityLabel={`QA run row ${row.run.id}`} style={{ gap: space.xxs, paddingVertical: space.xs, borderTopWidth: 1, borderTopColor: c.border }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${row.project?.name ?? "Unknown project"}, ${badge}, ${row.kind}, ${accessibleResult}, Open QA run details`} onPress={onSelect} style={{ gap: space.xxs }}>
      {outcome === "Failed" ? <Text accessibilityLabel={`Failure summary for ${row.run.id}`} numberOfLines={2} style={{ color: c.statusDanger, fontWeight: "600", fontSize: typeScale.body.fontSize }}>
        {failureSummary(row)} · {row.project?.name ?? "Unknown project"}
      </Text> : <Text numberOfLines={1} style={{ color: c.foreground, fontWeight: "600", fontSize: typeScale.body.fontSize }}>{row.project?.name ?? "Unknown project"}</Text>}
      <View style={{ ...rowStyle, gap: space.xs }}>
        <Text style={{ color: c.foregroundMuted, fontSize: typeScale.metadata.fontSize }}>{activityText(row, now)}</Text>
        <OutcomeBadge label={badge} c={c} />
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: typeScale.metadata.fontSize }}>{row.kind}</Text>
      {held && containerHeld && <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}>Capacity held by a container not reported removed.</Text>}
      {held && escapedHeld && <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}>Capacity held by {escapedCount} escaped {escapedCount === 1 ? "descendant" : "descendants"} not proven dead.</Text>}
    </Pressable>
    {row.taskId && <TextLink c={c} label={`Open task ${taskLabel}`} text={`${taskLabel}${row.task?.title ? ` · ${row.task.title}` : ""}`} onPress={() => onOpenTask(row.taskId!)} />}
    {held && <View style={{ ...rowStyle, flexWrap: "wrap" }}>
      <TextInput accessibilityLabel={`Capacity release reason for run ${row.run.id}`} maxLength={4000} value={reason} onChangeText={setReason}
        placeholder="Operator release reason" placeholderTextColor={c.foregroundMuted}
        style={{ flex: 1, minWidth: 220, ...controlFrame(c), ...controlText(c) }} />
      <Button small c={c} text="Release capacity" label={`Release held capacity for run ${row.run.id}`} disabled={!reason.trim()} onPress={() => onRelease(row.run.id, reason.trim())} />
    </View>}
  </View>;
}

const rowStyle = { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: space.xs };

function RunDetail({ row, busy, onClose, onCancel, onRetryTeardown, c }: {
  row: QaRunRow; busy: boolean; onClose: () => void; onCancel: (id: string, reason: string) => void;
  onRetryTeardown: (id: string, reason: string) => void; c: Colors;
}) {
  const [retryReason, setRetryReason] = useState("");
  // PID, epoch and the output tail are evidence for diagnosis; they open on demand.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const { run, qa } = row;
  const settlement = run.settlement ?? qa?.hostSettlement ?? null;
  const canCancel = Boolean(qa && (qa.state === "queued" || qa.state === "running"));
  const steps = qa?.steps ?? [];
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={{ flex: 1, justifyContent: "center", padding: space.md, backgroundColor: overlay.scrim }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss QA run detail backdrop" onPress={onClose} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />
      <View accessibilityViewIsModal accessibilityLabel={`QA run detail ${run.id}`} style={{ width: "100%", maxWidth: 720, maxHeight: "90%", alignSelf: "center", borderRadius: radius.panel, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, overflow: "hidden" }}>
        <View style={{ ...rowStyle, justifyContent: "space-between", padding: space.md, borderBottomWidth: 1, borderBottomColor: c.border }}>
          <View style={{ flex: 1, gap: space.xxs }}>
            <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: typeScale.page.fontSize, fontWeight: "600" }}>{row.project?.name ?? "Unknown project"} · {row.kind}</Text>
            <Text style={muted(c)}>{rowState(row)} · Commit {row.commit?.slice(0, 12) ?? "not recorded"}</Text>
          </View>
          <ActionButton c={c} action="close" label="Close QA run detail" onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={{ gap: space.sm, padding: space.md }}>
          <View accessibilityLabel="QA run steps" style={{ gap: space.xxs }}>
            <Text accessibilityRole="header" style={{ color: c.foreground, fontWeight: "600" }}>Steps</Text>
            {steps.map(step => <View key={step.name} style={{ gap: space.xxs / 2, paddingTop: space.xxs, borderTopWidth: 1, borderTopColor: c.border }}>
              <Text style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize, fontWeight: "600" }}>{step.name} · {step.timedOut ? "timed out" : step.signal ?? (step.exitCode === 0 ? "passed" : `exit ${step.exitCode ?? "—"}`)}{step.wallMs === undefined ? "" : ` · ${formatTelemetryDuration(step.wallMs)}`}</Text>
              {step.stderrTail && <Text selectable style={{ color: c.foregroundMuted, fontSize: typeScale.metadata.fontSize }}>stderr · {step.stderrTail}</Text>}
              {step.stdoutTail && <Text selectable style={{ color: c.foregroundMuted, fontSize: typeScale.metadata.fontSize }}>stdout · {step.stdoutTail}</Text>}
            </View>)}
            {!steps.length && <Text style={muted(c)}>Step output is not available for this run.</Text>}
            {qa && <ProjectQaLogWriteErrors run={qa} c={c} label={`QA log-write errors for run ${run.id}`} />}
            {qa && <ProjectQaFailures run={qa} c={c} label={`QA failures for run ${run.id}`} />}
          </View>
          <View accessibilityLabel="QA run settlement" style={{ gap: space.xxs }}>
            <Text accessibilityRole="header" style={{ color: c.foreground, fontWeight: "600" }}>Settlement</Text>
            <Text style={muted(c)}>Outcome · {settlement?.outcome ?? runOutcome(row) ?? run.state}</Text>
            <Text style={muted(c)}>Exit · {settlement?.result?.exitCode ?? "—"}{settlement?.result?.signal ? ` · ${settlement.result.signal}` : ""}</Text>
            <Text style={muted(c)}>Settled · {settlement?.settledAt ?? run.settledAt ?? "not yet"} · launched {settlement?.launched ? "yes" : "no"}</Text>
            <Text style={muted(c)}>Escaped descendants · {settlement?.result?.escapedDescendants.length
              ? settlement.result.escapedDescendants.map(process => `${process.pid} (${process.startIdentity})`).join(", ") : "none"}</Text>
            <Text style={muted(c)}>Containers · {settlement?.containers.length ? settlement.containers.map(container => `${container.runtime}:${container.id} (${container.removed === true ? "removed" : container.removed === false ? "still present" : "unknown"})`).join(", ") : "none recorded"}</Text>
            <Text style={muted(c)}>Capacity · {run.capacityReleasedAt ? `released ${run.capacityReleasedAt}${run.capacityReleaseReason ? ` · ${run.capacityReleaseReason}` : ""}` : hostRunHoldsCapacity(run) ? "retained · operator release required" : "released or not held"}</Text>
          </View>
          <Disclosure c={c} label="Diagnostics: identity, host process and output" expanded={diagnosticsOpen} onToggle={() => setDiagnosticsOpen(!diagnosticsOpen)} />
          {diagnosticsOpen && <View accessibilityLabel="QA run diagnostics" style={{ gap: space.sm }}>
          {qa?.outputTail && <Text selectable accessibilityLabel="QA output tail" style={{ color: c.foregroundMuted, fontSize: typeScale.metadata.fontSize }}>{qa.outputTail}</Text>}
          <View accessibilityLabel="QA run identity" style={{ gap: space.xxs }}>
            <Text accessibilityRole="header" style={{ color: c.foreground, fontWeight: "600" }}>Caller and host identity</Text>
            <Text selectable style={muted(c)}>Caller · {run.caller}</Text>
            <Text selectable style={muted(c)}>Run · {run.id} · epoch {run.epoch}</Text>
            <Text selectable style={muted(c)}>Host process · PID {run.pid ?? "—"} · group {run.processGroupId ?? "—"} · identity {run.startIdentity ?? "—"}</Text>
            <Text style={muted(c)}>Selector · {run.selector} · {run.runClass} ({run.classSource})</Text>
            <Text selectable style={muted(c)}>Commit · {row.commit?.slice(0, 12) ?? "not recorded"}</Text>
            {row.taskId && <Text style={muted(c)}>Task · {row.task?.reference ?? (row.task?.number ? taskNumberLabel(row.task, false) : row.taskId)}{row.task?.title ? ` · ${row.task.title}` : ""}</Text>}
          </View>
          </View>}
          <View style={rowStyle}>
            {canCancel && <Button small c={c} text="Cancel QA" label={`Cancel QA run ${run.id}`} disabled={busy} onPress={() => onCancel(run.id, `Cancelled from QA runs for ${row.project?.name ?? "project"}`)} />}
          </View>
          {qa && canRetryTeardown(qa) && <View style={{ gap: space.xxs }}>
            <Text style={muted(c)}>Teardown failed. Its QA result is kept; a retry runs only teardown.</Text>
            <View style={rowStyle}>
              <TextInput accessibilityLabel={`Teardown retry reason for run ${run.id}`} maxLength={4000} value={retryReason} onChangeText={setRetryReason}
                placeholder="Operator reason for the teardown retry" placeholderTextColor={c.foregroundMuted}
                style={{ flex: 1, minWidth: 220, ...controlFrame(c), ...controlText(c) }} />
              <Button small c={c} text="Retry teardown" label={`Retry teardown for run ${run.id}`} disabled={busy || !retryReason.trim()} onPress={() => onRetryTeardown(run.id, retryReason.trim())} />
            </View>
          </View>}
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

export function QaRunsTab({ runs, qaRuns, accounting, projects, tasks, selectedProjects, busy, loading = false, loadError, fence = null, fenceInventory, focusRunId = null, onRunQa, onCancelQa, onRetryTeardownQa, onReleaseCapacity, onOpenTask, c }: {
  /** A board QA card opens the page on its run; the detail is opened once on mount. */
  focusRunId?: string | null;
  runs?: HostRunRecord[]; qaRuns?: ProjectQaRun[]; accounting?: RunAccounting; projects: Project[]; tasks: TaskSummary[]; selectedProjects: string[]; busy: boolean;
  /** Papercut 26636095: the QA admission fence in force, and its complete unsettled inventory once read. */
  fence?: QaFence | null; fenceInventory?: QaInventoryItem[];
  loading?: boolean; loadError?: string; onRunQa: (repository: string) => void; onCancelQa: (id: string, reason: string) => void;
  onRetryTeardownQa: (id: string, reason: string) => void; onReleaseCapacity: (runId: string, reason: string) => void;
  onOpenTask: (taskId: string) => void; c: Colors;
}) {
  const [failedOnly, setFailedOnly] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(focusRunId);
  // A Planning link or a board card asks for one run while this tab is open.
  useEffect(() => { if (focusRunId) setSelectedRunId(focusRunId); }, [focusRunId]);
  const allRows = useMemo(() => rowsForRuns(runs, qaRuns, projects, tasks, accounting), [runs, qaRuns, projects, tasks, accounting]);
  const inScope = scopeContains(projects, selectedProjects);
  const scopedRows = allRows.filter(row => inScope(row.run.repository.path, row.run.repository.origin));
  const rows = failedOnly ? scopedRows.filter(row => runOutcome(row) === "Failed") : scopedRows;
  const nowRows = rows.filter(row => liveHostRun(row.run, accounting))
    .sort((a, b) => Date.parse(a.run.submittedAt) - Date.parse(b.run.submittedAt));
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  // History: settled runs no longer holding capacity, and runs whose accounting is retired.
  const historyAt = (row: QaRunRow) => Date.parse(row.run.settledAt ?? row.retirement?.disposedAt ?? row.qa?.finishedAt ?? row.run.submittedAt);
  const settledRows = rows.filter(row => !liveHostRun(row.run, accounting))
    .sort((a, b) => historyAt(b) - historyAt(a));
  const recentRows = showMore ? settledRows : settledRows.filter(row => historyAt(row) >= cutoff);
  const olderCount = settledRows.length - settledRows.filter(row => historyAt(row) >= cutoff).length;
  const selectedRow = allRows.find(row => row.run.id === selectedRunId);
  const launchProjects = projects.filter(project => selectedProjects.length ? selectedProjects.includes(project.key) : project.visibility !== "parked").sort((a, b) => a.name.localeCompare(b.name));

  return <View accessibilityLabel="QA runs" style={{ flex: 1, minHeight: 0 }}>
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: space.md, paddingBottom: space.lg, gap: space.md }}>
      <View style={{ ...rowStyle, justifyContent: "space-between" }}>
        <Button c={c} text={fence ? "QA fenced" : "Run QA"} label="Run QA" disabled={busy || !launchProjects.length || Boolean(fence)} onPress={() => setPickerOpen(true)} />
        <Pressable accessibilityRole="switch" accessibilityLabel="Failed only" accessibilityState={{ checked: failedOnly }} onPress={() => setFailedOnly(!failedOnly)} style={{ minHeight: touchTarget, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.xs }}>
          <View style={{ width: 30, height: 18, borderRadius: radius.control, padding: space.xxs / 2, backgroundColor: failedOnly ? c.accent : c.surface2, alignItems: failedOnly ? "flex-end" : "flex-start" }}>
            <View style={{ width: 14, height: 14, borderRadius: radius.control, backgroundColor: failedOnly ? c.accentForeground : c.foregroundMuted }} />
          </View><Text style={{ color: c.foreground, fontSize: typeScale.body.fontSize }}>Failed only</Text>
        </Pressable>
      </View>
      {fence && <QaFenceNotice fence={fence} inventory={fenceInventory} c={c} />}
      {loadError && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: typeScale.metadata.fontSize }}>Could not load QA runs: {loadError}. The list may be out of date.</Text>}
      {loading && <Text style={muted(c)}>Loading QA runs…</Text>}
      <View accessibilityLabel="Now" style={{ gap: space.xxs / 2 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: typeScale.section.fontSize, fontWeight: "600" }}>Now</Text>
        {accounting?.notice && <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}>{accounting.notice}</Text>}
        {nowRows.map(row => <RunRow key={row.run.id} row={row} now onSelect={() => setSelectedRunId(row.run.id)} onOpenTask={onOpenTask} onRelease={onReleaseCapacity} c={c} />)}
        {!nowRows.length && <Text style={muted(c)}>{failedOnly ? "No failed runs are active or holding capacity." : "Nothing is running or waiting."}</Text>}
      </View>
      <View accessibilityLabel="Results" style={{ gap: space.xxs / 2 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: typeScale.section.fontSize, fontWeight: "600" }}>Results · past 24 hours</Text>
        {recentRows.map(row => <RunRow key={row.run.id} row={row} now={false} onSelect={() => setSelectedRunId(row.run.id)} onOpenTask={onOpenTask} onRelease={onReleaseCapacity} c={c} />)}
        {!recentRows.length && <Text style={muted(c)}>{failedOnly ? "No failed results in this time range." : "No settled runs in the past 24 hours."}</Text>}
        {olderCount > 0 && <Button small c={c} text={showMore ? "Show fewer" : `Show ${olderCount} older runs`} label={showMore ? "Show fewer QA results" : "Show older QA results"} onPress={() => setShowMore(!showMore)} />}
      </View>
    </ScrollView>
    {pickerOpen && <Modal visible transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
      <View style={{ flex: 1, justifyContent: "center", padding: space.md, backgroundColor: overlay.scrim }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close Run QA project picker" onPress={() => setPickerOpen(false)} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />
        <View accessibilityViewIsModal accessibilityLabel="Choose a project for Run QA" style={{ width: "100%", maxWidth: 520, maxHeight: "85%", alignSelf: "center", gap: space.sm, padding: space.md, borderRadius: radius.panel, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
          <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: typeScale.section.fontSize, fontWeight: "600" }}>Choose a project for Run QA</Text>
          {!launchProjects.length && <Text style={muted(c)}>No projects are available in this scope.</Text>}
          <ScrollView contentContainerStyle={{ gap: space.xs }}>{launchProjects.map(project => <Button key={project.key} small c={c} text={project.name} label={`Run QA for ${project.name}`} disabled={busy} onPress={() => { setPickerOpen(false); onRunQa(project.primary.origin ?? project.primary.path); }} />)}</ScrollView>
          <View style={row}><Button small c={c} text="Cancel" label="Cancel Run QA" onPress={() => setPickerOpen(false)} /></View>
        </View>
      </View>
    </Modal>}
    {selectedRow && <RunDetail row={selectedRow} busy={busy} onClose={() => setSelectedRunId(null)}
      onCancel={onCancelQa} onRetryTeardown={onRetryTeardownQa} c={c} />}
  </View>;
}
