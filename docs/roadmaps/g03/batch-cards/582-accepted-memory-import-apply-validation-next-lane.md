# 582 Accepted Memory Import Apply Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../132-accepted-memory-import-apply-admission.md`

## Purpose

Validate stopped accepted-memory import apply/admission and select the next
bounded lane.

## Work

- [x] Run focused memory/server/CLI tests.
- [x] Run docs QA, Northstar QA, diff check, doctor, and relevant cargo check.
- [x] Decide whether the next lane is active accepted-memory apply, SCM
  capture/share, review controls, search planning, product consumption, or a
  planning rebaseline.

## Acceptance Criteria

- [x] Validation passes or failures are documented.
- [x] The next lane remains effect-gated.
- [x] Active accepted-memory mutation, projection writes, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, and
  final UI behavior remain out of scope unless explicitly selected.

## Validation

Passed:

- `cargo test -p nucleus-server accepted_memory_projection_import_apply -- --nocapture`
- `cargo test -p nucleus-server control_envelope_dto -- --nocapture`
- `cargo test -p nucleusd accepted_memory_projection_import_apply -- --nocapture`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `effigy server:query:accepted-memory-projection-import-apply`
- `effigy qa:docs`
- `effigy qa:northstar`
- `cargo fmt --check`
- `git diff --check`
- `effigy doctor`

Doctor remains warning-only for existing god-file pressure.

## Lane Decision

The next lane is accepted-memory review and product-consumption readiness.

Reason:

- accepted-memory creation, projection, import validation, and stopped apply
  admission now exist as separate read-side surfaces
- active accepted-memory mutation is still too early without a review/product
  model that can explain what is ready, blocked, duplicated, or waiting for
  approval
- SCM share, embeddings/search, provider-native memory sync, automatic
  extraction, task mutation, and final UI remain separate authority lanes
