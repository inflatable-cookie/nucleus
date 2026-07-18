# 214 Adapter Layer Decision And Server Facade

Status: in progress
Owner: Claude
Updated: 2026-07-18
Milestone: `../046-engine-boundary-migration.md`
Auto-start next card: no

## Objective

Resolve the orphan-crate planning gaps and give nucleus-server a deliberate
public facade.

## Steps

- operator decision: route codex runtime through `nucleus-agent-protocol`
  traits with `nucleus-agent-adapters` as the real registry, or delete the
  orphan crate and record Codex-only posture in architecture
- decide `nucleus-contract-fixtures`: wire into tests or delete
- add a server facade module (control DTOs + handler entry points); stop
  flat re-exporting ~290 internals from the crate root
- add CI guard tracking server module count downward

## Acceptance

- [x] operator decision executed: `nucleus-agent-protocol` gained the real
  execution boundary (`AgentSessionRuntime` / `AgentLiveSession` /
  `AgentToolCallHandler`); the Codex app-server driver (process, JSON-RPC,
  turn loop, tool-call wire envelope) moved to
  `nucleus-agent-adapters::codex_runtime` behind it, resolved through
  `AgentAdapterRegistry`; the chat runtime is now a thin wrapper keeping
  Nucleus-side concerns (tool semantics, receipts, instructions).
  nucleus-agent-adapters is no longer an orphan crate — the server depends
  on it and a new adapter is one `AgentSessionRuntime` impl plus a
  registry entry
- [ ] `nucleus-contract-fixtures` fate (wire into tests or delete)
- [ ] server facade module and CI module-count guard — next batch

## Validation

- `cargo test --workspace`
- CI green with guard

## Stop Conditions

- stop before implementing a second provider adapter; that is a future lane
