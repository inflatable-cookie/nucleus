# 213 Goal Execution To Engine Ports

Status: completed
Owner: Claude
Updated: 2026-07-18
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

- [x] workflow decisions unit-testable in engine without a codex process:
  `nucleus_engine::goal_run_rules` holds prompt composition, work-item
  identity, action parsing, task/continuation/mandate validation over the
  new `EngineGoalRunTaskView`; server maps DTOs to the view and delegates.
  Provider IO, durable dispatch gates, and receipt persistence stay
  host-side by design — they are effects, not decisions
- [x] `goal_execution.rs` no longer exists as a single god file: 128-line
  front door plus run_loop / rules / outcome / dispatch / persistence
  modules (127-320 lines each) with tests split alongside
- [x] behavior parity proven: all existing goal-execution tests pass
  unchanged (42 green, live-auth ones stay ignored)

## Validation

- `cargo test --workspace`
- desktop agent chat manual smoke

## Stop Conditions

- stop before adding new provider capabilities; parity move only
