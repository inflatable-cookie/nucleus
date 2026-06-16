# 039 Draft Production Adapter Trait Boundary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft production adapter trait boundary.

## Scope

- Draft the first production adapter trait boundary in docs.
- Use evidence from provider-neutral fixtures, fake adapters, and scenario
  scripts.
- Separate production trait requirements from dev-only test support.
- Keep SCM, forge, and command-policy trait surfaces distinct.
- Identify which trait methods can stay synchronous value-returning first and
  which likely need streaming or async later.

## Out Of Scope

- Implementing production traits in Rust.
- Implementing real adapters.
- Async runtime selection.
- Server registry integration.
- Network, shell, SCM, forge, or command execution.

## Evidence Questions

- Which production traits should be drafted first: SCM, forge, command policy,
  or shared observation source?
- Which fixture and scenario types should influence traits without being reused
  as production APIs?
- How should trait boundaries avoid assuming Git commit semantics?
- How should command authority remain server-owned?

## Stop Conditions

- The draft copies dev-only fixture APIs directly into production contracts.
- The draft assumes all SCM providers expose commits, branches, and pull
  requests.
- The draft lets adapters bypass server command policy.
- The draft requires async/runtime choices before those are contracted.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/001-foundation-and-research.md`

## Decisions

- Production SCM and forge adapter traits are separate surfaces.
- Command authority remains server-owned and separate from adapters.
- Static identity, capability, workflow semantics, and readiness can begin as
  value-returning trait methods.
- Observation refresh, webhooks, command-backed operations, provider polling,
  and event streams are effectful boundaries that need a later runtime
  contract before implementation.
- Dev-only fixtures, fake adapters, and scenario scripts inform the boundary
  but are not production APIs.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft runtime effect trait boundary.
