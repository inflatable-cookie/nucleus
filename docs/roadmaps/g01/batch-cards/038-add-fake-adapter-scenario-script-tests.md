# 038 Add Fake Adapter Scenario Script Tests

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add fake adapter scenario script tests.

## Scope

- Add scenario-level tests for fake adapter event ordering.
- Keep scenarios deterministic and offline.
- Represent scripted SCM, forge, and command-policy events as test-support
  records.
- Cover at least one management-state sync path and one rejected-review or
  blocked-policy path.
- Keep scenario scripts inside `nucleus-contract-fixtures`.

## Out Of Scope

- Production adapter traits.
- Real provider commands, network calls, or credentials.
- Runtime event bus implementation.
- Server orchestration.
- Persistence or replay storage.

## Evidence Questions

- What is the smallest event-script shape that proves ordering without
  becoming a production event model?
- Should command-policy and SCM/forge events share one scenario wrapper or
  stay separate?
- Which fields are needed to prove deterministic replay later?

## Stop Conditions

- Scenario scripts depend on live provider state.
- Test-support event shapes are promoted as production APIs.
- Scripts require async runtime, process spawning, or network.
- Git-like terminology is forced onto non-Git workflows.

## Promotion Targets

- `crates/nucleus-contract-fixtures`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Added fake adapter scenario scripts as ordered dev-only test records.
- Scenario scripts are not production events, replay logs, persistence records,
  or adapter traits.
- Added scenarios for a management-state sync path and a blocked-policy /
  rejected-review path.
- Scenario tests assert strict ordering and coarse event categories without an
  async runtime, process execution, network, or live provider state.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft runtime effect trait boundary.
