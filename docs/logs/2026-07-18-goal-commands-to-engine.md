# Goal Commands To Engine

Date: 2026-07-18
Lane: g04 engine boundary migration (card 212, first batch)

## Outcome

- goal authoring rules moved from the server request handler to
  `nucleus_engine::goal_commands`: status gates, project-existence check,
  timestamp handling, membership-change application, field merge,
  validation, and revision derivation now sit behind an
  `EngineGoalRepository` port
- server handler reduced to DTO mapping, the storage port implementation,
  and error mapping — same shape as the existing task-command adapter
- verified during the move: task command dispatch was already engine-backed
  through `EngineTaskCommandService`; the audit's "engine unused" reading
  reflected direct-import counts, not the port pattern
- engine gained its first nucleus-planning dependency; new engine unit
  tests cover the status gate, project-existence rejection, and persisted
  revision derivation (validate_goal's owner-ref rule surfaced live during
  test writing)
- contract 022 request_handler entry annotated; project lifecycle commands
  (506 lines, zero engine refs) are the remaining dispatch batch

## Evidence

- server tests pass unchanged (behavior parity), engine goal tests green,
  `cargo test --workspace` green

## Next

Project lifecycle command migration, then card 213 (goal execution to
engine ports) and card 214's operator decisions.
