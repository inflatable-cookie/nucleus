# 539 SCM Capture Workflow Projection Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../115-scm-capture-workflow-composition.md`

## Purpose

Define replay-only SCM capture workflow projection records over the existing
completion, dry-run, Git runner, evidence, and persistence surfaces.

## Scope

- Link records by stable ids and evidence refs.
- Track workflow id, task id, work item id, completion id, repo id, adapter
  label, and stage refs.
- Do not create new execution authority.

## Acceptance Criteria

- [x] Projection records link existing surfaces by refs.
- [x] Missing refs are visible.
- [x] Raw output is not represented.
- [x] Records grant no mutation authority.

## Validation

- `cargo test -p nucleus-server scm_capture_workflow_projection_records -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
