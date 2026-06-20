# 495 SCM Capture Dry Run Adapter Execution Capability

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../106-scm-capture-dry-run-execution-gate.md`

## Purpose

Map dry-run execution admissions through adapter execution capability metadata.

## Scope

- Describe adapter availability and dry-run execution support.
- Keep Git and non-Git details descriptive.
- Do not build concrete driver commands yet.

## Acceptance Criteria

- [x] Capability records separate dry-run execution from capture/publish.
- [x] Adapter labels remain descriptive.
- [x] Unsupported adapters remain visible.
- [x] No forge or provider effect executes.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_adapter_execution_capability -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
