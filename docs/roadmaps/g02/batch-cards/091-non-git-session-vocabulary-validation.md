# 091 Non-Git Session Vocabulary Validation

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../022-scm-working-session-runtime.md`

## Purpose

Keep snapshot, publication, gate, bundle, promotion, and release vocabulary
first-class.

## Scope

- Add or refine tests for Convergence-style session surfaces.
- Confirm no core record assumes commit/branch/pull-request terminology.
- Keep provider-specific labels in adapter descriptors.

## Acceptance Criteria

- Non-Git session records remain viable.
- Commit and branch are not required fields in neutral command records.
- Publication/gate vocabulary can flow to change-request prep.

## Validation

- `cargo test -p nucleus-scm-forge convergence`
- `cargo test -p nucleus-engine change_request`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if neutral records require Git-only terms.
