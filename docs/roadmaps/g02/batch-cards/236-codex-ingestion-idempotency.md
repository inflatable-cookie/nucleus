# 236 Codex Ingestion Idempotency

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../054-codex-live-event-acceptance.md`

## Purpose

Define and implement duplicate-safe acceptance for decoded Codex observations.

## Scope

- Add frame/event idempotency keys from adapter instance, provider refs,
  transport sequence, provider method, and payload-stable ids where available.
- Record duplicate, out-of-order, unsupported, and recovery-required outcomes.
- Keep raw payload handling metadata-only or evidence-ref-only.
- Do not implement live stdio decoding.

## Acceptance Criteria

- Duplicate observations do not produce duplicate accepted events.
- Unsupported observations remain visible.
- Out-of-order or uncertain observations require recovery instead of silent
  success.

## Validation

- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if idempotency needs raw payload retention by default.
