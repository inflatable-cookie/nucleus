# 147 Codex Task Error Retry Classification

Status: planned
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

- Error classes are distinct and testable.
- Retry eligibility is metadata only.
- Recovery-required states are visible.

## Validation

- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if retry execution is needed to prove classification.
