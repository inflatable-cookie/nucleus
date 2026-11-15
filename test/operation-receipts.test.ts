import { test } from "node:test";
import assert from "node:assert/strict";
import { digest, operationIdForKey, operationInputHash } from "../core/store/store";
import { preSendReceiptProof, type ReceiptProofStore } from "../core/planning/operation-receipts";
import { DurableFenceRefusal } from "../core/intake/run-settlement";
import { ParkedRestartPreSendRefusal } from "../core/verbs/restart";
import type { OperationEffect, QueueOperation } from "../shared/operations";

/**
 * Spec 050 pre-send receipts: the one proof a refused task control records. Each
 * case names the fact that changes the answer, so the proof is never a bare
 * conjunction read as a boolean.
 */

const taskId = "task-receipt", key = "control:task-receipt";
const task = { id: taskId, version: 3, phase: "working" };
const effect: OperationEffect = { kind: "task_control", target: "restart", intentAt: "2026-01-01T00:00:00.000Z",
  status: "intent", result: null, resultAt: null };
const payload = { type: "task_control", control: { action: "restart", taskId, version: 3, reason: "synthetic" } };
const inputHash = operationInputHash(payload), operationId = operationIdForKey(key);
/** One earlier attempt that recorded its own definite execution receipt. */
const earlierAttempt = {
  receipt: { operationId, inputHash, taskId, expectedVersion: 3, attempt: 1, boundary: "pre-send-refusal-v1" as const,
    buildId: "synthetic", taskEvidenceHash: digest(JSON.stringify(task)), runEvidenceHash: digest(JSON.stringify([])),
    diagnostic: "earlier refusal", effect, recordedAt: "2026-01-01T00:00:00.000Z" },
  effect: { ...effect, status: "reconciled" as const, result: "earlier refusal", resultAt: "2026-01-01T00:00:00.000Z" },
  diagnostic: "earlier refusal", settledAt: "2026-01-01T00:00:00.000Z", reconciledAt: "2026-01-01T00:00:00.000Z",
};

function operation(extra: Partial<QueueOperation> = {}): QueueOperation {
  return {
    id: operationId, key, kind: "task_control", inputHash, state: "running",
    taskId, expectedVersion: 3, repoPath: null, submissionId: null,
    createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", settledAt: null,
    attempts: 2, diagnostic: "", result: null, effect, preSendHistory: [earlierAttempt],
    ...extra,
  } as QueueOperation;
}

function store(runs: unknown[] = []): ReceiptProofStore {
  return { task: () => task, runs: () => runs as never };
}

test("a refused attempt with nothing delivered records the typed pre-send receipt", () => {
  const proof = preSendReceiptProof({ store: store(), buildId: () => "synthetic", running: operation(), current: operation(),
    payload, effect, error: new DurableFenceRefusal("its delivery is unknown"), message: "its delivery is unknown" });
  assert.equal(proof.kind, "typed_refusal");
  assert.equal(proof.typedRefusal, true);
  assert.equal(proof.receipt?.boundary, "pre-send-refusal-v1");
  assert.equal(proof.receipt?.attempt, 2);
  assert.equal(proof.receipt?.taskEvidenceHash, digest(JSON.stringify(task)));
  assert.equal(proof.receipt?.runEvidenceHash, digest(JSON.stringify([])));
});

test("a record that moved past the attempt, or a run that already carries the delivery, proves nothing", () => {
  const fence = new DurableFenceRefusal("refused before sending");
  const facts = { store: store(), buildId: () => "synthetic", payload, effect, error: fence, message: fence.message };
  assert.equal(preSendReceiptProof({ ...facts, running: operation(), current: operation({ attempts: 3 }) }).kind, "none");
  assert.equal(preSendReceiptProof({ ...facts, running: operation(), current: operation({ state: "succeeded" }) }).kind, "none");
  assert.equal(preSendReceiptProof({ ...facts, running: operation(), current: operation(), effect: { ...effect, target: "stop" } }).kind, "none");
  assert.equal(preSendReceiptProof({ ...facts, running: operation(), current: operation(),
    store: store([{ reviewDeliveries: [{ operationId }] }]) }).kind, "none", "a delivered occurrence is never a pre-send refusal");
  assert.equal(preSendReceiptProof({ ...facts, running: operation(), current: operation(), effect: null }).kind, "none");
});

test("only a parked restart that crossed the boundary records a receipt, and only for its own evidence", () => {
  const crossed = operation({ preSendBoundaryStartedAt: "2026-01-01T00:00:01.000Z" });
  const parked = new ParkedRestartPreSendRefusal("parked step refused", digest(JSON.stringify(task)), digest(JSON.stringify([])));
  const base = { store: store(), buildId: () => "synthetic", running: crossed, current: crossed, payload, effect, message: parked.message };
  const proof = preSendReceiptProof({ ...base, error: parked });
  assert.equal(proof.kind, "parked_restart");
  assert.equal(proof.receipt?.boundary, "parked-restart-rollback-v1");
  // The same refusal whose evidence no longer describes the task proves nothing.
  const stale = new ParkedRestartPreSendRefusal("parked step refused", digest("other task"), digest(JSON.stringify([])));
  assert.equal(preSendReceiptProof({ ...base, error: stale }).kind, "none");
  // A different typed refusal across the boundary keeps the fence instead.
  assert.equal(preSendReceiptProof({ ...base, error: new DurableFenceRefusal("refused") }).kind, "none");
});
