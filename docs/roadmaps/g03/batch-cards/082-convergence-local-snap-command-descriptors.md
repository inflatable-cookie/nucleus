# 082 Convergence Local Snap Command Descriptors

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../023-convergence-local-snap-command-boundary.md`

## Purpose

Describe stopped local snap command intent from admitted Convergence local snap
records.

## Acceptance Criteria

- [x] Admitted local snap records can produce descriptors.
- [x] Blocked, duplicate, and unsupported admissions are skipped.
- [x] Descriptors preserve replay, admission, task, repo, and authority refs.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_command_descriptors -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
