# 480 SCM Capture Dry Run Adapter Capabilities

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../103-scm-capture-driver-dry-run-planning.md`

## Purpose

Map dry-run plan candidates through adapter capability metadata.

## Scope

- Describe adapter label and dry-run capability.
- Keep Git and non-Git details descriptive.
- Do not create executable SCM instructions.

## Acceptance Criteria

- [x] Capability records avoid Git-only core fields.
- [x] Adapter labels remain descriptive.
- [x] Unsupported adapters remain visible.
- [x] No SCM or forge effect executes.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_adapter_capabilities -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
