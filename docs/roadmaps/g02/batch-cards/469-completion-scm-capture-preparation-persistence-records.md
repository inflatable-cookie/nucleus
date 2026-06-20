# 469 Completion SCM Capture Preparation Persistence Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../101-completion-scm-capture-preparation-persistence.md`

## Purpose

Define sanitized persistence records for completion SCM capture-preparation
plan items.

## Scope

- Persist preparation id, admission/candidate/task refs, adapter/workflow
  labels, status, blockers, and evidence refs.
- Exclude raw material and executable SCM instructions.

## Acceptance Criteria

- [x] Persistence record carries refs, labels, status, and blockers.
- [x] Raw material is not retained.
- [x] SCM/forge/provider authority remains false.
- [x] Record is serializable.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_preparation_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
