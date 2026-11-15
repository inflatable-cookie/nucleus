/**
 * Contract 010's durable submission record: the idempotency key behind
 * `submit` and `status { caller, clientRequestId }`.
 *
 * One owner decides the key a caller/request pair names, what the record holds,
 * and what a read established. A record that exists but cannot be read is
 * `unreadable`, never `absent`: treating it as absent would overwrite a
 * durable key and re-run work whose identity is unknown.
 */
import { createHash } from "node:crypto";
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { storedBodySchema } from "./host-run-wire";
import {
  readCheckedHostRunFileRead,
  writeVerifiedOwnedFile,
} from "./host-run-files";
import {
  redactHostRunData,
} from "./host-run-redact";
import type { StoredSubmission } from "./host-run-endpoint-types";

export const HOST_RUN_SUBMISSION_FORMAT = "host.run.submission";

/** What one read of a run's durable submission established. */
export type StoredSubmissionRead =
  | { state: "present"; stored: StoredSubmission }
  | { state: "absent" }
  | { state: "unreadable"; reason: string };

/** The run id one caller's client request names; the same pair always names the same run. */
export function submissionRunId(caller: string, clientRequestId: string): string {
  return createHash("sha256").update(`${caller}\u0000${clientRequestId}`).digest("hex");
}

const submissionParts = (runId: string) => ["runs", runId, "submission.json"];

/** The run's durable submission, keeping a present, an absent and an unreadable record apart. */
export function readStoredSubmission(stateDir: string, runId: string): StoredSubmissionRead {
  const read = readCheckedHostRunFileRead(stateDir, submissionParts(runId));
  if (read.state === "absent") return { state: "absent" };
  if (read.state === "unreadable") return { state: "unreadable", reason: read.reason };
  try {
    const parsed = JSON.parse(read.bytes.toString("utf8")) as { stored?: unknown };
    const stored = parsed.stored as StoredSubmission;
    return { state: "present", stored: { ...stored, body: storedBodySchema.parse(redactHostRunData((stored as { body?: unknown })?.body)) } };
  } catch (error) {
    return { state: "unreadable", reason: `The stored submission is not a readable host.run.submission record: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Write one run's durable submission; values are redacted, only env key names are kept. */
export function writeStoredSubmission(stateDir: string, stored: StoredSubmission): void {
  writeVerifiedOwnedFile(stateDir, submissionParts(stored.runId),
    JSON.stringify(redactHostRunData({ format: HOST_RUN_SUBMISSION_FORMAT, version: 1, stored })), 0o600);
}

/** Every run directory the endpoint could reattach, or none when the runs directory is not readable. */
export function listSubmissionRunIds(stateDir: string): string[] {
  try {
    const root = realpathSync(stateDir);
    return readdirSync(join(root, "runs"), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch { return []; }
}
