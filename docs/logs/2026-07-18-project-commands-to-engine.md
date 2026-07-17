# Project Commands To Engine

Date: 2026-07-18
Lane: g04 engine boundary migration (card 212 closeout)

## Outcome

- project lifecycle rules moved to `nucleus_engine::project_commands`:
  authority-host validation, idempotency fingerprinting and replay
  detection, id derivation, create/rename/park/archive/restore actions, and
  the deletion-impact scan that refuses deletes while any domain still
  references the project
- deletion refusal message now lists only non-zero retained domains (was a
  fixed all-domain counts string); server tests unaffected
- server handler reduced to DTO mapping, the
  `EngineProjectRepository` port (storage, domain payload scan, lifecycle
  receipts), and error mapping; resource commands stay host-side
- card 212 closed: task, goal, and project dispatch all engine-backed;
  contract 022 annotated

## Evidence

- engine unit tests: idempotent replay, key-reuse conflict, authority-host
  rejection
- server and workspace tests green unchanged (behavior parity)

## Next

Card 213 (goal-execution decomposition into engine ports) and card 214
(operator decisions: adapter crate fate, server facade guard) remain in
milestone 046.
