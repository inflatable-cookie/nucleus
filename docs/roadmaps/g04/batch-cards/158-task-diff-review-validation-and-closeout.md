# 158 Task Diff Review Validation And Closeout

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../029-task-attributed-diff-review.md`
Auto-start next card: no

## Objective

Validate task-window attribution, snapshot safety, transient patch delivery,
and the compact product review loop, then stop for operator direction.

## Governing Refs

- `../029-task-attributed-diff-review.md`
- `../../../specs/007-task-attributed-diff-review.md`
- `154-task-review-source-snapshot-backend.md`
- `155-task-run-checkpoint-diff-integration.md`
- `156-task-diff-read-api-and-tauri-boundary.md`
- `157-compact-task-diff-review-panel.md`

## Scope

- run focused and full validation across Rust, desktop, docs, and diff hygiene
- execute disposable pre-existing-change plus task-window-change smokes
- exercise capture refusal, target failure, binary/oversized, truncation,
  missing/expired, concurrent-write notice, and cleanup behavior
- exercise task run, Diff review, Open in Editor, Accept, and Needs changes in
  the real Tauri app
- inspect normal and constrained presentation
- record dependency, storage, security, changed-file, and remaining-gap evidence
- close the roadmap without choosing SCM mutation or isolated workspaces

## Ordered Steps

1. Run formatting, Rust, desktop, and documentation validation.
2. Run source snapshot policy and retention fixture matrix.
3. Run full fake and real local task-window lifecycle smokes.
4. Verify patch payload absence from SQLite, logs, chat, management projection,
   and agent requests.
5. Review Diff/Editor/Tasks/Agent Chat interaction and narrow layout.
6. Update canonical current-state wording, batch log, indexes, and next pointer.
7. Stop for operator review and next-lane selection.

## Acceptance Criteria

- pre-existing edits are absent from the task diff while in-window edits appear
- every write-capable reviewed task has exact baseline/target/diff refs
- all refusal and recovery paths fail closed without false clean evidence
- snapshot storage and patch responses obey permissions, limits, and retention
- review actions remain admitted and non-completing
- no editor, task, chat, shell, or Goal-run regression remains
- all required checks pass or editor/diff-owned failures are explicit blockers

## Validation

- `effigy check:rust`
- `effigy test`
- `effigy desktop:check`
- `effigy desktop:build`
- `effigy qa:docs`
- `cargo fmt --all -- --check`
- `git diff --check`

## Closure Evidence

- full command summaries and focused fixture results
- Tauri task-attribution and review smoke notes
- normal/constrained visual evidence
- storage/DTO scan showing no patch persistence or absolute path exposure
- remaining gaps with no implied follow-on selection

## Stop Conditions

- any false attribution, source mutation, evidence loss, or payload leak remains
- baseline/target capture is not ordered around provider execution
- review decisions can bypass evidence/revision admission
- visual complexity exceeds the approved compact panel shape

## Next

Stop for operator review. Do not infer SCM mutation, isolation, binary review,
or patch-to-agent priority.

## Progress

- Full Effigy suite passes: 2,139 tests, 10 skipped. This includes snapshot
  boundaries and retention, metadata-only records, lineage checks, bounded
  patches, binary/missing/expired states, and target-capture refusal.
- Four focused desktop diff-state tests and the production desktop build pass.
- Docs QA, Rust formatting, and diff hygiene pass.
- Desktop checking reaches only 11 existing linked-Poodle diagnostics in
  `Rating`, `CardRadioGroup`, and `CardToggleGroup`; the Diff panel has no
  diagnostics.
- Agent Chat history reads now wait for an active turn on Tauri's blocking
  pool instead of the command/UI thread, so tab re-entry stays responsive.
- The Editor surface now owns a bounded fill-height region and CodeMirror's
  scroller owns vertical overflow. The focused desktop suite passes 29 tests.
- The Diff panel now reads the persisted current review decision and keeps its
  outcome plus Needs changes reason visible beneath the toolbar after refresh
  or panel re-entry.
- Source scans keep patch construction inside the transient dedicated read and
  expose display paths rather than host/store paths.

Remaining before closeout: run a fresh write-capable task in the restarted
Tauri app, inspect normal/constrained Diff presentation, exercise Open in
Editor plus both review outcomes, and record operator smoke evidence.

Operator smoke confirmed task-attributed review, Needs changes persistence,
durable note display, chat tab continuity, and Editor scrolling. The next
selected lane is review-guided rework execution.
