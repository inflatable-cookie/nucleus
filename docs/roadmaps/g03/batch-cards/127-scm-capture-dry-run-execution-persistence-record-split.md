# 127 SCM Capture Dry Run Execution Persistence Record Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../038-scm-capture-dry-run-execution-persistence-split.md`

## Purpose

Move SCM capture dry-run execution persistence record/model support into
focused submodules.

## Acceptance Criteria

- [x] Record/model support code moves out of the persistence front door.
- [x] Public type names and persistence behavior remain unchanged.
- [x] No provider write, process spawn, SCM mutation, remote transport, UI, or
  task behavior is added.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_execution_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
