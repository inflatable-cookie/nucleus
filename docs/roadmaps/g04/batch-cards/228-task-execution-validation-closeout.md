# 228 Task Execution Validation Closeout

Status: ready
Owner: Tom
Updated: 2026-07-20
Milestone: `../050-swallowtail-task-execution-adoption.md`
Auto-start next card: no

## Objective

Prove authenticated task and Goal execution parity, remove superseded direct
transport, and select the next provider-adoption lane.

## Acceptance

- [x] focused cross-repo suites pass
- [x] one task reaches review-ready with durable diff evidence
- [x] one ordered two-task Goal reaches review-ready
- [x] waiting, failure, timeout, and recovery outcomes remain inspectable
- [x] no unapproved direct Codex process or JSON-RPC owner remains
- [ ] native UI stays responsive and displays the resulting receipts

## Evidence

- Swallowtail: 119 focused tests pass.
- Nucleus: 2,485 tests pass; 12 separately gated live tests remain skipped by
  the default suite.
- Authenticated chat-to-Goal parity passes through `task_ledger` and
  `task_workflow`: two ordered provider turns, two workspace writes, two
  durable work-item refs, two runtime-receipt refs, and restart-safe chat
  history.
- Each live task ends `completed` and `awaiting_review` with persisted runtime
  receipt, checkpoint, and diff-summary refs.
- Task execution futures use an isolated worker executor, so a workflow portal
  invoked from the live chat executor cannot nest `LocalPool` and beachball or
  panic the turn.
- Focused outcome tests preserve approval wait, user-input wait, failure,
  timeout, cancellation, and recovery-required distinctions.

## Remaining Check

Run the same two-task Goal from the native Agent Chat panel. Keep the app
interactive while both provider turns run, then confirm the Goal receipt and
both task review/diff surfaces render without an error banner.

## Stop Condition

Keep the lane open with exact failed parity checks if execution, evidence,
cleanup, recovery, or UI behavior regresses.
