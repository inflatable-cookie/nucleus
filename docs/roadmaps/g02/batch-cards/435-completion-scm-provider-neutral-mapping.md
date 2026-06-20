# 435 Completion SCM Provider Neutral Mapping

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../094-completion-to-scm-change-request-readiness.md`

## Purpose

Map completion promotion candidates to provider-neutral SCM readiness records.

## Scope

- Avoid Git-only commit/branch/worktree assumptions.
- Allow Git-like and Convergence-like labels to remain adapter-level metadata.
- Preserve evidence refs.

## Acceptance Criteria

- [x] Core records avoid Git-only terms.
- [x] Adapter labels can describe Git-like and Convergence-like paths.
- [x] Missing adapter capability surfaces as unsupported/repair state.
- [x] No SCM or forge effects execute.

## Validation

- `cargo test -p nucleus-server completion_scm_provider_neutral_mapping -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
