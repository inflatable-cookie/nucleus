# 369 Provider Trace Span Records

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../081-provider-observability-diagnostics.md`

## Purpose

Define sanitized trace span records for provider runtime operations.

## Scope

- Link spans to commands, dispatch attempts, sessions, receipts, outcomes, and
  evidence refs.
- Track status, duration, component, and sanitized summary.
- Exclude raw payloads and streams.

## Acceptance Criteria

- [ ] Trace spans can represent successful and failed provider effects.
- [ ] Spans are linked to evidence refs.
- [ ] Raw provider material is not retained.
- [ ] Client authority remains false.

## Validation

- `cargo test -p nucleus-server provider_trace_span_records -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
