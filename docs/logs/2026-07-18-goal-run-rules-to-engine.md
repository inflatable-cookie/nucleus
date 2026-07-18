# Goal Run Rules To Engine

Date: 2026-07-18
Lane: g04 engine boundary migration (card 213 closeout)

## Outcome

- `nucleus_engine::goal_run_rules` now owns the pure goal-run decisions:
  provider prompt composition (including rework context), work-item
  identity, action-type parsing, and task / goal-continuation / mandate
  validation, all over a host-neutral `EngineGoalRunTaskView`
- the server's goal-execution modules map control DTOs into the view and
  delegate; provider IO, durable dispatch gates, snapshots, and receipt
  persistence stay host-side — effects, not decisions
- engine unit tests cover prompt content (rework note present, no patch
  content), validation rejections (revision drift, unready task, expired
  mandate, non-continuable goal status), and identity stability — all
  without a codex process
- card 213 closed; adapter decision recorded in milestone 046: Codex will
  route through nucleus-agent-protocol traits with nucleus-agent-adapters
  as the real registry (card 214)

## Evidence

- goal-execution family tests pass unchanged (42 green); workspace green

## Next

Card 214: adapter-trait routing and the server facade guard. Milestone 048
awaits the archive-location decision.
