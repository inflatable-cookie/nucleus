# 536 Git Runner Control Diagnostics Refresh

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../114-git-read-only-runner-evidence-composition.md`

## Purpose

Prove control diagnostics reflect composed persisted Git runner evidence.

## Scope

- Persist composed records.
- Query Git dry-run execution diagnostics.
- Assert counts and authority flags.

## Acceptance Criteria

- [ ] Control diagnostics read composed persisted records.
- [ ] Counts match composed evidence.
- [ ] Missing state still returns empty diagnostics.
- [ ] Control remains read-only.

## Validation

- `cargo test -p nucleus-server git_runner_control_diagnostics_refresh -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
