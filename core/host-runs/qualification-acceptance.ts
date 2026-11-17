/**
 * Spec 064 P6: the acknowledgement the endpoint alone writes.
 *
 * The endpoint validates the combined artifact's framing and subject, compares
 * the decoded payload counts and hashes with S's observed stream counts and hashes
 * and its real EOF/DRAIN observations, and then durably acknowledges those exact
 * counts, hashes, marker sequences and observation digest. The ack records its
 * own acceptance tick and whether that tick was inside the original target: a
 * late ack cannot recover a pass, and a lost ack is not permission to publish or
 * copy anything again.
 */
import { readCheckedHostRunFileRead, writeVerifiedOwnedFile } from "./host-run-files";
import { qualificationDigest } from "./qualification-binding";
import { decodeQualificationRaw, type QualificationRawSummary } from "./host-run-retained-output";
import {
  hostRunQualificationAckSchema,
  type HostRunQualificationAck,
  type HostRunQualificationCapture,
  type HostRunQualificationObservation,
} from "../../shared/schema/host-runs";
import type { QualificationFirstEffectClock } from "../../shared/schema/review/proof";
import { firstEffectClockReading } from "./qualification-clock";
import { QUALIFICATION_ACK_LEAF, assertQualificationEvidenceWriter } from "./qualification-evidence";

export type QualificationAckBody = Omit<HostRunQualificationAck, "format" | "version" | "digest">;

/** The ack's canonical digest: what S observes and what a settlement names. */
export function qualificationAckDigest(ack: QualificationAckBody): string {
  return qualificationDigest(ack);
}

export type QualificationAckOutcome =
  | { state: "refused"; refusals: string[] }
  | { state: "acknowledged"; ack: HostRunQualificationAck; digest: string };

/** Every disagreement between what S observed and what the artifact actually holds. */
export function qualificationCaptureDisagreements(capture: HostRunQualificationCapture, summary: QualificationRawSummary): string[] {
  const refusals: string[] = [];
  if (summary.bytes !== capture.bytes) refusals.push(`the artifact is ${summary.bytes} bytes, not the ${capture.bytes} S recorded`);
  if (summary.artifactSha256 !== capture.artifactSha256) refusals.push(`the artifact digest ${summary.artifactSha256} is not S's ${capture.artifactSha256}`);
  if (summary.frameCount !== capture.frameCount) refusals.push(`the artifact has ${summary.frameCount} frames, not the ${capture.frameCount} S recorded`);
  if (summary.dataFrameCount !== capture.dataFrameCount) refusals.push(`the artifact has ${summary.dataFrameCount} DATA frames, not the ${capture.dataFrameCount} S recorded`);
  for (const stream of ["stdout", "stderr"] as const) {
    const observed = capture.streams[stream];
    const decoded = summary.streams[stream];
    if (decoded.payloadBytes !== observed.payloadBytes) refusals.push(`the ${stream} payload is ${decoded.payloadBytes} bytes, not S's ${observed.payloadBytes}`);
    if (decoded.payloadSha256 !== observed.payloadSha256) refusals.push(`the ${stream} payload digest ${decoded.payloadSha256} is not S's ${observed.payloadSha256}`);
    if (decoded.dataFrames !== observed.dataFrames) refusals.push(`the ${stream} stream has ${decoded.dataFrames} DATA frames, not S's ${observed.dataFrames}`);
    if (decoded.eofSequence !== observed.eofSequence) refusals.push(`the ${stream} EOF landing at sequence ${decoded.eofSequence} is not S's ${observed.eofSequence}`);
    if (decoded.drainSequence !== observed.drainSequence) refusals.push(`the ${stream} DRAIN landing at sequence ${decoded.drainSequence} is not S's ${observed.drainSequence}`);
  }
  return refusals;
}

/**
 * Validate and durably acknowledge one qualification attempt's capture. The
 * endpoint is the only writer: a refusal writes nothing at all, so a disputed
 * artifact never acquires an acknowledgement.
 */
export function acknowledgeQualificationCapture(input: {
  stateDir: string;
  runId: string;
  epoch: number;
  subjectDigest: string;
  clock: QualificationFirstEffectClock;
  observation: HostRunQualificationObservation;
  /** The decoded artifact, when the caller already holds it; otherwise it is read and decoded here. */
  summary?: QualificationRawSummary;
  nowMs: number;
}): QualificationAckOutcome {
  assertQualificationEvidenceWriter(QUALIFICATION_ACK_LEAF, "endpoint");
  const { stateDir, runId, observation } = input;
  const refusals: string[] = [];
  if (observation.runId !== runId) refusals.push(`the observation names run ${observation.runId}, not ${runId}`);
  if (observation.subjectDigest !== input.subjectDigest) refusals.push(`the observation's subject ${observation.subjectDigest} is not this attempt's ${input.subjectDigest}`);
  if (observation.clock.clockId !== input.clock.clockId || observation.clock.originTick !== input.clock.originTick)
    refusals.push(`the observation's clock ${observation.clock.clockId}@${observation.clock.originTick} is not this attempt's ${input.clock.clockId}@${input.clock.originTick}`);

  let summary = input.summary ?? null;
  if (!summary) {
    const read = readCheckedHostRunFileRead(stateDir, ["runs", runId, "qualification.raw"]);
    if (read.state === "absent") refusals.push("the combined artifact is absent; there is nothing to acknowledge");
    else if (read.state === "unreadable") refusals.push(`the combined artifact cannot be read: ${read.reason}`);
    else {
      try { summary = decodeQualificationRaw(read.bytes).summary; }
      catch (error) { refusals.push(`the combined artifact does not decode: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  if (summary) refusals.push(...qualificationCaptureDisagreements(observation.capture, summary));
  if (refusals.length || !summary) return { state: "refused", refusals };

  const reading = firstEffectClockReading(input.clock, input.nowMs);
  const body: QualificationAckBody = {
    runId, epoch: input.epoch, subjectDigest: input.subjectDigest,
    observationDigest: observation.digest,
    clock: input.clock,
    acceptedAt: new Date(input.nowMs).toISOString(),
    acceptedTick: input.nowMs,
    withinTarget: reading.withinTarget,
    artifact: {
      path: observation.capture.path, bytes: summary.bytes, sha256: summary.artifactSha256,
      frameCount: summary.frameCount, dataFrameCount: summary.dataFrameCount,
      expectedBytes: observation.capture.expectedBytes, sizeIdentityHolds: observation.capture.sizeIdentityHolds,
    },
    streams: {
      stdout: { stream: "stdout", ...summary.streams.stdout },
      stderr: { stream: "stderr", ...summary.streams.stderr },
    },
  };
  const ack: HostRunQualificationAck = hostRunQualificationAckSchema.parse({
    format: "host.run.qualification.ack", version: 1, ...body, digest: qualificationAckDigest(body),
  });
  // The acknowledgement is durable before anyone reads it: a crash after this
  // write leaves the same subject-bound record, never a reason to run again.
  writeVerifiedOwnedFile(stateDir, ["runs", runId, QUALIFICATION_ACK_LEAF], JSON.stringify(ack), 0o600);
  return { state: "acknowledged", ack, digest: ack.digest };
}

export type QualificationAckRead =
  | { state: "absent" }
  | { state: "present"; ack: HostRunQualificationAck }
  | { state: "unreadable"; reason: string };

/** Read one acknowledgement; an ack whose own digest does not cover it is unreadable, not absent. */
export function readQualificationAck(stateDir: string, runId: string): QualificationAckRead {
  const read = readCheckedHostRunFileRead(stateDir, ["runs", runId, QUALIFICATION_ACK_LEAF]);
  if (read.state !== "present") return read;
  try {
    const ack = hostRunQualificationAckSchema.parse(JSON.parse(read.bytes.toString("utf8")));
    if (ack.runId !== runId) return { state: "unreadable", reason: `the ack names run ${ack.runId}` };
    const { format: _format, version: _version, digest, ...body } = ack;
    if (digest !== qualificationAckDigest(body)) return { state: "unreadable", reason: "the ack's own digest does not cover its bytes" };
    return { state: "present", ack };
  } catch (error) {
    return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
}
