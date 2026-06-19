# 288 Codex Turn Start Live Send Receipts

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../064-codex-live-provider-send-readiness.md`

## Purpose

Map Codex turn-start live-send attempts into runtime receipts and events.

## Scope

- Connect turn-start send command/write attempt records to runtime receipts.
- Connect write attempt records to runtime observation events.
- Preserve request, envelope, and provider command identity.
- Do not mutate task state.

## Acceptance Criteria

- [x] Turn-start live-send attempts can be inspected through receipt/event records.
- [x] Failed or blocked sends are represented without retry execution.
- [x] Task mutation remains blocked.

## Validation

- targeted Codex/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if receipt/event linkage exposes missing write identity rules.
