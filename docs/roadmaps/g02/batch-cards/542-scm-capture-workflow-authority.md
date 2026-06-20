# 542 SCM Capture Workflow Authority

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../115-scm-capture-workflow-composition.md`

## Purpose

Prove SCM capture workflow composition grants no mutation or external-effect
authority.

## Scope

- Assert checkout, branch, commit, push, forge, provider, callback,
  interruption, recovery, and raw-output flags remain false.
- Keep workflow projection replay-only.

## Acceptance Criteria

- [x] Mutating Git authority remains blocked.
- [x] Forge/provider/callback/recovery authority remains blocked.
- [x] Raw output remains absent.
- [x] Workflow projection is replay-only.

## Validation

- `cargo test -p nucleus-server scm_capture_workflow_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
