# 213 Goal Execution To Engine Ports

Status: planned
Owner: Codex
Updated: 2026-07-17
Milestone: `../046-engine-boundary-migration.md`
Auto-start next card: no

## Objective

Move goal/task workflow logic out of
`nucleus-server/src/local_codex_chat/goal_execution.rs` (1,784 lines) into
engine behind effect ports, leaving provider IO server-side.

## Steps

- split pure workflow decisions (state transitions, admission, next-step
  selection) from codex process IO
- define effect ports for provider send/receive; engine drives, server
  implements
- decompose the god file as part of the move

## Acceptance

- [ ] workflow decisions unit-testable in engine without a codex process
- [ ] `goal_execution.rs` no longer exists as a single god file
- [ ] behavior parity proven by existing chat/task tests

## Validation

- `cargo test --workspace`
- desktop agent chat manual smoke

## Stop Conditions

- stop before adding new provider capabilities; parity move only
