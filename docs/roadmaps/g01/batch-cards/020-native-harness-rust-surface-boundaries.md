# 020 Native Harness Rust Surface Boundaries

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft native harness Rust surface boundaries.

## Scope

- Define the first crate or module boundary for Nucleus-native harnesses.
- Define native persona, session, event, tool, approval, and model backend
  type surfaces.
- Keep implementation out of scope.
- Keep bridged provider adapters separate from native app-owned harnesses.
- Preserve Rust-owned orchestration as the first-pass direction.

## Out Of Scope

- Native harness implementation.
- Model backend implementation.
- Steward agent execution.
- Git sync implementation.
- UI persona management.

## Evidence Questions

- Should native harness types live in a new crate or `nucleus-agent-protocol`?
- Which types are shared with bridged adapters?
- Which types are native-only?
- How should model backend identity be represented?
- How should persona capability policy be represented?
- What minimum native session record is needed before execution?

## Stop Conditions

- Native harness types are collapsed into provider adapter types.
- Provider-native ids are invented for native events.
- Model backend choice changes persona authority.
- Implementation starts before the boundary is documented.

## Promotion Targets

- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/architecture/system-architecture.md`
- future Rust crate/module plan

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft runtime effect trait boundary.
