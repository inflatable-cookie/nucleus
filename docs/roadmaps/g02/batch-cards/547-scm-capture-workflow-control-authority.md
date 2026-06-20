# 547 SCM Capture Workflow Control Authority

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../116-scm-capture-workflow-control-integration.md`

## Purpose

Prove SCM capture workflow control integration remains read-only.

## Scope

- Assert control responses expose no checkout, branch, commit, push, forge,
  provider, callback, interruption, recovery, or raw-output authority.
- Keep diagnostics derived from state.

## Acceptance Criteria

- [x] Control diagnostics are read-only.
- [x] External effect flags remain false.
- [x] Raw output remains unavailable.
- [x] Persisted state is not mutated by diagnostics queries.

## Validation

- `cargo test -p nucleus-server scm_capture_workflow_control_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
