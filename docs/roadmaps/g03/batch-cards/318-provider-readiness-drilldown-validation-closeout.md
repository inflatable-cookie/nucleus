# 318 Provider Readiness Drilldown Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../084-provider-readiness-overview-drilldown-read-model.md`

## Purpose

Validate the provider readiness drilldown lane and update the runway.

## Acceptance Criteria

- [x] Focused desktop provider readiness tests pass.
- [x] Focused provider read-intent and readiness tests pass.
- [x] `desktop:check` passes.
- [x] Docs QA passes.
- [x] Northstar QA passes.
- [x] Doctor remains error-free.

## Validation

- `cargo test -p nucleus-desktop provider_readiness -- --nocapture`
- `cargo test -p nucleus-server provider_read_intent -- --nocapture`
- `cargo test -p nucleus-server provider_readiness_overview -- --nocapture`
- `effigy desktop:check`
- `effigy qa:docs`
- `effigy qa:northstar`
- `effigy doctor`
