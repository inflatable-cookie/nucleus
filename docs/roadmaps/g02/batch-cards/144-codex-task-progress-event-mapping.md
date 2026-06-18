# 144 Codex Task Progress Event Mapping

Status: planned
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

- Supported observations update work-unit progress.
- Unsupported observations remain inspectable.
- Raw provider payloads stay out of storage.

## Validation

- `cargo test -p nucleus-server codex_live`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if event mapping needs raw provider payload retention.
