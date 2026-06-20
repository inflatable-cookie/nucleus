# 465 Completion SCM Capture Adapter Neutral Plan

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../100-completion-scm-capture-preparation-records.md`

## Purpose

Attach adapter-neutral execution-plan metadata to capture-preparation
candidates.

## Scope

- Describe adapter label and workflow label.
- Keep Git and non-Git terms in labels only.
- Do not create executable SCM instructions.

## Acceptance Criteria

- [x] Metadata avoids Git-only core fields.
- [x] Adapter labels remain descriptive.
- [x] Unsupported adapters remain visible.
- [x] No SCM or forge effect executes.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_adapter_neutral_plan -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
