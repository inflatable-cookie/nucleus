# 062 Server Module Export Pressure Review

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../016-g03-health-validation-rebaseline.md`

## Purpose

Inspect server module/export pressure after the G03 record tranche.

## Acceptance Criteria

- [x] New G03 modules are counted and grouped.
- [x] `lib.rs` front-door pressure is recorded.
- [x] Existing god-file scan state is noted without blocking the lane.
- [x] No implementation behavior is added.

## Validation

- `rg -n "provider_adapter_neutral|provider_convergence" crates/nucleus-server/src/lib.rs`
- `effigy doctor`
- `git diff --check`
