import { NativeQuestionAnswer, useTaskQuestionRequests } from "../native-questions";
import { formatAgentId } from "../../shared/agent-identity";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button, DetailSection, Disclosure, muted, row, type Colors } from "../controls";
import * as api from "../../shared/contracts";
import type { Run, Task, TaskDetail, TaskNext } from "../../shared/contracts";
import { decisionAge } from "../../shared/pipeline-board";
import { budgetBars, budgetNeedsAttention, checkTicks, latestTaskReport, taskHoldRows, taskOverviewWait, taskReviewProgress, type CheckTick, type LatestReport } from "../../shared/task-detail-summary";
import type { TaskBudgetView } from "../../shared/task-budget";

/**
 * Task 538 (papercut 90104e7f): one collapsed group in the task detail. The
 * summary holds what a reader needs in ten seconds; the rest of the dialog is
 * one press away and nothing is deleted.
 */
export function CollapsibleSection({ title, hint, open, onToggle, c, children }: { title: string; hint?: string; open: boolean; onToggle: () => void; c: Colors; children: React.ReactNode }) {
  return <View style={{ borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12 }}>
      <Disclosure c={c} label={title} accessibilityLabel={`${title}, ${open ? "expanded" : "collapsed"}`} expanded={open} onToggle={onToggle} />
      {hint && <Text numberOfLines={1} style={{ ...muted(c), fontSize: 11, flexShrink: 1 }}>{hint}</Text>}
    </View>
    {open && <View style={{ gap: 12, paddingHorizontal: 12, paddingBottom: 12 }}>{children}</View>}
  </View>;
}
/** Spec 058's budget as two bars: tokens and wall time against their limits. */
function BudgetBars({ budget, c }: { budget: TaskBudgetView; c: Colors }) {
  return <View style={{ gap: 6 }}>{budgetBars(budget).map(bar => <View key={bar.key} style={{ gap: 3 }}>
    <View style={{ ...row, flexWrap: "nowrap", justifyContent: "space-between", gap: 10 }}>
      <Text style={{ ...muted(c), fontSize: 11 }}>{bar.label}</Text>
      <Text accessibilityLabel={`${bar.label} budget ${bar.text}`} style={{ color: bar.ratio >= 1 ? c.statusWarning : c.foregroundMuted, fontSize: 11 }}>{bar.text}</Text>
    </View>
    <View style={{ height: 5, borderRadius: 3, backgroundColor: c.surface2, overflow: "hidden" }}>
      <View style={{ width: `${Math.round(bar.ratio * 100)}%`, height: 5, borderRadius: 3, backgroundColor: bar.ratio >= 1 ? c.statusWarning : c.accent }} />
    </View>
  </View>)}</View>;
}
/** The latest check results as short ticks: a pass, a failure, or still pending. */
const tickMark: Record<CheckTick["state"], string> = { pass: "✓", fail: "✗", pending: "·", info: "·" };
function CheckTickRow({ ticks, c }: { ticks: CheckTick[]; c: Colors }) {
  if (!ticks.length) return null;
  return <View style={{ ...row, gap: 14, flexWrap: "wrap" }}>{ticks.map(tick =>
    <Text key={tick.label} accessibilityLabel={`${tick.label}: ${tick.state}`} style={{ color: tick.state === "fail" ? c.statusWarning : tick.state === "pass" ? c.foreground : c.foregroundMuted, fontSize: 12 }}>
      {tickMark[tick.state]} {tick.label}
    </Text>)}</View>;
}
/** The newest report's headline; the full text is the one press behind "Read full". */
function LatestReportRow({ report, c }: { report: LatestReport; c: Colors }) {
  const [open, setOpen] = useState(false);
  const more = report.fullText.trim() !== report.headline.trim();
  return <View style={{ gap: 4 }}>
    <Text accessibilityLabel={`Latest report: ${report.headline}`} style={{ color: c.foreground, fontWeight: "600", fontSize: 13, lineHeight: 18 }}>{report.headline}</Text>
    <View style={{ ...row, gap: 10, flexWrap: "wrap" }}>
      <Text style={{ ...muted(c), fontSize: 11 }}>{report.role}{report.author ? ` · ${report.author}` : ""}{report.at ? ` · ${decisionAge(report.at)}` : ""}</Text>
      {more && <Pressable accessibilityRole="button" accessibilityLabel={open ? "Hide full report" : "Read full report"} onPress={() => setOpen(!open)} style={{ minHeight: 24, justifyContent: "center" }}>
        <Text style={{ color: c.accent, fontSize: 11, fontWeight: "600" }}>{open ? "Hide full" : "Read full"}</Text>
      </Pressable>}
    </View>
    {open && <Text selectable style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{report.fullText}</Text>}
  </View>;
}
/**
 * The Overview's first read: the current wait or stop, who owns it and the next
 * action it names. Then the holds in force, review progress, the latest checks
 * and the newest report's headline. Every fact here is derived from the task's
 * recorded wait, `task.next` and its own records; a superseded reason cannot
 * linger, because the wait comes from the current state. The budget shows only
 * when it is spent or near its limit.
 */
export function TaskSummaryBlock({ task, next, runs, qaRun, c }: { task: TaskDetail; next: TaskNext | null; runs: readonly Run[]; qaRun?: { state: string } | null; c: Colors }) {
  const wait = taskOverviewWait(task.waitState, next, task.reason);
  const holds = taskHoldRows(next);
  const progress = taskReviewProgress(next?.outcome);
  const report = latestTaskReport(task, runs);
  const ticks = checkTicks({
    validation: task.resolution.projectValidation ?? null,
    milestoneQa: qaRun ?? null,
    // A verdict at an older head, or one the task superseded, is history: it is not a current tick.
    verdict: next?.outcome.accepted && next.outcome.accepted.currentHead && !next.outcome.accepted.superseded ? next.outcome.accepted.status : null,
  });
  return <DetailSection c={c}>
    <View style={{ gap: 4 }}>
      <Text accessibilityLabel={`Wait: ${wait.state}; owner ${wait.owner || "none"}; next ${wait.nextAction || "none"}`} style={{ color: c.foreground, fontSize: 14, fontWeight: "600", lineHeight: 20 }}>{wait.state}</Text>
      {Boolean(wait.actor) && <Text accessibilityLabel={`Working: ${wait.actor}`} style={{ ...muted(c), fontSize: 12, lineHeight: 17 }}>{wait.actor}</Text>}
      {Boolean(wait.owner) && <Text accessibilityLabel={`Owner: ${wait.owner}`} style={{ ...muted(c), fontSize: 12, lineHeight: 17 }}>Owner · {wait.owner}</Text>}
      {Boolean(wait.nextAction) && <Text accessibilityLabel={`Next action: ${wait.nextAction}`} style={{ color: c.foreground, fontSize: 12, lineHeight: 17 }}>Next · {wait.nextAction}</Text>}
      {Boolean(wait.detail) && (wait.stop
        ? <Text accessibilityLabel={`Stop: ${wait.stop.kind}; ${wait.stop.reason}; ${wait.stop.detail}`} selectable style={{ ...muted(c), fontSize: 12, lineHeight: 17 }}>
          {wait.detail} · {decisionAge(wait.stop.since)}
        </Text>
        : <Text selectable style={{ ...muted(c), fontSize: 12, lineHeight: 17 }}>{wait.detail}</Text>)}
    </View>
    {holds.map(hold =>
      <Text key={hold.kind} accessibilityLabel={`${hold.kind} hold: ${hold.holder}, ${hold.reason}`} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
        {hold.kind === "dispatch" ? "Dispatch" : "Merge"} held by {hold.holder} · {hold.reason} · {hold.since ? decisionAge(hold.since) : "age not recorded"}
      </Text>)}
    {task.budget && budgetNeedsAttention(task.budget) && <BudgetBars budget={task.budget} c={c} />}
    {(progress.round || progress.verdict) && <View style={{ gap: 2 }}>
      {progress.round && <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>{progress.round}</Text>}
      {progress.verdict && <Text accessibilityLabel={`Latest verdict: ${progress.verdict}`} style={{ ...muted(c), fontSize: 12 }}>{progress.verdict}</Text>}
    </View>}
    <CheckTickRow ticks={ticks} c={c} />
    {report && <View style={{ gap: 5, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 9 }}>
      <Text style={{ ...muted(c), fontSize: 10, textTransform: "uppercase" }}>Latest</Text>
      <LatestReportRow report={report} c={c} />
    </View>}
  </DetailSection>;
}
/**
 * Task 538: the native operator question a task is waiting on, with its answer
 * controls, beside the summary. It is the same request the question pill mirrors,
 * so an answer here or on the thread resolves it once and Queue observes the same
 * resolution; the operator no longer has to find a thread's pill to unblock a task
 * that is waiting on their answer.
 */
export function PendingQuestions({ agentId, hostId, runs, onAnswered, c }: { agentId: string | null; hostId: string; runs: readonly Run[]; onAnswered: () => void; c: Colors }) {
  // A live reviewer asks on its own thread; a retained worker asks on the task row.
  const ids = [...new Set([agentId, ...runs.filter(run => !run.released && run.role === "reviewer").map(run => run.agentId)].filter((id): id is string => Boolean(id)))];
  const requests = useTaskQuestionRequests(ids, hostId ? ids.map(id => formatAgentId(hostId, id)) : []);
  if (!requests.length) return null;
  const asker = (id: string) => {
    const native = ids.find(candidate => hostId && formatAgentId(hostId, candidate) === id) ?? id;
    const run = runs.find(item => item.agentId === native && !item.released);
    if (run) return `${run.role}${run.profile?.name ? ` · ${run.profile.name}` : ""}`;
    return native === agentId ? "worker" : "thread";
  };
  return <DetailSection title="Waiting for your answer" c={c}>
    <Text style={{ ...muted(c), fontSize: 12 }}>Answer here or in the question pill on the thread; both resolve the same native question.</Text>
    {requests.map(({ agentId: askerId, request }) => <View key={`${askerId}:${request.id}`} style={{ gap: 6 }}>
      <Text style={{ ...muted(c), fontSize: 11 }}>{asker(askerId)} asked</Text>
      <NativeQuestionAnswer agentId={askerId} request={request} onAnswered={onAnswered} c={c} />
    </View>)}
  </DetailSection>;
}
/** One row of task identity. Raw rows (IDs, commits, host) sit behind a disclosure; the rest are facts an operator reads. */
type IdentityField = { label: string; value: string; raw: boolean };
export function taskIdentityFields(task: Task): IdentityField[] {
  const fields: IdentityField[] = [
    { label: "Repository", value: task.repoPath, raw: false },
    { label: "Lanes", value: task.laneContext.length ? task.laneContext.map((context) => `${context.title} (${context.key})`).join(", ") : "None", raw: false },
    { label: "Project queue", value: task.queuePriority ? "Promoted" : "Normal order", raw: false },
    { label: "Branch", value: task.branch, raw: false },
    { label: "Profile", value: task.profile ? `${task.profile.name} · ${task.profile.thinkingOptionId ?? "provider default"}` : "Not assigned", raw: false },
    { label: "Worker request", value: task.profileRequests?.worker ? `${task.profileRequests.worker.profileId} · ${task.profileRequests.worker.reason}` : "Automatic", raw: false },
    { label: "Reviewer request", value: task.profileRequests?.reviewer ? `${task.profileRequests.reviewer.profileId} · ${task.profileRequests.reviewer.reason}` : "Automatic", raw: false },
    { label: "Pull request", value: task.prUrl ?? "Not created", raw: false },
    { label: "PR review", value: task.skipPRReview ? "Skipped at submission · merge on completion" : "Required", raw: false },
  ];
  if (task.proofReceiptAcceptance) {
    const acceptance = task.proofReceiptAcceptance;
    fields.push({ label: "Receipt accepted", value: `${acceptance.acceptedBy} · ${acceptance.reason} · receipt ${acceptance.runId}\nOriginal failed qualification and reviewer verdict: ${acceptance.originalResult.evidence}`, raw: false });
  }
  if (task.resolution.ownerAcceptances?.length) fields.push({ label: "Owner acceptance", value: ownerAcceptanceLabel(task.resolution.ownerAcceptances.at(-1)!), raw: false });
  if (task.resolution.ownerSettlements.length) fields.push({ label: "Owner settled", value: task.resolution.ownerSettlements.map(item => `${item.effect} · ${item.caller} (${item.source.replaceAll('_', ' ')}) · ${item.reason}`).join("\n"), raw: false });
  const raw: IdentityField[] = [
    { label: "Created by", value: task.originAgentId, raw: true },
    { label: "Host", value: task.hostId, raw: true },
    { label: "Planning commit", value: task.planningCommit, raw: true },
    task.briefVersions.length
      ? { label: "Brief", value: `Nucleus-held · version ${task.briefVersions.at(-1)!.version} · ${task.briefVersions.at(-1)!.digest.slice(0, 19)}`, raw: true }
      : { label: "Handoff", value: task.handoffPath, raw: true },
    { label: "Worker", value: task.agentId ?? "Not assigned", raw: true },
  ];
  return [...fields, ...raw];
}

export const lowValueActivityKinds = new Set([
  "telemetry_stage",
  "pre_merge_candidate_intent",
  "pre_merge_candidate_created",
  "pre_merge_warm_candidate_fallback",
  "pre_merge_warm_candidate_created",
  "pre_merge_warm_candidate_missing",
]);

/** Events keep their original kind and payload; this label is only the human-facing summary. */
function eventLabel(kind: string) {
  return kind.replaceAll("_", " ").replace(/(^|\s)\w/g, value => value.toUpperCase());
}

/** The event contract has no actor column. Only claim an actor when the recorded text names one. */
function eventActor(detail: string) {
  const match = detail.match(/\b(?:answered|assigned|submitted|recorded) by ([^;,:.]+)/i)
    ?? detail.match(/^Origin: ([^;]+)/i)
    ?? detail.match(/^Worker ([^ ]+) registered/i);
  return match?.[1]?.trim() || "Not recorded";
}

/** A chronological event summary with its complete, original audit row available on demand. */
export function EventRow({ event, c }: { event: { id?: number; taskId?: string; at: string; kind: string; detail: string }; c: Colors }) {
  const kind = eventLabel(event.kind);
  const actor = eventActor(event.detail);
  const when = new Date(event.at).toLocaleString();
  const long = event.detail.length > 180;
  return <View accessibilityLabel={`${kind}, actor ${actor}, ${when}`} style={{ gap: 3, borderBottomColor: c.border, borderBottomWidth: 1, paddingBottom: 8 }}>
    <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{kind}</Text>
    <Text style={{ ...muted(c), fontSize: 11 }}>{actor} · {when}</Text>
    <Text selectable style={{ color: c.foreground, fontSize: 12 }}>{long ? `${event.detail.slice(0, 180)}…` : event.detail || kind}</Text>
    <RawRecords label={`Original event${event.id === undefined ? "" : ` ${event.id}`}`} c={c}>
      <Text selectable accessibilityLabel="Original event kind" style={{ color: c.foreground, fontSize: 12 }}>{event.kind}</Text>
      <Text selectable accessibilityLabel="Original event actor" style={{ color: c.foreground, fontSize: 12 }}>Actor · {actor}</Text>
      <Text selectable accessibilityLabel="Original event time" style={{ color: c.foreground, fontSize: 12 }}>{event.at}</Text>
      {event.id !== undefined && <Text selectable accessibilityLabel="Original event ID" style={{ color: c.foreground, fontSize: 12 }}>Event ID · {event.id}</Text>}
      {event.taskId && <Text selectable accessibilityLabel="Original event task ID" style={{ color: c.foreground, fontSize: 12 }}>Task ID · {event.taskId}</Text>}
      <Text selectable accessibilityLabel="Complete original event detail" style={{ color: c.foreground, fontSize: 12 }}>{event.detail || "No detail recorded"}</Text>
    </RawRecords>
  </View>;
}

export type TaskDetailTab = "overview" | "technical" | "runs" | "messages" | "activity";
const taskDetailTabLabels: ReadonlyArray<readonly [TaskDetailTab, string]> = [
  ["overview", "Overview"], ["technical", "Technical"], ["runs", "Runs & agents"], ["messages", "Messages"], ["activity", "Activity"],
];

export function TaskDetailTabs({ tab, onSelect, needsAttention, compact, c }: { tab: TaskDetailTab; onSelect: (tab: TaskDetailTab) => void; needsAttention: boolean; compact: boolean; c: Colors }) {
  return <View accessibilityRole="tablist" accessibilityLabel="Task detail sections"
    style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, borderBottomWidth: 1, borderBottomColor: c.border, paddingHorizontal: compact ? 12 : 16, paddingVertical: 8 }}>
    {taskDetailTabLabels.map(([value, label]) => <Pressable key={value} accessibilityRole="tab"
      accessibilityLabel={label} accessibilityState={{ selected: tab === value }} onPress={() => onSelect(value)}
      style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 7, borderWidth: 1, borderColor: tab === value ? c.accent : c.border, backgroundColor: tab === value ? c.surface2 : c.surface1 }}>
      <Text style={{ color: tab === value ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: tab === value ? "600" : "400" }}>{label}</Text>
      {value === "overview" && needsAttention && <Text style={{ color: c.statusWarning, fontSize: 10, fontWeight: "600" }}>Needs attention</Text>}
    </Pressable>)}
  </View>;
}

export function TechnicalActivityEvents({ events, c }: { events: Array<{ id: number; at: string; kind: string; detail: string }>; c: Colors }) {
  const [open, setOpen] = useState(false);
  if (!events.length) return null;
  return <CollapsibleSection title={`Show technical events (${events.length})`} hint="Stage and setup details" open={open} onToggle={() => setOpen(value => !value)} c={c}>
    {events.map(event => <EventRow key={event.id} event={event} c={c} />)}
  </CollapsibleSection>;
}

/** One run: its role, state and result, with its thread when the host can open it. */
export function RunRow({ run, c, openThread }: { run: Run; c: Colors; openThread?: () => void }) {
  return <View style={{ ...row, justifyContent: "space-between" }}>
    <Text selectable style={{ ...muted(c), fontSize: 12, flexShrink: 1 }}>
      {run.role} · {run.status} · {run.profile?.name ?? "Assigned thread"} · {run.completion?.status ?? (run.idleSince && !run.released ? "Missing result" : "Awaiting result")}
    </Text>
    {openThread && <Button small c={c} text="Open thread" label={`Open ${run.role} thread`} onPress={openThread} />}
  </View>;
}
/** One task message: who it went to or came from, its plain delivery state and its text. */
export function MessageRow({ message, taskId, c }: { message: api.AgentMessageRecord; taskId: string; c: Colors }) {
  const sent = message.fromTaskId === taskId;
  const counterpart = sent ? message.toReference ?? message.toTaskId : message.fromReference ?? message.fromTaskId;
  // Queued is pending and expired is a failed delivery. A message is never unknown, so no retry advice applies here.
  const statusColor = message.status === "delivered" ? c.statusSuccess : message.status === "expired" ? c.statusDanger : c.statusWarning;
  const deliveryLabel = message.status === "delivered" ? "Delivered" : message.status === "expired" ? "Not delivered · expired before delivery" : message.status === "uncertain" ? "Delivery unknown · awaiting review" : "Queued · waiting for the recipient\u2019s next turn";
  return (
    <View style={{ gap: 3, borderBottomColor: c.border, borderBottomWidth: 1, paddingBottom: 8 }}>
      <Text style={{ ...muted(c), fontSize: 11 }}>
        {new Date(message.createdAt).toLocaleString()} · {sent ? "sent to" : "received from"} {counterpart} ({sent ? message.toRole : message.fromRole}){message.fromProject ? ` · ${message.fromProject}` : ""}
      </Text>
      <Text accessibilityLabel={`Delivery ${deliveryLabel}`} style={{ ...muted(c), fontSize: 11, color: statusColor }}>
        {deliveryLabel}{message.error ? ` · last note: ${message.error}` : ""}
      </Text>
      <Text selectable style={{ color: c.foreground, fontSize: 12 }}>{message.text}</Text>
    </View>
  );
}

/** Raw records behind one labelled disclosure: collapsed until asked for, never deleted. */
export function RawRecords({ label, c, children }: { label: string; c: Colors; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <View style={{ gap: 8 }}>
    <Disclosure c={c} label={label} expanded={open} onToggle={() => setOpen(value => !value)} />
    {open && children}
  </View>;
}

export function DetailField({ label, value, c, compact }: { label: string; value: string; c: Colors; compact: boolean }) {
  return <View style={{ gap: 2, minWidth: 0, flexGrow: 1, flexBasis: compact ? "100%" : 250 }}><Text style={{ ...muted(c), fontSize: 11 }}>{label}</Text>
    <Text selectable style={{ color: c.foreground, fontSize: 12 }}>{value}</Text></View>;
}
/** A record dialog's last action result. */
export type RecordNoticeValue = { kind: "ok" | "error"; text: string };
/** The board's action runner: refreshes the board and the open records; a failure lands on the board or, with "record", the open record's notice. */
export type BoardAct = (fn: () => Promise<unknown>, into?: "board" | "record") => Promise<void>;
export function RecordNotice({ notice, c }: { notice: RecordNoticeValue | null; c: Colors }) {
  if (!notice) return null;
  return <Text accessibilityRole={notice.kind === "error" ? "alert" : undefined} accessibilityLabel={notice.kind === "error" ? "Record action error" : "Record action result"}
    style={{ color: notice.kind === "error" ? c.statusDanger : c.foreground, fontSize: 12 }}>{notice.text}</Text>;
}
/** One-line truth for the task identity row: the recorded owner acceptance beside the reviewer verdict it kept. */
function ownerAcceptanceLabel(record: NonNullable<Task["resolution"]["ownerAcceptances"]>[number]): string {
  const who = record.actor.role === "operator" ? "operator" : record.actor.role === "authorized_relay" ? `relayed by ${record.actor.agentId}` : record.actor.role === "delegated" ? `delegated to ${record.actor.agentId}` : record.actor.agentId;
  // A source acceptance is accepted risk, not verified review: the board names what was missing.
  const kind = record.kind === "operator_source"
    ? `Source acceptance · no review evidence (${record.missingEvidence ?? "unrecorded"}) · `
    : "";
  return `${kind}${record.actor.role === "project_owner" ? "Project owner" : record.actor.role === "operator" ? "Operator" : "Relayed acceptance"} · ${who} · head ${record.head.slice(0, 12)} · ${record.qualification.slice(0, 160)}${record.qualification.length > 160 ? "…" : ""}`;
}
