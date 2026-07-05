# 574 Accepted Memory Projection Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../130-accepted-memory-projection-file-materialization.md`

## Purpose

Validate accepted-memory projection file materialization and choose the next
memory lane.

## Work

- [x] Run focused memory/server/CLI tests.
- [x] Run docs QA, Northstar QA, diff check, doctor, and relevant cargo check.
- [x] Decide whether the next lane is projection import validation, SCM
  capture/share, review controls, search planning, product consumption, or a
  planning rebaseline.

## Acceptance Criteria

- [x] Validation passes or failures are documented.
- [x] The next lane remains effect-gated.
- [x] No embeddings/search/provider sync, automatic extraction, task mutation,
  SCM/forge mutation, or final UI behavior is added without a selected lane.

## Result

Focused server, DTO, `nucleusd`, cargo check, Effigy selector, docs QA,
Northstar QA, diff check, and doctor validation passed. Doctor remains
warning-only for existing god-file findings.

The selected next lane is accepted-memory projection import validation. It
should scan and validate projected `nucleus/memory/*.toml` files before any
active apply, SCM capture/share, embeddings/search, provider sync, automatic
extraction, task mutation, or final UI behavior.
