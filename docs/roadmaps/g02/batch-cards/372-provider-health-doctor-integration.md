# 372 Provider Health Doctor Integration

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../081-provider-observability-diagnostics.md`

## Purpose

Connect provider runtime health summaries to Effigy/doctor-facing evidence
where appropriate.

## Scope

- Summarize provider runtime repair, retention, and backpressure states.
- Keep Effigy integration read-only.
- Do not add release or CI mutations.

## Acceptance Criteria

- [ ] Provider health summaries can be generated from diagnostics records.
- [ ] Summaries are reference-only and sanitized.
- [ ] Effigy/doctor integration does not execute provider effects.
- [ ] Existing doctor god-file blocker remains separate.

## Validation

- `cargo test -p nucleus-server provider_health_summary -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `git diff --check`
