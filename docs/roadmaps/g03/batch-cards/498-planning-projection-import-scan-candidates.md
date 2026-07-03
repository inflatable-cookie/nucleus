# 498 Planning Projection Import Scan Candidates

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../117-planning-projection-import-admission.md`

## Purpose

Model read-only projected-file scan candidates for planning artifacts and task
seeds.

## Work

- [x] Add candidate records for supported planning projection file refs.
- [x] Represent unsupported schema, unsafe path, unsupported kind, and parse
  failure as blocked candidate states.
- [x] Preserve deterministic refs and sanitized evidence only.

## Acceptance Criteria

- [x] Candidate records can classify ready and blocked projected files.
- [x] Candidate records do not apply planning state or create tasks.
- [x] Tests cover ready, unsupported, unsafe, and parse-failure paths.

## Evidence

- `cargo test -p nucleus-server planning_projection_import_scan`
- `cargo check -p nucleus-server`
