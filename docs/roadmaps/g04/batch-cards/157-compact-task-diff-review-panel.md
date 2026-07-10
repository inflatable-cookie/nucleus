# 157 Compact Task Diff Review Panel

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../029-task-attributed-diff-review.md`
Auto-start next card: yes

## Objective

Replace the Diff placeholder with one simple task-attributed review panel that
can inspect exact source evidence and apply existing admitted review decisions.

## Governing Refs

- `../../../architecture/product-workflow-ui-architecture.md`
- `../../../contracts/006-workspace-layout-contract.md`
- `156-task-diff-read-api-and-tauri-boundary.md`

## Scope

- pass selected task context into the existing Diff panel path
- load the latest reviewable work-item diff overview for that task
- render one summary line, compact changed-file quick open, and one read-only
  unified diff using Nucleus/Poodle tokens
- keep coverage, binary, oversized, truncated, missing, expired, and partial
  detail in compact notices/popovers
- add Open in Editor through workspace-stage panel focus/create plus safe opaque
  file selection
- put Accept and Needs changes in one small review menu
- reuse existing dry-run/apply review-decision helpers with exact revision and
  reviewed evidence refs, then refresh Tasks/Diff state
- preserve chat-led review as an alternative; add no agent tool

## Ordered Steps

1. Add a thin read-only unified-diff renderer with semantic line classes.
2. Build the Diff panel overview, loading, empty, unavailable, and file states.
3. Add changed-file filtering and keyboard navigation in a popover.
4. Wire workspace-stage task context and Open in Editor without tabs/tree UI.
5. Wire review dry-run/apply into one compact menu with reason required for
   Needs changes.
6. Refresh selected-task state after accepted decisions and retain errors
   without hiding evidence.
7. Add focused component/state guards and narrow-width coverage.

## Acceptance Criteria

- normal view is one selected file diff without a permanent file list
- the panel never labels current working-copy state as the task diff
- selected evidence refs and work-item revision drive every review action
- Needs changes cannot apply without a reason
- Accept and Needs changes do not complete the task or mutate files/SCM
- Open in Editor focuses the same safe file without introducing editor tabs
- advanced and recovery states remain keyboard-accessible and compact
- Agent Chat, Tasks, shell movement, and Editor behavior do not regress

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- focused desktop tests for state, navigation, and review admission
- `git diff --check`

## Closure Evidence

- live Tauri task diff, file switch, editor navigation, Accept, and Needs
  changes smoke
- visual inspection at normal and constrained widths
- no sidebar, staging, commit, hunk mutation, merge, or task-completion control

## Stop Conditions

- review requires a source-control workbench or persistent new region
- Editor navigation requires client path authority
- existing review DTOs cannot cite exact checkpoint/diff evidence
- accepted decisions imply task completion or SCM mutation

## Next

Auto-start card 158 after the product review loop is usable.

## Outcome

- The Diff panel resolves the latest reviewable work-item diff from selected
  task drilldown plus review-next evidence. It does not infer from the current
  working copy.
- One compact file popover drives one read-only unified patch. Partial and
  unavailable evidence stays visible as inline notices.
- Open in Editor reuses the workspace panel path and opaque file refs.
- Accept and Needs changes stay in one review popover. Both run admission
  before apply with the selected task revision and exact review evidence;
  Needs changes requires a reason.
- Focused state tests and the desktop production build pass. Desktop checking
  reaches only the 11 existing linked-Poodle diagnostics.

Live interaction and constrained-width evidence remain card 158 closeout work.
