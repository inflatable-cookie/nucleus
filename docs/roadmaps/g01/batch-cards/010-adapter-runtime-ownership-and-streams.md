# 010 Adapter Runtime Ownership And Streams

Status: done
Owner: Tom
Updated: 2026-06-15

## Goal

Draft adapter runtime ownership and command/event stream semantics.

## Scope

- Define external server, nucleus-owned local server, SDK sidecar, ACP/Wire/RPC
  stdio process, and PTY process ownership.
- Define command acknowledgement, runtime event stream, disconnect, restart,
  and recovery expectations.
- Define where async execution and backpressure belong without implementing
  provider adapters.
- Keep process ownership separate from control-plane access.

## Out Of Scope

- Provider adapter implementations.
- Starting subprocesses.
- Network client implementation.
- Storage backend selection.
- UI rendering.

## Evidence Questions

- Which runtime ownership modes need first-class Rust types?
- How should command acceptance differ from command completion?
- How should adapter event streams report provider disconnect and restart?
- Where should backpressure be represented before async implementation exists?
- How should external servers differ from nucleus-owned processes?

## Stop Conditions

- Runtime ownership is hidden behind provider driver kind.
- Command acknowledgement is treated as turn completion.
- Backpressure assumptions leak into provider-specific code before the common
  boundary is written.
- Remote client access is confused with adapter runtime ownership.

## Promotion Targets

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `crates/nucleus-agent-protocol/src/`
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
