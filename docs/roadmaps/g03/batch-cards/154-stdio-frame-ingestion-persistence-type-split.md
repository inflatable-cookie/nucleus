# 154 Stdio Frame Ingestion Persistence Type Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../047-stdio-frame-ingestion-persistence-split.md`

## Purpose

Move stdio frame ingestion persistence type/support code out of the front door.

## Acceptance Criteria

- [x] Type/support code moves only where it reduces real front-door pressure.
- [x] Public type names and persistence behavior remain unchanged.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server stdio_frame_ingestion_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
