# 187 Primary Tree Branch Session Plan Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../041-scm-working-session-execution-prep.md`

## Purpose

Model primary-directory temporary-branch session plans.

## Scope

- Add records for intended base ref, temporary change ref, guard checks, and
  restore expectations.
- Keep shared-directory constraints visible.
- Do not checkout or create branches.

## Acceptance Criteria

- Primary-tree session plans are represented separately from isolated worktree
  plans.
- Admission blocks unsafe dirty-state assumptions.

## Validation

- Targeted Rust tests for primary-tree session plans.
- `cargo check --workspace`

## Stop Conditions

- Stop if the plan can overwrite or hide local user work.

## Result

Primary-tree session execution prep now records clean/recoverable-state guard
checks, target review, cleanup policy, and no-provider-mutation state.
