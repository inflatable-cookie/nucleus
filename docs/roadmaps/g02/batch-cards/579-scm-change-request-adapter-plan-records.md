# 579 SCM Change Request Adapter Plan Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../123-scm-change-request-adapter-plan-selection.md`

## Purpose

Define adapter-specific change-request plan records from persisted
adapter-neutral preparation admissions.

Resumed after roadmap 124 reduced the active-lane god-file pressure in
request-handler, control DTO, and SCM preparation surfaces.

## Scope

- Preserve persisted preparation ids and workflow refs.
- Add adapter label and plan kind.
- Keep execution authority absent.

## Acceptance Criteria

- [x] Plan records reference preparation admissions by id.
- [x] Plan kind is explicit.
- [x] Unsupported adapters stay visible.
- [x] No execution authority is granted.

## Validation

- [x] `cargo test -p nucleus-server scm_change_request_adapter_plan_records -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
