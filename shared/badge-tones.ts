import { phaseNeedsAttention } from './pipeline-board';

/**
 * Card badge colours (Tom, 2026-09-28). Papercuts red and leads green matter most;
 * the rest follow the same four semantic tones from the theme. Keyed on the badge's
 * lower-case text, so tags (Spec 026's papercut tag, for example) share the mapping.
 */
export type BadgeTone = "danger" | "success" | "warning" | "accent" | "neutral";

const RECORD_TONES: Record<string, BadgeTone> = {
  papercut: "danger",
  lead: "success",
  "checks failed": "danger",
  "checks passed": "success",
  unchecked: "neutral",
  approved: "accent",
  unapproved: "warning",
  submitting: "accent",
  parked: "neutral",
  // Spec 032: decisions ask amber (the operator's hand is needed); Queue-raised
  // keeps the accent the board uses for records of its own; stale stays muted.
  decision: "warning",
  "queue-raised": "accent",
  stale: "neutral",
};

/** A record badge's tone; check results with a message ("Checks failed · …") match by prefix. */
export function recordBadgeTone(label: string): BadgeTone {
  const key = label.trim().toLowerCase();
  if (RECORD_TONES[key]) return RECORD_TONES[key];
  if (key.startsWith("checks failed")) return "danger";
  if (key.startsWith("checks passed")) return "success";
  return "neutral";
}

/** A task's phase badge tone: attention red, needs-a-hand amber, in progress blue, on its way to done green. */
export function phaseBadgeTone(task: { held: boolean; phase: string; disposition?: { status: string } | null }): BadgeTone {
  if (task.disposition && task.disposition.status !== "complete") return "danger";
  if (phaseNeedsAttention(task.phase as Parameters<typeof phaseNeedsAttention>[0])) return "danger";
  if (task.phase === "changes_requested") return "warning";
  if (["dispatching", "working"].includes(task.phase)) return "accent";
  if (["awaiting_review", "report_ready", "reviewing", "verifying", "merging", "syncing", "closing"].includes(task.phase)) return "success";
  return "neutral";
}

/** Distinguish a dispatch-blocking hold from a merge-only hold on dark surfaces. */
export function holdBadgeTone(kind: "dispatch" | "merge"): BadgeTone {
  return kind === "dispatch" ? "warning" : "accent";
}
/** Spec 050 stop badge: an incident is red, coordinator recovery keeps the Queue-raised accent, a stopped run is amber like a hold. */
export function stopBadgeTone(kind: "hold" | "incident" | "recovery" | "attention" | "wait" | "run"): BadgeTone {
  return kind === "incident" ? "danger" : kind === "recovery" ? "accent" : "warning";
}
