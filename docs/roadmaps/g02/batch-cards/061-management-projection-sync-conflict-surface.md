# 061 Management Projection Sync Conflict Surface

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../016-management-projection-file-io-and-sync.md`

## Purpose

Surface schema, semantic, and SCM sync conflicts separately for operator or
steward resolution.

## Scope

- Add conflict summary records for projection sync.
- Separate schema conflicts, semantic conflicts, and SCM/worktree conflicts.
- Preserve unsupported projection records for later handling.
- Keep automated resolution and SCM push/pull out of scope.

## Acceptance Criteria

- [x] Conflict reports distinguish schema, semantic, unsupported, and SCM
  classes.
- [x] Reports are deterministic for the same staged inputs.
- [x] Steward/operator resolution can consume the report later without raw runtime
  data.

## Outcome

- Extended management projection conflict reports with unsupported and SCM
  conflict classes.
- Kept schema, semantic, unsupported, and SCM conflicts distinct.
- Avoided resolution, SCM push/pull, and raw runtime data.

## Validation

- [x] `cargo test -p nucleus-engine management_projection`
- [x] `cargo test -p nucleus-server management_projection`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if resolving conflicts requires SCM adapter behavior from milestone
  `017`.
