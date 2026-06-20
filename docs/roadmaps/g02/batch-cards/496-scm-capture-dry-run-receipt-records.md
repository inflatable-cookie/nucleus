# 496 SCM Capture Dry Run Receipt Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../106-scm-capture-dry-run-execution-gate.md`

## Purpose

Define sanitized receipt and outcome records for SCM capture dry-run execution.

## Scope

- Record accepted, completed, failed, timed-out, blocked, and repair-required
  outcomes.
- Retain refs, counts, labels, and evidence refs.
- Avoid raw diff/output retention.

## Acceptance Criteria

- [x] Receipt records preserve dry-run identity and evidence refs.
- [x] Terminal outcomes are visible.
- [x] Raw SCM output is not retained.
- [x] Capture, publish, and forge authority remain blocked.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_receipt_records -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
