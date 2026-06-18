# 147 Codex Task Error Retry Classification

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../033-codex-task-event-ingestion-and-receipts.md`

## Purpose

Classify Codex task errors for retry, recovery, or terminal failure.

## Scope

- Add classification vocabulary.
- Preserve evidence refs and summaries.
- Do not implement retry execution.

## Acceptance Criteria

- [x] Error classes are distinct and testable.
- [x] Retry eligibility is metadata only.
- [x] Recovery-required states are visible.

## Result

Added error classification for unsupported observations, provider runtime
errors, permission denial, recovery-required, and unknown states. Retry remains
metadata only.

## Validation

- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if retry execution is needed to prove classification.
