# 494 Planning Capture Publication CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../116-planning-projection-capture-publication-gate.md`

## Purpose

Expose a read-only `nucleusd` and Effigy inspection route for planning capture
publication readiness if the server query surface exists.

## Work

- [x] Add CLI query output only after a server query exists.
- [x] Add an Effigy selector only if it improves root-level inspection.
- [x] Print counts, statuses, adapter-family buckets, blocker summaries, and
  no-effect flags.
- [x] Avoid payload dumps.

## Acceptance Criteria

- [x] The route is read-only.
- [x] The route works from repo root through Effigy.
- [x] It does not execute SCM, forge, provider, import, promotion, or UI
  behavior.

## Evidence

- `nucleusd query planning-capture-publication-diagnostics --project <project-id>`
- `effigy server:query:planning-capture-publication-diagnostics`
- `cargo test -p nucleus-server planning_capture_publication`
- `cargo test -p nucleusd planning_capture_publication`
