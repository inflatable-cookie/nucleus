import type { BuildOutputCleanup } from "./contracts";

/**
 * Nucleus #395 (papercut: a continuation reused artifacts a run-bound cleanup had
 * already settled). Existing `next`, task detail and continuation prompts now
 * quote the task's recorded run-bound build output cleanup before any artifact
 * is reused, so a later proof gate cannot mistake an earlier build, cache,
 * binary or test result for present output.
 *
 * The record is provenance, not a claim about right now: `complete` names
 * Nucleus's own cleanup obligation for that root, so it neither proves the target
 * was deleted nor that anything remains. This module only formats stored
 * records; it adds no probe, record, policy or authority.
 */

/** How much of one recorded detail the disclosure quotes. */
export const BUILD_OUTPUT_DETAIL_LIMIT = 400;
/** How many records one disclosure quotes; the rest are counted, never dropped silently. */
export const BUILD_OUTPUT_RECORD_LIMIT = 4;
/** How long the one-sentence owner-verb note may be. */
export const BUILD_OUTPUT_NOTE_LIMIT = 480;

/** What a record's own detail says Nucleus observed, if anything. */
export type BuildOutputObservation = "removed" | "retained" | "link" | "empty";

const observationLabels: Record<BuildOutputObservation, string> = {
  removed: "a recorded removal",
  retained: "output retained for the next continuation",
  link: "a symlink left in place whose target was untouched",
  empty: "no build output root present",
};

export interface BuildOutputDisclosureEntry {
  /** The run the record names; a terminal workspace record has none. */
  runId: string | null;
  workspaceId: string;
  at: string;
  state: BuildOutputCleanup["state"];
  /** What the recorded detail says was observed; empty when it claims no observation. */
  observations: BuildOutputObservation[];
  /** The recorded detail, whitespace-collapsed and bounded. */
  detail: string;
  /** The record names the workspace a continuation resumes in. */
  sameWorkspace: boolean;
  /** The record names the run the caller asked about. */
  subjectRun: boolean;
}

export interface BuildOutputDisclosure {
  entries: BuildOutputDisclosureEntry[];
  /** Records the bound left out of `entries`. */
  omitted: number;
  /** A named run with no record of its own: it recorded no result, or predates run-bound records. */
  missingRunId: string | null;
  /** One bounded paragraph for a prompt or a detail surface. */
  text: string;
  /** One bounded sentence beside an available owner continuation verb. */
  note: string;
}

export interface BuildOutputDisclosureSubject {
  /** The workspace a continuation would resume in. */
  workspaceId?: string | null;
  /** The run whose outputs a continuation might reuse. */
  runId?: string | null;
}

const collapse = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** Bounded and collapsed: a record's full detail can name many roots and reasons. */
export const boundedBuildOutputDetail = (detail: string, limit = BUILD_OUTPUT_DETAIL_LIMIT) => {
  const text = collapse(detail ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
};

/** Read the recorded detail, never the state alone, for what Nucleus observed. */
export function buildOutputObservations(detail: string): BuildOutputObservation[] {
  const text = detail ?? "";
  const found: BuildOutputObservation[] = [];
  if (/Removed (?:task-local )?(?:Cargo target output|node_modules) at /.test(text)) found.push("removed");
  if (/Retained node_modules at /.test(text)) found.push("retained");
  if (/symlink left in place; target untouched/.test(text)) found.push("link");
  if (!found.length && /No build output roots were present/.test(text)) found.push("empty");
  return found;
}

const stateLabel = (state: BuildOutputCleanup["state"]) => state === "intent"
  ? "recorded, awaiting settlement"
  : `recorded ${state}`;

/**
 * Every recorded cleanup the subject can rely on, bounded and ordered so the
 * workspace being resumed comes first (newest first), then other workspaces.
 */
export function buildOutputDisclosure(
  cleanups: readonly BuildOutputCleanup[] | null | undefined,
  subject: BuildOutputDisclosureSubject = {},
): BuildOutputDisclosure | null {
  const records = [...(cleanups ?? [])];
  const workspaceId = subject.workspaceId ?? null;
  const runId = subject.runId ?? null;
  const named = runId ? records.find(record => record.runId === runId && (!workspaceId || record.workspaceId === workspaceId)) : undefined;
  const missingRunId = runId && !named ? runId : null;
  if (!records.length && !missingRunId) return null;

  const ordered = records.sort((left, right) => {
    const leftSame = workspaceId !== null && left.workspaceId === workspaceId ? 0 : 1;
    const rightSame = workspaceId !== null && right.workspaceId === workspaceId ? 0 : 1;
    if (leftSame !== rightSame) return leftSame - rightSame;
    const at = right.at.localeCompare(left.at);
    return at !== 0 ? at : (left.runId ?? "").localeCompare(right.runId ?? "");
  });
  const quoted = ordered.slice(0, BUILD_OUTPUT_RECORD_LIMIT);
  const entries = quoted.map((record): BuildOutputDisclosureEntry => ({
    runId: record.runId ?? null, workspaceId: record.workspaceId, at: record.at, state: record.state,
    observations: buildOutputObservations(record.detail),
    detail: boundedBuildOutputDetail(record.detail),
    sameWorkspace: workspaceId !== null && record.workspaceId === workspaceId,
    subjectRun: Boolean(runId) && record.runId === runId,
  }));
  const omitted = ordered.length - entries.length;

  const lines = entries.map(entry => {
    const owner = entry.runId ? `run ${entry.runId}${entry.subjectRun ? " (the run being continued)" : ""}` : "a terminal workspace record with no run";
    const where = entry.sameWorkspace ? `workspace ${entry.workspaceId}` : `workspace ${entry.workspaceId}, another workspace rather than this checkout`;
    const observed = entry.observations.length ? `, ${entry.observations.map(kind => observationLabels[kind]).join(" and ")}` : "";
    return `- ${owner} in ${where}, ${stateLabel(entry.state)} at ${entry.at}${observed}. Recorded detail: "${entry.detail}"`;
  });
  if (missingRunId) lines.push(`- run ${missingRunId}${workspaceId ? ` in workspace ${workspaceId}` : ""} has no run-bound cleanup record: it reported no result, or it ran before Nucleus recorded run-bound cleanup. Nucleus claims nothing about the output it left behind.`);
  if (omitted) lines.push(omitted === 1
    ? "- 1 further recorded cleanup record exists beyond this bounded disclosure; read the task's cleanup records in Nucleus."
    : `- ${omitted} further recorded cleanup records exist beyond this bounded disclosure; read the task's cleanup records in Nucleus.`);

  const text = `Run-bound build output cleanup disclosure — Nucleus's own records, not a proof of present outputs:
${lines.join("\n")}
Prior build artifacts are not guaranteed retained: re-run every command whose output you rely on, and never cite an earlier build, cache, binary, test result or proof artifact as present output. "complete" records Nucleus's own cleanup obligation for that root; it does not prove the output was deleted, a runtime or container exited, capacity was released, or that anything is still there now, and a symlink it left in place never means its target was touched. Missing or uncertain is not absence, replay authority, capacity release or success. This disclosure changes no cleanup, retention, proof or execution policy and grants no authority to rebuild, reseed, refund budget, replay proof, waive cleanup or retain artifacts; published proof remains history, and any fresh proof still needs current identity and authorisation.`;

  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
  const stateSummary = [...counts.entries()].map(([state, count]) => `${count} ${state}`).join(", ");
  // Count every record, quoted or omitted, so the sentence and the bound cannot disagree.
  const crossWorkspace = ordered.filter(record => workspaceId === null || record.workspaceId !== workspaceId).length;
  const parts = [
    entries.length || omitted
      ? `Nucleus recorded run-bound build output cleanup for this task${stateSummary ? ` (${stateSummary})` : ""}${crossWorkspace ? `, ${crossWorkspace} of them in another workspace` : ""}`
      : "",
    missingRunId ? `no run-bound cleanup record names run ${missingRunId}` : "",
    "prior build artifacts are not guaranteed retained, so re-run any command whose output you rely on",
  ].filter(Boolean);
  const note = boundedBuildOutputNote(`${parts.join("; ")}. ${BUILD_OUTPUT_AUTHORITY_SENTENCE}`);

  return { entries, omitted, missingRunId, text, note };
}

/** The one standing limit every owner-facing sentence keeps. */
export const BUILD_OUTPUT_AUTHORITY_SENTENCE = `That record grants no authority to rebuild, reseed, refund budget, replay proof, waive cleanup or retain artifacts, and an earlier proof or build result is not evidence of present output.`;

const boundedBuildOutputNote = (note: string) => note.length <= BUILD_OUTPUT_NOTE_LIMIT
  ? note
  : `${note.slice(0, BUILD_OUTPUT_NOTE_LIMIT - 1).trimEnd()}…`;
