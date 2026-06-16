# 017 Validation Evidence And Artifact References

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Draft validation evidence and artifact reference semantics.

## Scope

- Define how validation commands and results attach to tasks.
- Define artifact references for retained output without copying large logs.
- Connect task validation evidence to storage and event journal boundaries.
- Keep validation execution and artifact storage implementation out of scope.

## Out Of Scope

- Test runner implementation.
- Artifact storage backend.
- UI validation display.
- Scheduler behavior.
- Full event journal implementation.

## Evidence Questions

- Which validation fields belong directly on a task?
- Which outputs should become artifacts rather than task history text?
- How should validation evidence link to agent attempts?
- What artifact identity and retention metadata is needed before storage exists?
- How should failed validation be summarized for task recovery?

## Stop Conditions

- Large command output is copied into task history by default.
- Validation evidence becomes an execution engine.
- Artifact refs imply one storage backend.
- Runtime event streams are duplicated as task artifacts without policy.

## Promotion Targets

- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `crates/nucleus-tasks/src/`
- `crates/nucleus-core/src/`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
