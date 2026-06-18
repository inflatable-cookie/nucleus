# 172 Management Projection Apply Receipts And Audit

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../038-management-sync-apply-and-review.md`

## Purpose

Record sanitized evidence for management projection apply decisions.

## Scope

- Add apply receipt records for accepted, blocked, skipped, and
  review-required records.
- Link receipts to project/task ids, staged file refs, validation reports, and
  conflict refs.
- Keep raw file payloads, secrets, provider transcripts, and high-volume output
  out of receipts.

## Acceptance Criteria

- Apply outcomes can be audited after restart or client reconnection.
- Receipts do not depend on Git-specific ids.
- Receipt summaries are safe for client display.

## Validation

- `cargo test -p nucleus-engine management_sync`
- `cargo test -p nucleus-server management_projection`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if receipt retention policy would require storing raw projection file
  payloads by default.

## Result

- Apply reports now include sanitized runtime receipts for accepted, blocked,
  review-required, and skipped records.
- Receipts are persisted through the existing runtime-effects store so they can
  be read after restart or client reconnection.
- Receipt evidence refs cite record ids, projection file refs, revision refs,
  block kinds, and conflict refs without copying raw projection payloads.
- Blocked apply records and applied records carry receipt ids for later review
  surfaces.
