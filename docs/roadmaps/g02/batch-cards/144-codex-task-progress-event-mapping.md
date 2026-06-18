# 144 Codex Task Progress Event Mapping

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../033-codex-task-event-ingestion-and-receipts.md`

## Purpose

Map Codex runtime observations into task work-unit progress.

## Scope

- Convert supported Codex observations into generic progress events.
- Preserve unsupported observations explicitly.
- Avoid raw payload storage.

## Acceptance Criteria

- [x] Supported observations update work-unit progress.
- [x] Unsupported observations remain inspectable.
- [x] Raw provider payloads stay out of storage.

## Result

Added task-scoped Codex progress mapping for supported runtime events,
runtime receipts, and unsupported observations without raw payload retention.

## Validation

- `cargo test -p nucleus-server codex_live`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if event mapping needs raw provider payload retention.
