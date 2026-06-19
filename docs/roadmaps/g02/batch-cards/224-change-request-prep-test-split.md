# 224 Change Request Prep Test Split

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../051-change-request-prep-module-split.md`

## Purpose

Split change-request prep tests by behavior.

## Scope

- Separate GitHub descriptor, Convergence-like publication, candidate
  admission, and evidence package tests.
- Keep provider execution absent.

## Acceptance Criteria

- Tests remain readable and equivalent.
- No network or forge behavior is introduced.

## Validation

- `cargo test -p nucleus-engine change_request`
- `cargo check --workspace`

## Stop Conditions

- Stop if tests need broader behavior changes.

## Result

Change-request prep tests moved into `change_request_prep/tests.rs` and still
cover GitHub, Convergence-like publication, candidates, descriptors, and
evidence packages.
