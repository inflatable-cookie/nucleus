# 524 Git Dry Run Execution Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../112-git-dry-run-execution-control-integration.md`

## Purpose

Add a sanitized control DTO for persisted Git dry-run execution diagnostics.

## Scope

- Map diagnostics counts into a serializable DTO.
- Include read-only authority flags.
- Exclude raw Git output and raw diff material.

## Acceptance Criteria

- [x] DTO serializes execution counts.
- [x] DTO carries authority flags as false.
- [x] DTO exposes no raw output field.
- [x] DTO has focused serialization coverage.

## Validation

- `cargo test -p nucleus-server git_dry_run_execution_control_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
