# 590 Accepted Memory Import Apply Review Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../134-accepted-memory-import-apply-review-commands.md`

## Purpose

Validate accepted-memory import-apply review commands and choose the next
bounded lane.

## Work

- [x] Run focused review command and diagnostics tests.
- [x] Run relevant package checks, docs QA, Northstar QA, diff check, doctor,
  and format check.
- [x] Decide whether the next lane is active accepted-memory apply, SCM share,
  search planning, provider sync planning, automatic extraction planning, final
  UI planning, or a broader rebaseline.

## Acceptance Criteria

- [x] Validation passes or failures are documented.
- [x] The next lane remains effect-gated.
- [x] Active accepted-memory mutation, projection writes, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, and final UI behavior remain out of scope unless explicitly
  selected.

## Validation

Passed:

- `cargo test -p nucleus-server accepted_memory_import_apply_review -- --nocapture`
- `cargo test -p nucleusd accepted_memory_import_apply_review -- --nocapture`
- `cargo check -p nucleus-server -p nucleusd`
- `cargo check --workspace`
- `effigy server:query:accepted-memory-import-apply-review-diagnostics`
- `effigy qa:docs`
- `effigy qa:northstar`
- `cargo fmt --check`
- `git diff --check`
- `effigy doctor`

Doctor is warning-only with god-file findings and 0 errors.

## Lane Decision

The next lane is accepted-memory review receipt persistence and active-apply
admission.

Reason:

- active accepted-memory apply now has candidate/import/apply admission,
  readiness, review-command, and diagnostics surfaces
- the current review diagnostics synthesize receipts but do not persist
  operator decisions
- active mutation is still too early until approved/deferred/rejected review
  receipts are durable and an active-apply admission gate can prove exact
  authority from those receipts
- SCM share, embeddings/search, provider-native memory sync, automatic
  extraction, task mutation, agent scheduling, and final UI remain separate
  authority lanes
