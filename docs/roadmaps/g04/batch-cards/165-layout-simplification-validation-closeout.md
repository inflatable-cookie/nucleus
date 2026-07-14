# 165 Layout Simplification Validation Closeout

Status: completed
Owner: Codex
Updated: 2026-07-13
Milestone: `../031-window-region-panel-simplification.md`
Auto-start next card: no

## Objective

Prove the flattened hierarchy preserves the working product workflow and close
the lane honestly.

## Governing Refs

- `../031-window-region-panel-simplification.md`
- `../../../specs/archive/008-window-region-panel-simplification.md`

## Scope

1. Run desktop checks/build and focused Rust tests.
2. Run docs, formatting, and diff hygiene.
3. Record evidence and remaining limits.
4. Close cards, roadmap, spec, and active pointers.

## Acceptance Criteria

- existing Agent Chat, Tasks, Editor, and Diff panels still compile in place
- config and workspace model tests pass
- docs and code posture are coherent
- next product lane returns to explicit operator selection

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- focused Rust tests
- `effigy qa:docs`
- `cargo fmt --all -- --check`
- `git diff --check`

## Evidence

- validation output
- dated implementation log

## Stop Conditions

- any regression in the existing product panel path

## Next

Stop for operator review.

## Outcome

- Four isolated workspace UI config tests pass, including schema-v1 migration.
- Fifteen `nucleus-workspaces` tests pass.
- Rust workspace check, desktop check/build, docs QA, formatting, and diff
  hygiene pass.
- Collaborative preview navigation succeeded but preview snapshot capture was
  unavailable. Live visual inspection remains the operator checkpoint.
