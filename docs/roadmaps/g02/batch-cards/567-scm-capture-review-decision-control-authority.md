# 567 SCM Capture Review Decision Control Authority

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../120-scm-capture-review-decision-control-integration.md`

## Purpose

Prove SCM capture review-decision control remains read-only.

## Scope

- Assert no change-request preparation is created.
- Assert no SCM, forge, provider, callback, interruption, or recovery authority
  is granted.
- Assert raw output is not retained.

## Acceptance Criteria

- [x] Change-request authority remains false.
- [x] SCM/forge/provider/callback/recovery authority remains false.
- [x] Raw output remains absent.
- [x] Querying diagnostics does not mutate persisted decisions.

## Validation

- `cargo test -p nucleus-server scm_capture_review_decision_control_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
