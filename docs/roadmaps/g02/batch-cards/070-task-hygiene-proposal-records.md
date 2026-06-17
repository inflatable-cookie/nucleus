# 070 Task Hygiene Proposal Records

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../018-steward-native-harness-and-effigy-tools.md`

## Purpose

Let the steward propose task and project-organization changes without mutating
state silently.

## Scope

- Add proposal records for task metadata normalization, duplicate detection,
  blocked/stale task flags, readiness hints, and documentation index updates.
- Require review or approval before projected task state changes.
- Link proposals to evidence refs.
- Do not implement proposal application.

## Acceptance Criteria

- [x] Steward proposals are distinct from applied task mutations.
- [x] Semantic changes require human approval.
- [x] Proposal records can cite Effigy, SCM, validation, and task evidence refs.

## Outcome

- Added native steward proposal records for task hygiene, docs index, and
  project-organization recommendations.
- Kept proposals separate from task command mutation and task history.
- Added proposal evidence refs for Effigy, SCM, validation, task, docs, and
  runtime receipt sources.

## Validation

- [x] `cargo test -p nucleus-native-harness steward`
- [x] `cargo test -p nucleus-engine task`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if proposal records would mutate task activity, assignment, or
  acceptance state directly.
