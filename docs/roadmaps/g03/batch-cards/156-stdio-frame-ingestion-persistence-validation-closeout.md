# 156 Stdio Frame Ingestion Persistence Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../047-stdio-frame-ingestion-persistence-split.md`

## Purpose

Validate the stdio frame ingestion persistence split and refresh health
evidence.

## Acceptance Criteria

- [x] Focused tests pass.
- [x] `cargo check -p nucleus-server` passes.
- [x] Doctor status is refreshed or remaining blockers are recorded.
- [x] Roadmap front doors select the next bounded lane.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server stdio_frame_ingestion_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `effigy doctor`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
