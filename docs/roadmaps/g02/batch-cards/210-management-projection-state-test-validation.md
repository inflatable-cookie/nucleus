# 210 Management Projection State Test Validation

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../046-management-projection-state-test-split.md`

## Purpose

Validate the management projection state test split.

## Scope

- Run scoped server tests.
- Check god-file report for the touched file.
- Advance to SCM work-session split.

## Acceptance Criteria

- Scoped tests pass.
- The original test file is no longer an error finding.

## Validation

- `cargo test -p nucleus-server management_projection_state`
- `effigy doctor`
- `git diff --check`

## Stop Conditions

- Stop if behavior changed or the split failed to reduce file pressure.
