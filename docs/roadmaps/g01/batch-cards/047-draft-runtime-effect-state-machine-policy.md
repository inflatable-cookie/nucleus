# 047 Draft Runtime Effect State Machine Policy

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft runtime effect state machine policy.

## Scope

- Draft the allowed state transitions for adapter and command runtime effects.
- Separate request acceptance, queued/running state, final outcome, retry
  classification, cancellation request, timeout, and recovery.
- Keep server scheduling and retry authority explicit.
- Define how effect state should relate to server events without implementing
  event replay.

## Out Of Scope

- Rust implementation.
- Persistence schema.
- Replay store.
- Async runtime.
- Streams.
- Process supervision.
- Provider-specific behavior.
- UI state.

## Evidence Questions

- Which effect states are terminal?
- Can cancellation move through timeout or recovery before terminal state?
- Should retry classification belong only to final outcomes?
- What minimum event vocabulary is needed before implementation?

## Stop Conditions

- The draft starts implementing a scheduler or runtime.
- The draft makes adapters own retries or timeout policy.
- The draft lets command evidence include raw output by default.
- The draft assumes Git-only or GitHub-only effect flows.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Runtime effects use server-owned state transitions.
- Cancellation requested is not terminal.
- Recovery required is not terminal until the server has no recovery path.
- Retry classification belongs to terminal or recovery-required outcomes.
- Retries create new effect requests under server scheduling authority.
- Server events may expose sanitized effect state changes, not raw provider or
  command payloads.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
