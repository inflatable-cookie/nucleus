# 177 Management Capture Receipt Linkage

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../039-scm-management-capture-and-share-foundation.md`

## Purpose

Link capture preparation to the evidence produced by management projection
apply/review.

## Scope

- Link capture prep records to projection file refs.
- Link capture prep records to apply receipts and review summaries.
- Record blocked/skipped states when required evidence is missing.
- Keep raw validation output and provider runtime state out of committable
  projection files.

## Acceptance Criteria

- Capture prep can name the applied projection evidence it is preparing to
  share.
- Missing or unsafe evidence blocks capture preparation without mutating state.
- Tests prove evidence linkage and blocked-state behavior.

## Validation

- Targeted Rust tests for capture evidence linkage.
- `cargo check --workspace`

## Stop Conditions

- Stop if capture prep can proceed without traceable projection or apply
  evidence.
