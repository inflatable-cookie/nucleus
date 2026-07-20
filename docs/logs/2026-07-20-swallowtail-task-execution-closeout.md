# Swallowtail Task Execution Closeout

Date: 2026-07-20

## Outcome

Nucleus task and Goal execution now use Swallowtail for Codex app-server
transport while Nucleus retains task authority, sequencing, policy, durable
receipts, review state, and recovery semantics.

## Evidence

- 119 focused Swallowtail tests pass.
- 2,485 Nucleus tests pass; 12 separately gated live tests remain skipped by
  the default suite.
- Authenticated single-task and ordered two-task Goal workflows reach
  `awaiting_review` with durable runtime receipt, checkpoint, and diff refs.
- The native two-task Goal workflow remained interactive while running and
  rendered its completed review-ready result without a runtime error banner.

## Repair

Task execution futures now use an isolated worker executor. Invoking
`task_workflow` from the live Agent Chat executor can no longer nest a
`LocalPool`, panic the turn, or leave the native UI waiting indefinitely.

## Next

Resume the paused multi-resource validation lane. The remaining check is the
quiet one-resource workflow across Agent Chat, Editor, and Terminal.
