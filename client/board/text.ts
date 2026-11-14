import { blockingHold, isTaskPhase, phaseStateLabel } from "../../shared/task-state";
import { phaseNeedsAttention } from "../../shared/pipeline-board";
import { prerequisiteReasonEntries } from "../../shared/wait-state";
import React from "react";
import type { HoldKind, Task, TaskDetail, TaskSummary } from "../../shared/contracts";

export const projectName = (task: Pick<Task,"repoPath">) => task.repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? task.repoPath;
const UUID_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HASH_TEXT = /\b(?:[0-9a-f]{40}|[0-9a-f]{64})\b/gi;
/** Card content stays readable while identifiers and digests remain available in task detail. */
export function plainCardText(value: string): string {
  return value.replace(UUID_TEXT, "task").replace(HASH_TEXT, "details");
}
export function plainCardNode(node: React.ReactNode): React.ReactNode {
  if (typeof node === "string") return plainCardText(node);
  if (Array.isArray(node)) return node.map(plainCardNode);
  if (!React.isValidElement<{ children?: React.ReactNode; label?: string; a11y?: string; accessibilityLabel?: string }>(node)) return node;
  const props = node.props;
  return React.cloneElement(node, {
    ...props,
    ...(props.label === undefined ? {} : { label: plainCardText(props.label) }),
    ...(props.a11y === undefined ? {} : { a11y: plainCardText(props.a11y) }),
    ...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: plainCardText(props.accessibilityLabel) }),
    ...(props.children === undefined ? {} : { children: plainCardNode(props.children) }),
  });
}
export const phaseLabel = (t: {held:boolean;phase:Task['phase'];disposition?:{status:string;kind:string}|null}) => {
  return phaseStateLabel(t);
};
// A hold pauses the icon only while it is what the task waits on; otherwise the
// phase's own icon shows the work in progress and the hold chip names the hold.
export const phaseIcon = (t: {held:boolean;phase:Task['phase'];holdKind?:HoldKind;holds?:{dispatch?:unknown;merge?:unknown};disposition?:{status:string;kind:string}|null}) => blockingHold(t) ? "Pause" : t.disposition && t.disposition.status !== "complete" ? "LoaderCircle" : ({
  queued:"Clock",dispatching:"LoaderCircle",working:"Hammer",awaiting_review:"Eye",report_ready:"Eye",reviewing:"Search",changes_requested:"Pencil",
  blocked:"CircleSlash",error:"TriangleAlert",needs_attention:"TriangleAlert",verifying:"BadgeCheck",merging:"GitMerge",syncing:"RefreshCw",closing:"Archive",done:"Check",cancelled:"X",
} satisfies Record<Task['phase'],string>)[t.phase];
export type DisplayTask = TaskSummary | TaskDetail;
export const attention = (t: DisplayTask) => Boolean(t.originError||t.originLookupError) || t.resolution.attention || phaseNeedsAttention(t.phase);
export const holdKindLabel = (kind: HoldKind) => kind === "dispatch" ? "Dispatch held" : "Merge held";
export function presentHoldKinds(task: { holdKind?: HoldKind; holds?: { dispatch?: unknown; merge?: unknown } }): HoldKind[] {
  const kinds: HoldKind[] = [];
  if (task.holds?.dispatch) kinds.push("dispatch");
  if (task.holds?.merge) kinds.push("merge");
  if (!kinds.length && task.holdKind) kinds.push(task.holdKind);
  return kinds;
}
/** Spec 050: card badges name the stop categories no other badge carries; hold and wait stops already have their own Spec 040/043 badges. */
const STOP_BADGE_LABEL = { incident: "Incident", recovery: "Recovery", run: "Stopped run", attention: "Attention" } as const;
export const stopBadgeLabel = (stop: TaskSummary["stop"]) =>
  stop && stop in STOP_BADGE_LABEL ? STOP_BADGE_LABEL[stop as keyof typeof STOP_BADGE_LABEL] : null;
export function prerequisiteLine(task: TaskSummary): string | null {
  if (task.waitState?.state !== "waiting_prerequisite") return null;
  const entries = prerequisiteReasonEntries(task.reason);
  const first = entries[0];
  if (!first) return task.waitingOn ? `After ${task.waitingOn}` : "Waiting for prerequisite";
  const { title, status: rawStatus } = first;
  const status = isTaskPhase(rawStatus) ? phaseStateLabel({ held: false, phase: rawStatus }) : rawStatus;
  const reference = task.waitingOn ? `After ${task.waitingOn}` : "After prerequisite";
  const rest = [title, status, entries.length > 1 ? `+${entries.length - 1} more` : ""].filter(Boolean).join(" · ");
  return `${reference} · ${rest}`;
}

/** A card preview uses the first recorded sentence verbatim; the task view retains the full reason. */
export function holdReasonPreview(reason: string): string {
  const sentence = reason.trim().match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0]?.trim();
  return sentence || reason.trim();
}
/** Spec 058: a responsible task's budget, used over limit for effective tokens and wall time. */
const budgetCount = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
const budgetDuration = (ms: number) => ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`;
type BudgetDisplay = NonNullable<TaskSummary["budget"]> | NonNullable<TaskDetail["budget"]>;
export function budgetFields(budget: BudgetDisplay) {
  return Array.isArray(budget) ? {
    effectiveTokens: { used: budget[0]!, limit: budget[1]!, evidence: budget[2]! },
    wallMs: { used: budget[3]!, limit: budget[4]! }, exhausted: budget[5]!,
  } : budget;
}
export const budgetSummary = (budget: BudgetDisplay) => {
  const fields = budgetFields(budget);
  return `${fields.effectiveTokens.evidence === "none" ? "tokens not reported" : `${budgetCount(fields.effectiveTokens.used)} / ${budgetCount(fields.effectiveTokens.limit)} tokens`} · ${budgetDuration(fields.wallMs.used)} / ${budgetDuration(fields.wallMs.limit)}`;
};
/** Spec 051: an interactive task says so on its card, and says when it is waiting on you. */
export const interactiveBadgeLabel = (task: Pick<TaskSummary, "interactive" | "stopRecord" | "phase">) =>
  !task.interactive || ["done", "cancelled"].includes(task.phase) ? null : task.stopRecord?.reason === "interactive" ? "Interactive · your turn" : "Interactive";
export function elapsedRun(at: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
export function longShellCommandStart(reason: string): string | null {
  return reason.match(/\(started at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\):/)?.[1] ?? null;
}
