# Goal Execution Decomposition

Date: 2026-07-18
Lane: g04 engine boundary migration (card 213, first batch)

## Outcome

- the 1,784-line `goal_execution.rs` god file is decomposed into a 128-line
  front door (public types and entry points) plus five focused modules:
  `run_loop` (serial task execution), `rules` (continuation and dispatch
  validation, pre-dispatch recovery), `outcome` (outcome application,
  source transitions, runtime receipts), `dispatch` (dispatch composition,
  prompts, work-item ids), and `persistence` (execution record storage and
  expiry); tests split alongside
- behavior unchanged: all existing goal-execution tests pass as-is
- the engine-port extraction remains open on the card: prompt/dispatch
  composition consumes server control DTOs, so moving decisions into
  nucleus-engine first needs an engine-neutral task view type

## Evidence

- `cargo test --workspace` green; goal-execution family 42 tests green,
  live-auth tests remain ignored as before; zero build warnings after
  import cleanup

## Next

Engine-neutral task view + move rules/dispatch decisions into engine (card
213 remainder), or proceed to card 214's operator decisions.
