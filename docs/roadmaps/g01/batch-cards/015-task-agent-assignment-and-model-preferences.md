# 015 Task Agent Assignment And Model Preferences

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft task-level agent assignment and model preference semantics.

## Scope

- Define how task-level model preferences influence adapter and route
  selection.
- Define task assignment fields needed before an agent receives work.
- Keep task assignment separate from adapter implementation.
- Connect task preferences to project/session route overrides without mutating
  durable route defaults.
- Keep execution orchestration out of scope.

## Out Of Scope

- Scheduler implementation.
- Agent execution loop.
- UI task assignment flow.
- Cost/quota policy.
- Provider adapter implementation.

## Evidence Questions

- Which task fields are required before assignment to an agent?
- How should task action type affect adapter capability requirements?
- How should model preferences be represented without forcing one route?
- What assignment state should persist after interrupted work?
- What audit trail is needed for one-click agent delegation later?

## Stop Conditions

- Task preference mutates project or adapter defaults.
- Assignment chooses only a provider driver kind.
- Task action type bypasses adapter capability checks.
- Execution behavior is implemented before assignment contracts settle.

## Promotion Targets

- `docs/contracts/005-task-contract.md`
- `docs/contracts/004-model-routing-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `crates/nucleus-tasks/src/`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Research Nucleus native harness and steward runtime semantics.
