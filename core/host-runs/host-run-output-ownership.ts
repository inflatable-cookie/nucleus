/**
 * Who owns a settled host run's output (task 444 amendment).
 *
 * A launched, settled run whose `runs/<id>/stdout` and `runs/<id>/stderr` are
 * both absent is not automatically a missing generic host-run stream: Queue's
 * milestone Project QA is submitted to the host-run scheduler with its own
 * handler, and its pipeline writes separate step logs owned by the QA
 * supervisor. The generic host-run supervisor — the only writer of
 * `runs/<id>/stdout` and `runs/<id>/stderr` — never ran for it. Treating that
 * absence as an unavailable expiry recorded 100 live false positives (every one
 * of them a milestone QA run) and, before task 444, dropped the identities past
 * the summary cap.
 *
 * Classification is therefore provenance, not a prefix, a path or an absence:
 *
 * - the exact host-run id must have a `project_qa_runs` record of the same id;
 * - the host run's caller must be exactly the canonical milestone identity for
 *   the key that run was submitted under, so a forged prefix or a caller naming
 *   another run is not ownership. A repository re-key moves the QA row's key but
 *   never the immutable caller, so the submitted key is resolved from the row's
 *   own key, its recorded `submittedKey` or the applied re-key receipts that
 *   moved it (task 445, `qa-caller-provenance.ts`);
 * - the two records must name the same repository — the identity the caller's
 *   key belongs to — and the QA record must pin the host-run epoch the run now
 *   holds;
 * - the observed generic streams must both be absent. A present, refused or
 *   unreadable stream, a corrupt or foreign retention marker, or a partial
 *   stream is contradictory actual-output evidence and stays unknown.
 *
 * Every other case — no QA record, a legacy QA row without a pinned epoch, a
 * mismatched id/key/repository, an unreadable record — stays `unknown`, so its
 * durable failure remains visible. Attribution says Project QA owns the output;
 * it never claims QA logs exist, that QA passed, or that any byte count or
 * offset is zero. QA's own logs are that producer's separate truth and are
 * never read, altered or redirected to by this sweep.
 */
import type { ProjectQaRun } from "../../shared/contracts";
import type { HostRunRetainedStream } from "./host-run-output-failures";
import { qaKeyNamesRepository, qaSameRepository, resolveQaCallerKey, type QaCallerKeyResolution, type QaCallerLineageStep } from "../qa/qa-caller-provenance";
import type { RepositoryRekeyReceipt } from "../../shared/repository-rekey";
import { parseProjectValidationCaller } from "../qa/project-validation-caller";

/** The run fields the classification may read; all are durable record fields. */
export interface RetainedOutputOwnershipRun {
  id: string;
  epoch: number;
  caller: string;
  repository: { origin: string | null; path: string };
}

/** The streams the sweep actually observed for this run. */
export interface RetainedOutputStreams {
  stdout: HostRunRetainedStream;
  stderr: HostRunRetainedStream;
}

export type RetainedOutputOwnership =
  | {
    owner: "project_qa";
    qaRunId: string;
    /** The key the caller was minted from: the row's current key, or the verified original one. */
    key: string;
    repository: string;
    caller: string;
    /** How the caller's key was established (task 445); empty when the current key answered. */
    lineage: QaCallerLineageStep[];
    /** The evidence statement: ownership, and only ownership. */
    detail: string;
  }
  | {
    owner: "project_validation";
    taskId: string;
    head: string;
    repository: string;
    caller: string;
    detail: string;
  }
  | { owner: "unknown"; reason: string };

const streamSummary = (streams: RetainedOutputStreams): string =>
  `stdout is ${streams.stdout.state}, stderr is ${streams.stderr.state}`;

/** Both observed streams must be absent; any other state is output evidence. */
function absentStreams(streams: RetainedOutputStreams): boolean {
  return streams.stdout.state === "absent" && streams.stderr.state === "absent";
}

/**
 * Classify a launched run whose generic host-run streams were both observed
 * absent. `qaRun` is the `project_qa_runs` row with this run's id, or null when
 * there is none or it could not be read (the caller reports unreadable records
 * as unknown rather than guessing). `rekeys` reads the durable applied repository
 * re-key receipts, and is called only when the row's current key cannot answer
 * (task 445), so an ordinary run never reads them.
 */
export function classifyRetainedOutputOwnership(input: {
  run: RetainedOutputOwnershipRun;
  qaRun: ProjectQaRun | null;
  streams: RetainedOutputStreams;
  rekeys?: () => readonly RepositoryRekeyReceipt[];
}): RetainedOutputOwnership {
  const { run, qaRun, streams } = input;
  if (!absentStreams(streams))
    return { owner: "unknown", reason: `the generic host-run streams are not both absent (${streamSummary(streams)})` };
  if (!qaRun || qaRun.id !== run.id)
    return { owner: "unknown", reason: `no Project QA record names host run ${run.id}` };
  // Task 445: the caller is immutable history minted from the run's *submitted*
  // key, so a repository re-key moves the row's key out from under it. The key is
  // resolved from the row's own key, its recorded submitted key, or the applied
  // re-key receipts that moved this repository — never from a prefix, a path that
  // merely matches or a name the repository once held.
  const resolved = resolveQaCallerKey({ runId: run.id, caller: run.caller, qaRun, runRepository: run.repository, rekeys: input.rekeys });
  if ("reason" in resolved) {
    // A row whose own key does not even name its own repository, beside a run that
    // names another one, is the repository mismatch 444 already refused; anything
    // else is a caller this run's recorded identity cannot place.
    if (resolved.cause === "repository" || (!qaKeyNamesRepository(qaRun.key, qaRun.repository) && !qaSameRepository(run.repository, qaRun.repository)))
      return { owner: "unknown", reason: `the Project QA record and the host run name different repositories (${resolved.reason})` };
    return {
      owner: "unknown",
      reason: `the host-run caller is not the canonical milestone identity for Project QA run ${qaRun.id} (${resolved.reason})`,
    };
  }
  // The resolver has already required the immutable host-run record to name the
  // repository the accepted key belongs to: the row's own current repository for a
  // current key, the submitted identity for a recorded submitted key, and — for a
  // receipt-derived ancestor — its reconstructed identity and checkout, or its
  // identity alone when the step moved the checkout.
  if (qaRun.hostRunEpoch === undefined)
    return { owner: "unknown", reason: `the Project QA record does not pin the host-run epoch` };
  if (qaRun.hostRunEpoch !== run.epoch)
    return { owner: "unknown", reason: `the Project QA record pins host-run epoch ${qaRun.hostRunEpoch}, not ${run.epoch}` };
  const repository = qaRun.repository.origin ?? qaRun.repository.path;
  return {
    owner: "project_qa", qaRunId: qaRun.id, key: resolved.key, repository, caller: run.caller, lineage: resolved.lineage,
    detail: ownershipDetail({ qaRunId: qaRun.id, currentKey: qaRun.key, resolved }),
  };
}

/**
 * The durable evidence statement, bounded to the reclassification record's own
 * 400-character field: the ownership, the accepted key, how that key was
 * established, and what the sweep does not claim about the bytes. A long
 * repository name shortens the lineage wording rather than failing the write, and
 * the receipts themselves stay the durable evidence either way.
 */
function ownershipDetail(input: { qaRunId: string; currentKey: string; resolved: QaCallerKeyResolution }): string {
  const { qaRunId, currentKey, resolved } = input;
  const head = `retained output owned by Project QA run ${qaRunId} (key ${resolved.key}`;
  const tail = "); the generic host-run supervisor wrote no stream, so no retained byte count or offset exists to expire";
  const moves = resolved.lineage.length;
  const label = moves === 1 ? "repository re-key" : `${moves} repository re-keys`;
  const candidates = [
    resolved.source === "row_provenance" ? `, caller key ${resolved.key} recorded as this run's submitted key and now ${currentKey}` : "",
    moves ? `, caller key ${resolved.key} verified through ${label} ${resolved.lineage
      .map(step => `${step.from} → ${step.to} at ${step.at} (receipt ${step.receiptId})`).join(", ")} and now ${currentKey}` : "",
    moves ? `, caller key ${resolved.key} verified through ${label} ending ${resolved.lineage[0]!.to} and now ${currentKey}` : "",
    moves ? `, caller key ${resolved.key} verified through ${label}` : "",
  ].filter(candidate => candidate !== "");
  for (const candidate of candidates) {
    const detail = `${head}${candidate}${tail}`;
    if (detail.length <= 400) return detail;
  }
  return `${head}${tail}`.slice(0, 400);
}

/**
 * Merge-time project validation owns its output the same way milestone QA does:
 * the validation supervisor keeps its own per-run state and result, and the
 * generic supervisor never wrote `runs/<id>/stdout` or `stderr` for it.
 *
 * Ownership is provenance, never a prefix: the caller must be exactly the
 * canonical `queue:validation:<task>:<head>` identity, the host run must be
 * positively Queue-submitted, and the named task must durably record scheduling
 * this exact run at this exact epoch and head (`project_validation_scheduler_recorded`,
 * or its live validation pin naming all three). `recorded` is that lookup, and
 * it fails for a different head or a changed epoch. An absent submission source
 * is a historical row, so `queueSubmitted` has to prove Queue's own submit from
 * the durable journal; anything else stays `unknown` and its failure stays
 * visible.
 */
export function classifyProjectValidationOutputOwnership(input: {
  run: RetainedOutputOwnershipRun & { submissionSource?: "queue" | "client" | "admission" };
  streams: RetainedOutputStreams;
  /** Positive proof this exact run came through Queue's submit path when the row predates the field. */
  queueSubmitted: () => boolean;
  recorded: (taskId: string, head: string) => boolean;
}): RetainedOutputOwnership | null {
  const { run, streams } = input;
  const named = parseProjectValidationCaller(run.caller);
  if (!named) return null;
  if (!absentStreams(streams))
    return { owner: "unknown", reason: `the generic host-run streams are not both absent (${streamSummary(streams)})` };
  if (run.submissionSource !== undefined && run.submissionSource !== "queue")
    return { owner: "unknown", reason: `the host run was not submitted by Queue (${run.submissionSource}), so its validation caller proves nothing` };
  if (run.submissionSource === undefined) {
    // A historical row that predates the pinned `submissionSource`. The journal
    // is the only durable evidence left, and only its own submit request is
    // Queue's: the client method refutes, and nothing readable proves nothing.
    let submitted: boolean;
    try { submitted = input.queueSubmitted(); }
    catch (error) { return { owner: "unknown", reason: `the host run's submission source could not be read (${error instanceof Error ? error.message : String(error)})` }; }
    if (!submitted)
      return { owner: "unknown", reason: "the stored host run names no submission source and its journal records no Queue submission, so its validation caller proves nothing" };
  }
  let recorded: boolean;
  try { recorded = input.recorded(named.taskId, named.head); }
  catch (error) { return { owner: "unknown", reason: `the project validation record could not be read (${error instanceof Error ? error.message : String(error)})` }; }
  if (!recorded)
    return { owner: "unknown", reason: `task ${named.taskId} records no project validation scheduled as host run ${run.id} at epoch ${run.epoch} and head ${named.head}` };
  return {
    owner: "project_validation", taskId: named.taskId, head: named.head,
    repository: run.repository.origin ?? run.repository.path, caller: run.caller,
    detail: `retained output owned by project validation of task ${named.taskId} at ${named.head}; the generic host-run supervisor wrote no stream, so no retained byte count or offset exists to expire`.slice(0, 400),
  };
}
