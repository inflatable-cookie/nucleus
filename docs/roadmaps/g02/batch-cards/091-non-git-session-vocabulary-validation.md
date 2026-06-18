# 091 Non-Git Session Vocabulary Validation

Status: completed
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

- [x] Non-Git session records remain viable.
- [x] Commit and branch are not required fields in neutral command records.
- [x] Publication/gate vocabulary can flow to change-request prep.

## Outcome

- Added Convergence-style command/admission coverage for snapshot,
  publication, and gate vocabulary.
- Preserved non-Git change-request prep viability.

## Validation

- [x] `cargo test -p nucleus-scm-forge convergence`
- [x] `cargo test -p nucleus-engine change_request`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if neutral records require Git-only terms.
