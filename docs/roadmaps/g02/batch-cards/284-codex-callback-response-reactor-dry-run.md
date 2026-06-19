# 284 Codex Callback Response Reactor Dry Run

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../063-provider-command-reactor-gate.md`

## Purpose

Route Codex callback response envelopes through provider command reactor records
without sending to Codex.

## Scope

- Use existing callback response request, admission, and envelope records.
- Add dry-run reactor admission/queue/dispatch/outcome linkage.
- Preserve provider callback identity.
- Do not write to Codex stdio.

## Acceptance Criteria

- Callback response can enter reactor records after envelope creation.
- Dry-run outcome maps to receipt/event vocabulary.
- Provider callback identity remains explicit.
- Live provider send remains blocked by an explicit gate.

## Validation

- [x] targeted Codex/server tests
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if callback response routing exposes missing provider callback identity
  rules.

## Result

Added a Codex callback-response reactor dry-run bridge that consumes an
accepted callback response envelope and produces provider command admission,
queue, dispatch, and outcome records without writing to Codex stdio.

The bridge preserves provider callback identity as the reactor target and maps
dry-run outcomes to the existing provider runtime receipt/event vocabulary.
