# Harness Adapter Contract First Pass

Status: promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Evidence

The T3 Code source shows a mature provider runtime boundary with:

- provider adapter lifecycle operations
- provider instance routing separate from driver implementation
- canonical runtime events with provider-native refs
- provider-specific adapters for Codex, Claude, Cursor, and OpenCode
- server-owned orchestration and remote access through client/server transport

## Decisions Promoted

- Nucleus adapters need a full lifecycle contract, not only `send_message`.
- Provider instance identity must be separate from provider driver kind.
- Runtime events must carry both nucleus ids and provider-native refs.
- Cursor should start ACP-first.
- OpenCode should start server/SDK-first while keeping ACP in scope.
- Codex should start structured-runtime-first, with PTY fallback only if needed.
- Claude should start SDK-sidecar-first, with direct CLI and PTY fallback paths.
- Kimi Code should start ACP-first, with Wire and SDK sidecar as secondary
  research paths.
- Remote deployment belongs to server environment/access modeling, not the
  adapter abstraction.

## Contract Updates

Updated:

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Remaining Questions

- What is the smallest stable sidecar protocol for Claude Agent SDK?
- Which generated Codex app-server schema should the Rust adapter target?
- Does Cursor SDK supersede ACP for any nucleus use case, or only cloud/CI
  workflows?
- What exact durable event id scheme should nucleus use when provider ids are
  missing or unstable?
- Should Kimi Wire become a first-class Rust adapter path after ACP?
- Should Pi use RPC alone for first implementation, or keep SDK sidecar close?

## Next Task

Draft project and session model-route override semantics.
