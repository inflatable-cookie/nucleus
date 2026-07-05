# 578 Accepted Memory Import Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../131-accepted-memory-projection-import-validation.md`

## Purpose

Validate accepted-memory projection import validation and select the next
memory lane.

## Work

- [x] Run focused memory/server/CLI tests.
- [x] Run docs QA, Northstar QA, diff check, doctor, and relevant cargo check.
- [x] Decide whether the next lane is active import apply, SCM capture/share,
  review controls, search planning, product consumption, or a planning
  rebaseline.

## Decision

The next lane is stopped accepted-memory import apply/admission. It is a
reviewed authority model over validated projected memory imports, not active
accepted-memory mutation.

## Validation

- `cargo fmt --check` passed.
- `cargo test -p nucleus-server accepted_memory_projection_import -- --nocapture`
  passed.
- `cargo test -p nucleusd accepted_memory_projection_import -- --nocapture`
  passed.
- `cargo test -p nucleusd accepted_memory_import_alias -- --nocapture` passed.
- `cargo check -p nucleus-server` passed.
- `cargo check -p nucleusd` passed.
- `effigy server:query:accepted-memory-projection-import` passed and reported
  no read/apply/SCM/search/provider/task/UI effects.
- `effigy qa:docs` passed.
- `effigy qa:northstar` passed.
- `git diff --check` passed.
- `effigy doctor` passed with warning-only god-file findings.

## Acceptance Criteria

- [x] Validation passes or failures are documented.
- [x] The next lane remains effect-gated.
- [x] Active memory apply, SCM/forge mutation, embeddings/search/provider sync,
  automatic extraction, task mutation, and final UI behavior remain out of
  scope unless explicitly selected.
