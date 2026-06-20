# 575 SCM Change Request Prep Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../122-scm-capture-change-request-preparation-control.md`

## Purpose

Serialize change-request preparation diagnostics into the read-only control API.

## Scope

- Add a sanitized DTO for preparation diagnostics.
- Preserve admitted, blocked, repair-required, and blocker counts.
- Preserve authority flags as false.

## Acceptance Criteria

- [x] DTO serialization preserves preparation counts.
- [x] DTO serialization preserves blocker counts.
- [x] DTO flags keep SCM and forge authority false.
- [x] Raw output remains absent.

## Validation

- `cargo test -p nucleus-server scm_change_request_prep_control_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
