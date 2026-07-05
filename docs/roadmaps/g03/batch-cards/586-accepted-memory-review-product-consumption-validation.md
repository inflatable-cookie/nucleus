# 586 Accepted Memory Review Product Consumption Validation

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../133-accepted-memory-review-product-consumption-readiness.md`

## Purpose

Validate accepted-memory review/product-consumption readiness and choose the
next bounded lane.

## Work

- [x] Run focused accepted-memory review readiness tests.
- [x] Run relevant package checks, docs QA, Northstar QA, diff check, doctor,
  and format check.
- [x] Decide whether the next lane is active accepted-memory apply, SCM
  capture/share, review controls, search planning, provider sync planning,
  automatic extraction planning, or a broader planning rebaseline.

## Acceptance Criteria

- [x] Validation passes or failures are documented.
- [x] The next lane remains effect-gated.
- [x] Active accepted-memory mutation, projection writes, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, and
  final UI behavior remain out of scope unless explicitly selected.

## Validation

Passed:

- `cargo test -p nucleus-server accepted_memory_review_readiness -- --nocapture`
- `cargo test -p nucleus-server control_envelope_dto -- --nocapture`
- `cargo test -p nucleusd accepted_memory_review -- --nocapture`
- `cargo test -p nucleusd cli_config_parses_accepted_memory_review_readiness_query_domain -- --nocapture`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `effigy server:query:accepted-memory-review-readiness`
- `effigy qa:docs`
- `effigy qa:northstar`
- `cargo fmt --check`
- `git diff --check`
- `effigy doctor`

The first `cargo fmt --check` found only re-export wrapping. `cargo fmt` was
applied before closeout, then `cargo fmt --check` passed. Doctor is
warning-only at the prior 182 god-file warning baseline with 0 errors.

## Lane Decision

The next lane is accepted-memory import-apply review commands.

Reason:

- review readiness now explains which accepted-memory import/apply records are
  ready, blocked, duplicate, conflicted, or approval-required
- active apply still needs explicit operator approval refs
- a review command lane can create approved, deferred, or rejected review
  receipts without mutating accepted memory
- active accepted-memory apply, projection writes, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, and
  final UI remain deferred
