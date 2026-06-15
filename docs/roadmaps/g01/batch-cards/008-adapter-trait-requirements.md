# 008 Adapter Trait Requirements

Status: done
Owner: Tom
Updated: 2026-06-15

## Goal

Draft the first adapter trait requirements for `nucleus-agent-protocol` from
promoted provider evidence.

## Scope

- Compare promoted Codex, Cursor, OpenCode, Claude, Kimi, and Pi findings.
- Define the planned trait split before implementing provider behavior.
- Separate adapter identity, lifecycle commands, event ingestion, capability
  reporting, model-route configuration, and terminal fallback boundaries.
- Record which requirements belong in Rust now and which remain contract-only.

## Out Of Scope

- Implementing provider adapters.
- Starting server runtime behavior.
- Adding real Tauri UI.
- Selecting the storage backend.
- Solving every provider gap before the common trait shape exists.

## Evidence Questions

- Which provider differences must be explicit capabilities?
- Which identity fields are required for every runtime event?
- Which lifecycle commands should be core versus extension/provider-specific?
- How should synthetic ids be represented without hiding native ids?
- How should SDK, ACP, app-server, RPC, server/SDK, and PTY paths share one
  adapter boundary without pretending they are equivalent?
- Where should model/provider routing stop and harness adapter behavior begin?

## Stop Conditions

- The trait shape collapses provider-specific constraints into false
  uniformity.
- The design requires provider implementations before contracts are settled.
- Runtime event identity cannot preserve both nucleus and provider-native ids.
- The Rust crate layout starts concentrating behavior in `lib.rs` instead of
  focused modules.

## Promotion Targets

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/architecture/system-architecture.md`
- `crates/nucleus-agent-protocol/src/`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft adapter runtime ownership and stream semantics.
