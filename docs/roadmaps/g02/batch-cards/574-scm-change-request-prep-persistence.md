# 574 SCM Change Request Prep Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../122-scm-capture-change-request-preparation-control.md`

## Purpose

Persist adapter-neutral change-request preparation admission records.

## Scope

- Add persistence input and record shapes.
- Add write/read helpers with deterministic ordering.
- Block duplicate persisted ids.

## Acceptance Criteria

- [x] Preparation admissions persist by stable id.
- [x] Reads return deterministic ordering.
- [x] Duplicate persisted ids are blocked.
- [x] Raw output remains absent.

## Validation

- `cargo test -p nucleus-server scm_change_request_prep_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
