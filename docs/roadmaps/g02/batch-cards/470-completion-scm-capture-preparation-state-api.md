# 470 Completion SCM Capture Preparation State API

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../101-completion-scm-capture-preparation-persistence.md`

## Purpose

Add state persistence and read helpers for capture-preparation records.

## Scope

- Store records in a safe existing state domain.
- Read records in deterministic order.
- Keep helpers effect-free.

## Acceptance Criteria

- [x] Persist helper stores sanitized preparation records.
- [x] Read helper returns records in stable order.
- [x] Storage errors surface normally.
- [x] No SCM or forge effect executes.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_preparation_state_api -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
