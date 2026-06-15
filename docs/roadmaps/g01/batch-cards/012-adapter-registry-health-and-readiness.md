# 012 Adapter Registry Health And Readiness

Status: done
Owner: Tom
Updated: 2026-06-15

## Goal

Draft adapter registry health and readiness probe semantics.

## Scope

- Define which health and readiness fields are persisted as stale display state.
- Define which fields must be recomputed before assigning new work.
- Define probe cadence and failure semantics at a contract level.
- Distinguish external server, owned process, sidecar, stdio, and PTY health.
- Keep probe behavior separate from provider adapter implementation.

## Out Of Scope

- Concrete health probe implementation.
- Async runtime design.
- Provider-specific adapter processes.
- Secret store implementation.
- UI health display.

## Evidence Questions

- Which probes are required for an adapter to receive work?
- Which failures should mark an instance unavailable versus degraded?
- How do external server probes differ from owned process liveness checks?
- How should stale readiness appear after restart?
- What health evidence should be retained for audit without becoming authority?

## Stop Conditions

- Health snapshots are treated as permanent capabilities.
- A stale readiness value can assign new work without a fresh probe.
- External server health is modeled as if nucleus owns the process.
- PTY fallback health hides structured transport failure.

## Promotion Targets

- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/002-harness-adapter-contract.md`
- `crates/nucleus-agent-adapters/src/`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft task-level agent assignment and model preference semantics.
