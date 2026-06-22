# 327 Provider Status Check Refresh Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../086-stopped-provider-status-check-refresh.md`

## Purpose

Validate the stopped status/check refresh type/control slice and prepare the
persistence slice.

## Acceptance Criteria

- [x] Focused status/check refresh tests pass.
- [x] Provider read-intent and readiness tests still pass.
- [x] Doctor remains error-free.
- [x] Ready cards 328-332 remain valid for persistence work.

## Validation

- `cargo test -p nucleus-server status_check_refresh -- --nocapture`
- `cargo test -p nucleus-server provider_read_intent -- --nocapture`
- `cargo test -p nucleus-server provider_readiness_overview -- --nocapture`
- `effigy doctor`
