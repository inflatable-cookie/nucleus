# 326 Provider Recovery Execution Receipt Linkage

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../072-codex-provider-recovery-execution-gate.md`

## Purpose

Link admitted Codex recovery write attempts to sanitized live executor outcomes
and runtime receipts.

## Scope

- Map completed, failed, timed-out, blocked, accepted, cleanup-required, and
  replacement-thread-observed outcomes into recovery runtime progress.
- Preserve receipt refs and evidence refs without raw payloads.
- Keep task completion, review acceptance, replacement-thread promotion,
  callback answering, interruption, and SCM mutation out of linkage.

## Acceptance Criteria

- [x] Completed recovery writes become inspectable runtime progress.
- [x] Failure and cleanup states remain inspectable.
- [x] Replacement-thread observations require later explicit repair/promotion.
- [x] Linkage records do not mutate tasks or provider state.

## Validation

- `cargo test -p nucleus-server recovery_execution_receipt_linkage -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
