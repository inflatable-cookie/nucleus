# 549 SCM Capture Review Readiness Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../117-scm-capture-operator-review-readiness.md`

## Purpose

Define operator review readiness records over replay-only SCM capture workflow
projections.

## Scope

- Admit completed workflows as review-ready.
- Preserve workflow refs and evidence refs.
- Exclude change-request and SCM mutation authority.

## Acceptance Criteria

- [x] Completed workflows become review-ready.
- [x] Evidence refs are retained.
- [x] Change-request authority remains false.
- [x] Raw output is absent.

## Validation

- `cargo test -p nucleus-server scm_capture_review_readiness_records -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
