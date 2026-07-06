# 005 Product Workflow Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../001-product-workflow-rebaseline-and-vertical-slice.md`

## Purpose

Validate the first g04 product workflow slice and choose the next product
lane.

## Work

- [x] Run focused read-model, DTO, CLI, Effigy, and desktop proof checks as
  applicable.
- [x] Run docs QA, Northstar QA, format/diff checks, package checks, and
  doctor.
- [x] Decide whether the next lane is task-backed agent loop hardening, SCM
  handoff UX, planning/research UX, memory review UX, or client workflow
  composition.

## Acceptance Criteria

- [x] Validation passes or failures are documented.
- [x] The next lane remains product-shaped.
- [x] Deferred subsystem lanes remain out of the active queue unless the
  workflow proves they are needed.

## Validation

Passed:

- `cargo fmt --all --check`
- `cargo test -p nucleus-server product_workflow -- --nocapture`
- `cargo test -p nucleusd product_workflow -- --nocapture`
- `cargo test -p nucleusd planning_product -- --nocapture`
- `cargo test -p nucleus-desktop product_workflow -- --nocapture`
- `cargo test -p nucleus-desktop panel_guards -- --nocapture`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `cargo check -p nucleus-desktop`
- `effigy server:query:product-workflow-summary`
- `effigy desktop:check`
- `effigy desktop:build`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `effigy doctor`

`effigy doctor` is warning-only. The remaining warnings are existing god-file
findings.

## Decision

Continue g04 with product workflow source composition.

The first slice is useful, but its own inspection output shows broad gaps for
planning, context, runtime, review, SCM readiness, and next action when
existing read-only records should be summarized. The next lane should compose
those existing records into the product workflow summary before moving into
task-backed agent loops, SCM handoff UX, memory apply, or final UI work.
