# 595 Git Dry Run Execution Persistence Test Split

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../124-health-and-runway-rebaseline.md`

## Purpose

Move embedded tests out of the Git dry-run execution persistence module.

## Scope

- Move the `#[cfg(test)]` module into a sibling test file.
- Keep persistence behavior and assertions unchanged.
- Do not change Git dry-run execution records.

## Acceptance Criteria

- [ ] The production module drops below the current god-file error threshold.
- [ ] Tests still run under the same module path.
- [ ] No Git command execution or raw-output behavior changes are made.

## Validation

- `cargo test -p nucleus-server provider_git_dry_run_execution_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
