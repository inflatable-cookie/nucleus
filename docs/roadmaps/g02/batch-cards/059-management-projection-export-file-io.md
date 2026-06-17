# 059 Management Projection Export File IO

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../016-management-projection-file-io-and-sync.md`

## Purpose

Write minimal project/task management projection files to a repo path.

## Scope

- Add policy-gated export path records.
- Write project and task projection files through server-owned file IO.
- Avoid SCM add/commit/push behavior.
- Keep runtime/local-only state out of the exported files.

## Acceptance Criteria

- [x] One project can export management projection files to a configured
  directory.
- [x] Export paths are deterministic and scoped under the projection root.
- [x] File writes are explicit effects with sanitized summaries.
- [x] No SCM mutation occurs.

## Outcome

- Added server-owned management projection file export request/report records.
- Wrote project and task projection files under scoped `nucleus/` paths.
- Rejected absolute, parent-dir, and non-`nucleus/` file refs.
- Reported file writes without SCM mutation.

## Validation

- [x] `cargo test -p nucleus-engine management_projection`
- [x] `cargo test -p nucleus-server management_projection`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if export requires SCM workspace mutation policy before safe file IO.
