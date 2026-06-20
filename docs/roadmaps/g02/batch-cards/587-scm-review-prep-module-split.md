# 587 SCM Review Prep Module Split

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../124-health-and-runway-rebaseline.md`

## Purpose

Reduce or explicitly defer the largest new SCM review/preparation module
pressure before adapter-plan work resumes.

## Scope

- Inspect the review-decision and change-request-prep modules that crossed
  warning or error thresholds.
- Split domain types, persistence helpers, diagnostics helpers, or tests when a
  split is mechanical and behavior-preserving.
- If a split would create churn without clarity, document the deferral in the
  implementation gap index.

## Acceptance Criteria

- [ ] The largest SCM review/prep files are split or have a recorded deferral.
- [ ] Module ownership remains clearer than before the stocktake.
- [ ] No SCM, forge, provider, callback, interruption, recovery, or raw-output
  authority is added.

## Validation

- `cargo test -p nucleus-server provider_scm -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
