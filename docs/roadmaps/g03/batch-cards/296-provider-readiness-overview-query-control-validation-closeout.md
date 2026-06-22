# 296 Provider Readiness Overview Query Control Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../078-provider-readiness-overview-query-control.md`

## Purpose

Validate Provider Readiness Overview query/control integration.

## Acceptance Criteria

- [x] Focused readiness overview control tests pass.
- [x] Server crate check passes.
- [x] Docs QA passes.
- [x] Northstar QA passes.
- [x] Doctor remains error-free.

## Validation

- `cargo test -p nucleus-server readiness_overview -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy qa:docs`
- `effigy qa:northstar`
- `effigy doctor`
