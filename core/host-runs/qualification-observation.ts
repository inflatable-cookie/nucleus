/**
 * Spec 064 P6: the observation S alone writes.
 *
 * It binds the subject, the first-effect clock, S's own direct-child wait, the
 * parent waits S holds, each stream's real terminal events, the one combined
 * artifact's exact evidence and the storage ledger. It is metadata: identities,
 * counts, hashes and outcomes, never another copy of the payload.
 */
import {
  hostRunQualificationObservationSchema,
  type HostRunQualificationCapture,
  type HostRunQualificationObservation,
  type HostRunQualificationStreamEvidence,
  type HostRunQualificationWait,
} from "../../shared/schema/host-runs";
import type { QualificationRawEvidence } from "./host-run-retained-output";
import type { DirectChildWait } from "../machine/process-exec";
import { readCheckedHostRunFileRead, writeVerifiedOwnedFile } from "./host-run-files";
import { qualificationDigest } from "./qualification-binding";
import {
  QUALIFICATION_OBSERVATION_LEAF,
  assertQualificationEvidenceWriter,
} from "./qualification-evidence";

export type QualificationObservationBody = Omit<HostRunQualificationObservation, "format" | "version" | "digest">;

/**
 * Spec 064 P4/P6: what the capture proved, as the observation records it. The
 * flush is explicit — `not_applicable` for the unbuffered `writeSync` writer, and
 * `unknown` (never invented) when a sync or close faulted. A partial last frame
 * makes the file larger than the payload identity, so the real on-disk bytes are
 * what the ledger charges.
 */
export function qualificationCaptureEvidence(
  raw: QualificationRawEvidence,
  faults: readonly { kind: string; detail: string }[],
): HostRunQualificationCapture {
  const stream = (evidence: QualificationRawEvidence["streams"]["stdout"]): HostRunQualificationStreamEvidence => ({
    stream: evidence.stream, payloadBytes: evidence.payloadBytes, payloadSha256: evidence.payloadSha256,
    dataFrames: evidence.dataFrames, eofSequence: evidence.eofSequence, drainSequence: evidence.drainSequence,
  });
  return {
    path: raw.path, bytes: raw.bytes, frameCount: raw.frameCount, dataFrameCount: raw.dataFrameCount,
    artifactSha256: raw.artifactSha256,
    streams: { stdout: stream(raw.streams.stdout), stderr: stream(raw.streams.stderr) },
    expectedBytes: raw.expectedBytes, sizeIdentityHolds: raw.sizeIdentityHolds, latched: raw.latched,
    partialFrame: raw.bytes > raw.expectedBytes,
    flush: faults.some(fault => fault.kind === "fsync" || fault.kind === "close")
      ? { state: "unknown", reason: "the writer's fsync or close faulted, so no flush is claimed" }
      : raw.latched
        ? { state: "unknown", reason: "the artifact latched a capture fault before it was flushed" }
        // The writer is unbuffered `writeSync`: there is no user-space buffer to flush.
        : { state: "not_applicable", reason: "unbuffered: the writer uses writeSync and the artifact is fsynced, so there is no user-space flush to prove" },
  };
}

/**
 * Spec 064 P6: one creator's own direct-child wait as the observation records it.
 * A receipt copy conveys evidence, never wait authority: only the role whose
 * actual parent observed the exit may supply its wait.
 */
export function qualificationWaitEvidence(wait: DirectChildWait | null, role = "S -> E (direct command)"): HostRunQualificationWait | null {
  return wait ? {
    role, parentPid: wait.parentPid, parentStartIdentity: wait.parentStartIdentity,
    childPid: wait.childPid, childStartIdentity: wait.childStartIdentity, state: wait.state,
    code: wait.code, signal: wait.signal, observedAt: wait.observedAt, source: wait.source,
  } : null;
}

/** The canonical digest of an observation: the record's own identity, digest field excluded. */
export function qualificationObservationDigest(observation: QualificationObservationBody): string {
  return qualificationDigest(observation);
}

/**
 * Write S's observation beside the run. Only the supervisor writes this sidecar;
 * the durable publication is verified, and its returned facts say what proved
 * durable.
 */
export function writeQualificationObservation(stateDir: string, runId: string, body: QualificationObservationBody) {
  assertQualificationEvidenceWriter(QUALIFICATION_OBSERVATION_LEAF, "supervisor");
  const record: HostRunQualificationObservation = hostRunQualificationObservationSchema.parse({
    format: "host.run.qualification.observation", version: 1, ...body,
    digest: qualificationObservationDigest(body),
  });
  if (record.runId !== runId) throw new Error(`The qualification observation names run ${record.runId}, not ${runId}`);
  const publication = writeVerifiedOwnedFile(stateDir, ["runs", runId, QUALIFICATION_OBSERVATION_LEAF], JSON.stringify(record), 0o600);
  return { record, publication };
}

export type QualificationObservationRead =
  | { state: "absent" }
  | { state: "present"; observation: HostRunQualificationObservation }
  | { state: "unreadable"; reason: string };

/** Read one observation, keeping absent, present and unreadable apart. */
export function readQualificationObservation(stateDir: string, runId: string): QualificationObservationRead {
  const read = readCheckedHostRunFileRead(stateDir, ["runs", runId, QUALIFICATION_OBSERVATION_LEAF]);
  if (read.state !== "present") return read;
  try {
    const observation = hostRunQualificationObservationSchema.parse(JSON.parse(read.bytes.toString("utf8")));
    if (observation.runId !== runId) return { state: "unreadable", reason: `the observation names run ${observation.runId}` };
    const { format: _format, version: _version, digest, ...body } = observation;
    if (digest !== qualificationObservationDigest(body))
      return { state: "unreadable", reason: "the observation's own digest does not cover its bytes" };
    return { state: "present", observation };
  } catch (error) {
    return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
}
