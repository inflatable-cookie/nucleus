# 109 Git SCM Capture Dry Run Adapter Proof

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Prove the first adapter-specific SCM capture dry-run path for Git while keeping
the provider-neutral execution gate authoritative and blocking capture,
publish, forge, provider, callback, recovery, and raw-output retention.

## Governing Refs

- `docs/roadmaps/g02/106-scm-capture-dry-run-execution-gate.md`
- `docs/roadmaps/g02/107-scm-capture-dry-run-execution-persistence.md`
- `docs/roadmaps/g02/108-scm-capture-dry-run-execution-control.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define Git dry-run adapter command descriptors.
- [x] Map eligible provider-neutral dry-run execution records to Git commands.
- [x] Capture sanitized Git dry-run summaries by evidence ref.
- [x] Keep raw diff/output out of core records.
- [x] Keep commit, push, PR, merge, provider, callback, interruption, and
  recovery authority blocked.

## Execution Plan

- [x] Git dry-run command descriptor batch.
- [x] Git adapter admission mapping batch.
- [x] Git dry-run sanitized outcome batch.
- [x] Authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/509-git-dry-run-command-descriptors.md`
- `batch-cards/510-git-dry-run-adapter-admission.md`
- `batch-cards/511-git-dry-run-sanitized-outcomes.md`
- `batch-cards/512-git-dry-run-authority-regressions.md`
- `batch-cards/513-git-dry-run-adapter-proof-closeout.md`

## Acceptance Criteria

- [x] Git command descriptors remain non-mutating.
- [x] Provider-neutral dry-run execution records map to Git dry-run descriptors.
- [x] Sanitized outcomes retain refs and counts only.
- [x] Raw diff/output is not stored in core records.
- [x] Commit, push, forge, provider, callback, interruption, and recovery
  effects remain blocked.
