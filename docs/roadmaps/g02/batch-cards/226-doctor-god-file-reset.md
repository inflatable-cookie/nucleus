# 226 Doctor God File Reset

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../052-health-reset-validation-and-next-runtime-lane.md`

## Purpose

Run the health gate after all planned splits.

## Scope

- Run `effigy doctor`.
- Record remaining god-file findings.
- Do not fix warning files unless they became errors during the split.

## Acceptance Criteria

- No current error file remains an error, or blockers are documented.
- Warning pressure remains visible.

## Validation

- `effigy doctor`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if doctor errors remain and the cause is not mechanical.
