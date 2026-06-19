# 060 Codex Provider Interruption Gate

Status: active
Owner: Tom
Updated: 2026-06-19

## Purpose

Define provider-reaching interruption and cancellation records for Codex.

Roadmap `059` proved callback response request, admission, envelope, receipt,
and diagnostics state. This lane should add the next runtime gate: explicit
operator-authorized interruption without resume/recovery or task mutation.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add interruption request records with provider and Nucleus identity.
- [ ] Gate interruption through authority, runtime readiness, and target state.
- [ ] Map accepted interruption to sanitized provider envelope and receipts.
- [ ] Expose interruption outcomes through read-only diagnostics.
- [ ] Keep recovery/resume and task mutation out of scope.

## Non-Goals

- Do not implement provider session resume.
- Do not infer task completion, failure, or cancellation from provider
  interruption observations.
- Do not add UI controls.
- Do not retain raw provider payloads.

## Execution Plan

- [x] Request batch: add interruption request records.
- [ ] Admission batch: gate interruption policy.
- [ ] Envelope/receipt batch: map accepted interruptions to sanitized provider
      send intent and outcomes.
- [ ] Diagnostics batch: expose interruption state safely.
- [ ] Closeout batch: validate and select recovery or task-mutation as the
      next gate.

## Batch Cards

Ready cards:

- `batch-cards/267-codex-interruption-admission-policy.md`

Planned cards:

- `batch-cards/268-codex-interruption-envelope-receipts.md`
- `batch-cards/269-codex-interruption-diagnostics.md`
- `batch-cards/270-codex-interruption-closeout.md`

Completed cards:

- `batch-cards/266-codex-interruption-request-records.md`

## Acceptance Criteria

- [x] Interruption records preserve provider and Nucleus identity.
- [ ] Admission blocks unsupported, unauthorized, or stale interruption
      targets.
- [ ] Envelope and receipts are sanitized and replay-safe.
- [ ] Diagnostics expose no raw provider payloads.
- [ ] Validation passes.

## Gate

Do not resume sessions or mutate task state until provider interruption state is
explicit and tested.
