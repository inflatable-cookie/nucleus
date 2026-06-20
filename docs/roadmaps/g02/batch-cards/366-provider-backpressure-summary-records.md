# 366 Provider Backpressure Summary Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../080-provider-runtime-hardening.md`

## Purpose

Summarize high-volume provider streams without retaining raw stream material.

## Scope

- Track frame counts, byte counts, dropped/compacted ranges, lag, and pressure
  state.
- Produce evidence refs for retained artifacts if policy allows them.
- Keep summaries bounded.

## Acceptance Criteria

- [x] High-volume stream pressure is visible.
- [x] Summaries remain bounded.
- [x] Raw streams are not retained by default.
- [x] Backpressure states feed diagnostics.

## Validation

- `cargo test -p nucleus-server provider_backpressure_summary -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
