/**
 * Spec 064 P1: one host-run submit's qualification subject.
 *
 * `submitQualification` resolves this before any submit write. Authentication is
 * the executor run's own recorded credential — the run ticket the callback
 * surface already issues — and every other field comes from Nucleus's records:
 * the task, the executor run's recorded proof intent, and the published source
 * read through `verifyProofSource`. A host-run token, a client-supplied caller
 * or a client-supplied subject grants nothing.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import type { HostRunSubmitBody } from "./host-run-wire";
import type { Store } from "../store/store";
import { verifyProofSource } from "../qa/proof-source";
import { ProofExecutionRefusal } from "../qa/proof-refusal";
import type { QualificationBinding, QualificationSubject } from "../../shared/schema/review/proof";
import { qualificationEnvironmentDigest, qualificationSubjectDigest } from "./qualification-binding";

/** Why a qualification submit was refused before any write. */
export type QualificationRefusalCode = "invalid" | "unauthenticated" | "subject_mismatch" | "source_unavailable" | "not_permitted";

export type QualificationResolution =
  | { state: "refused"; code: QualificationRefusalCode; refusal: string }
  | { state: "resolved"; binding: QualificationBinding };

export interface QualificationSubmitInput {
  /** The executor run's existing credential (its callback ticket's run and token). */
  credential: { taskId: string; runId: string; token: string };
  /** The host run the bound executor asks this endpoint to submit. */
  submission: HostRunSubmitBody;
  /** The host run identity this endpoint would submit under, resolved from the authenticated identity. */
  hostRun: { id: string; epoch: number };
  /** This endpoint's own environment, from which the effective PATH and HOME values come. */
  environment: Record<string, string | undefined>;
}

export interface QualificationSubjectPorts {
  /** The one credential owner: a run id and the token issued for it. */
  store: Pick<Store, "authenticate" | "run" | "task">;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const refused = (code: QualificationRefusalCode, refusal: string): QualificationResolution => ({ state: "refused", code, refusal });
const sha256 = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** One existing directory or file, canonicalized, or null when it is not one. */
function canonicalPath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/** The source refusal code for one `verifyProofSource` failure. */
function sourceRefusalCode(error: unknown): QualificationRefusalCode {
  if (!(error instanceof ProofExecutionRefusal)) return "source_unavailable";
  return error.code === "source_moved" || error.code === "source_dirty" || error.code === "source_branch"
    ? "subject_mismatch" : "source_unavailable";
}

/**
 * Resolve one qualification submit's immutable subject and command identity.
 * Every refusal happens here, before the caller writes anything: this function
 * performs no writes of its own.
 */
export function qualificationSubjectResolver(ports: QualificationSubjectPorts) {
  return async (input: QualificationSubmitInput): Promise<QualificationResolution> => {
    const { credential, submission, hostRun, environment } = input;

    // A client-supplied caller is not an identity: the authenticated run owns the submit.
    if (submission.caller !== credential.runId)
      return refused("subject_mismatch",
        `The submission caller ${JSON.stringify(submission.caller)} is not the authenticated executor run ${credential.runId}; a client-supplied caller grants no proof authority`);

    // The executor run's own recorded credential. A host-run token is not this
    // credential and cannot stand in for it: nothing here reads one.
    try { ports.store.authenticate(credential.runId, credential.token); }
    catch (error) { return refused("unauthenticated", `The executor-run credential did not authenticate: ${messageOf(error)}`); }

    const run = ports.store.run(credential.runId);
    if (!run) return refused("unauthenticated", `No run ${credential.runId} is recorded, so no subject can be resolved`);
    if (run.taskId !== credential.taskId)
      return refused("subject_mismatch", `Run ${run.id} belongs to task ${run.taskId}, not the named task ${credential.taskId}`);
    if (run.role !== "executor")
      return refused("subject_mismatch", `Run ${run.id} is a ${run.role} run, not an author-side proof executor`);
    const bound = run.proofExecution;
    if (!bound) return refused("subject_mismatch", `Executor run ${run.id} records no bound proof subject, so it has no qualification to submit`);
    if (run.released)
      return refused("not_permitted", `Executor run ${run.id} is released; its one proof execution is spent and is never repeated or refunded`);
    const task = ports.store.task(run.taskId);
    if (!task) return refused("subject_mismatch", `Task ${run.taskId} is not recorded`);

    // The subject, recomputed from the store. A run that carries a recorded
    // subject must match it exactly: the intent cannot be reinterpreted later.
    const subject: QualificationSubject = {
      taskId: task.id, participantRunId: run.id,
      operationId: bound.operationId ?? null, briefVersion: bound.briefVersion ?? null, briefDigest: bound.briefDigest ?? null,
      head: run.head, tree: bound.tree, selector: bound.selector, inputs: bound.inputs, authorizedBy: bound.authorizedBy,
    };
    const subjectDigest = qualificationSubjectDigest(subject);
    const recorded = bound.qualification?.subject;
    if (recorded) {
      const recordedDigest = qualificationSubjectDigest(recorded);
      if (recordedDigest !== subjectDigest)
        return refused("subject_mismatch",
          `The proof subject recomputed from the store (${subjectDigest}) is not the subject this run recorded (${recordedDigest}); the subject is immutable and is never reinterpreted`);
    }
    if (submission.selector !== subject.selector)
      return refused("subject_mismatch", `The submitted selector ${JSON.stringify(submission.selector)} is not the bound subject's selector ${JSON.stringify(subject.selector)}`);

    // The command runs from the subject's own checkout, with no shell between them.
    const cwd = canonicalPath(submission.cwd);
    const checkout = task.directory ? canonicalPath(task.directory) : null;
    if (!cwd || !checkout || cwd !== checkout)
      return refused("subject_mismatch",
        `The submitted cwd ${JSON.stringify(submission.cwd)} is not the subject's checkout ${JSON.stringify(task.directory ?? null)}`);
    const requestedExecutable = submission.argv[0];
    const executable = requestedExecutable.startsWith("/") ? canonicalPath(requestedExecutable) : null;
    let executableBytes: Buffer | null = null;
    if (executable) {
      try { if (statSync(executable).isFile()) executableBytes = readFileSync(executable); } catch { executableBytes = null; }
    }
    if (!executable || !executableBytes)
      return refused("invalid",
        `The submitted executable ${JSON.stringify(requestedExecutable)} is not an absolute regular file; no shell, PATH lookup or synthetic admission token stands in for it`);

    // Source recheck before effects: the checkout must still be the bound head and
    // tree, with the published branch at that head.
    let source;
    try { source = await verifyProofSource(task, subject.head); }
    catch (error) { return refused(sourceRefusalCode(error), messageOf(error)); }
    if (source.tree !== subject.tree)
      return refused("subject_mismatch",
        `The checked-out tree ${source.tree} is not the bound tree ${subject.tree}; the subject's source moved before any effect`);

    // The effective environment values, not just their names. The one secret
    // per-launch variable is recorded as a key only and never enters the digest.
    const effective: Record<string, string> = {
      ...submission.env, PATH: environment.PATH ?? "", HOME: environment.HOME ?? "",
    };
    return {
      state: "resolved",
      binding: {
        subject,
        execution: {
          hostRunId: hostRun.id, hostEpoch: hostRun.epoch,
          executable, executableDigest: sha256(executableBytes),
          argv: submission.argv, cwd,
          environmentKeys: Object.keys(effective).sort(),
          environmentDigest: qualificationEnvironmentDigest(effective),
        },
      },
    };
  };
}

export type QualificationSubjectResolve = ReturnType<typeof qualificationSubjectResolver>;
