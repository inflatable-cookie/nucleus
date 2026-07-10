# Compact Task Diff Review Panel

Date: 2026-07-10
Lane: G04 task-attributed diff review
Card: 157

## Outcome

- Selected task drilldown and review-next evidence resolve the latest exact
  work-item diff. The client never substitutes a working-copy diff.
- The normal panel is one summary, one filtered changed-file popover, and one
  read-only unified patch with semantic added, deleted, header, and hunk lines.
- Coverage, truncation, attribution, and non-text patch states remain compact
  notices instead of growing a permanent secondary region.
- Open in Editor focuses or creates the existing Editor panel with the same
  opaque file ref.
- Accept and Needs changes use existing admission/apply authority with task
  revision and exact review evidence. Needs changes cannot apply without a
  reason. Neither control completes the task or mutates source.

## Evidence

- four focused state/helper tests pass
- desktop production build passes
- desktop checking reports only the 11 existing linked-Poodle diagnostics
- `git diff --check` passes

## Next

Run the full attribution, storage, recovery, interaction, and visual closeout
matrix in card 158, then stop for operator review.
