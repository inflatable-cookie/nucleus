import type {
  Completion,
  LaneDocumentVersion,
  Run,
  Task,
} from "../../shared/contracts";
import { heldBriefQueuePolicy } from "../planning/handoff";
import type { Resolution } from "../resolution";
import type { Store } from "../store/store";
import { recordResultApplied, resultApplied } from "./applied-result";
import { admitPhaseFacts } from "../scheduling/phase-latency";

const ARTIFACT_RULE =
  "report_ready artifact must identify the latest exact Nucleus lane document version and digest";

/**
 * One refusal family, always naming what the intake actually compared: the artifact
 * the report carried and the stored version and digest of the lane's latest document.
 * A 64-character digest transcribed one character wrong, or a lane another writer moved
 * after the worker read it, otherwise raises the same bare sentence and reads as a stale
 * Nucleus view (nucleus#1466, effigy#622: the report refused the version 176 digest the
 * store actually holds). The message is the visible cause and the route out: re-read the
 * lane document and report the latest exact version and digest.
 */
function artifactMismatch(
  artifact: NonNullable<Completion["artifact"]>,
  exact: LaneDocumentVersion | null,
  latest: LaneDocumentVersion | null,
): string | null {
  const reread =
    "; re-read it with lane.document.get and report that exact version and digest";
  if (!latest)
    return `${ARTIFACT_RULE}: lane ${artifact.key} holds no stored document; write the report to it and report the version and digest the edit returns`;
  const latestValues = `the latest version is ${latest.version} with digest ${latest.digest}`;
  if (
    !exact ||
    exact.key !== artifact.key ||
    exact.version !== artifact.version
  )
    return `${ARTIFACT_RULE}: lane ${artifact.key} holds no stored version ${artifact.version}, and ${latestValues}${reread}`;
  if (exact.digest !== artifact.digest)
    return `${ARTIFACT_RULE}: the report names lane ${artifact.key} version ${artifact.version} digest ${artifact.digest}, and the stored version ${artifact.version} has digest ${exact.digest}; ${latestValues}${reread}`;
  if (latest.version !== artifact.version || latest.digest !== artifact.digest)
    return `${ARTIFACT_RULE}: the report names lane ${artifact.key} version ${artifact.version} digest ${artifact.digest}, and ${latestValues}${reread}`;
  return null;
}

/**
 * `report_ready` is one report-only result: the brief it was dispatched under must
 * opt into report-only work, and the artifact it names must be the latest exact
 * version of a lane the task carries. Worker intake and revision intake read the
 * same rule here, so a gate added for one is never missing for the other.
 */
export function reportReadyRefusal(
  store: Pick<Store, "laneDocument">,
  task: Task,
  input: Completion,
): string | null {
  const briefText = task.briefVersions.at(-1)?.text ?? task.brief?.text;
  if (!briefText)
    return "report_ready requires a Nucleus-held brief with queue.reportOnly: true";
  let policy: ReturnType<typeof heldBriefQueuePolicy>;
  try {
    policy = heldBriefQueuePolicy(briefText);
  } catch {
    return "report_ready requires a valid Nucleus-held brief with queue.reportOnly: true";
  }
  if (!policy.reportOnly)
    return "report_ready is only allowed when the brief opts into queue.reportOnly: true";
  if (!input.artifact)
    return "report_ready requires the exact lane document artifact";
  if (policy.reportLane && input.artifact.key !== policy.reportLane)
    return `report_ready artifact must use the brief's report lane ${policy.reportLane}`;
  if (!task.lanes.includes(input.artifact.key))
    return "report_ready artifact must be a lane attached to this task";
  return artifactMismatch(
    input.artifact,
    store.laneDocument(input.artifact.key, input.artifact.version),
    store.laneDocument(input.artifact.key),
  );
}

export type ReportReadyFacts = {
  readonly store: Store;
  update: Resolution["update"];
};

/**
 * Settle a revision's report-only turn: the task records the result and returns to
 * `report_ready`. One fence (the applied-result event) holds however many passes
 * reach it, so a second application changes nothing.
 */
export function settleReportReady(
  facts: ReportReadyFacts,
  task: Task,
  run: Run,
  input: Completion,
): boolean {
  const latest = facts.store.task(task.id);
  if (
    resultApplied(facts.store, task.id, run.id) ||
    latest.resolution.currentRunId !== run.id
  )
    return false;
  facts.update(
    latest,
    { currentRunId: null, integrationTurn: null },
    { phase: "report_ready", completion: input, reason: input.summary },
    "revision_report_ready",
  );
  recordResultApplied(facts.store, task.id, run.id);
  admitPhaseFacts(facts.store, task.id);
  return true;
}
