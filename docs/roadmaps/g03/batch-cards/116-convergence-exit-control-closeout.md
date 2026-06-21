# 116 Convergence Exit Control Closeout

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../034-convergence-exit-and-next-lane-selection.md`

## Purpose

Close the Convergence stopped proof lane after receipt control validation.

## Acceptance Criteria

- [x] Gap index reflects the closed Convergence proof state.
- [x] Roadmap front doors point away from Convergence feature work.
- [x] Convergence remains reopenable by explicit operator instruction only.
- [x] No Convergence backend effect is enabled.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
