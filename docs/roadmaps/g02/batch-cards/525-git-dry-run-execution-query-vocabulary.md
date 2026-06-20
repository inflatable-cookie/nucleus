# 525 Git Dry Run Execution Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../112-git-dry-run-execution-control-integration.md`

## Purpose

Add Git dry-run execution diagnostics to the control query vocabulary.

## Scope

- Extend diagnostics query enum.
- Extend diagnostics response enum and all-snapshot shape.
- Add DTO round-trip tests.

## Acceptance Criteria

- [x] Query vocabulary includes Git dry-run execution.
- [x] Response vocabulary includes the diagnostics DTO.
- [x] All-snapshot includes the diagnostics DTO.
- [x] Existing diagnostics domains keep working.

## Validation

- `cargo test -p nucleus-server git_dry_run_execution_query_vocabulary -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
