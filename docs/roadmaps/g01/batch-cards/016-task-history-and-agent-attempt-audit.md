# 016 Task History And Agent Attempt Audit

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft task history and agent attempt audit semantics.

## Scope

- Define task history events needed before agent execution exists.
- Define how agent attempts, interruptions, failures, and handoffs are recorded.
- Keep task history separate from runtime event streams and UI logs.
- Define which assignment and validation evidence should persist.
- Keep scheduler and execution orchestration out of scope.

## Out Of Scope

- Scheduler implementation.
- Agent execution loop.
- Runtime event journal implementation.
- UI timeline design.
- Full audit log storage backend.

## Evidence Questions

- Which task history entries are durable task state?
- Which runtime events should be linked rather than copied into task history?
- How should failed or interrupted agent attempts be summarized?
- What validation command evidence belongs on a task?
- How should human handoff and reassignment be represented?

## Stop Conditions

- Runtime event streams are duplicated into task history.
- Task history becomes a general UI log.
- Agent attempts omit adapter instance, route, session, or assignment context.
- Execution orchestration is implemented before audit contracts settle.

## Promotion Targets

- `docs/contracts/005-task-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `crates/nucleus-tasks/src/`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft validation evidence and artifact reference semantics.
