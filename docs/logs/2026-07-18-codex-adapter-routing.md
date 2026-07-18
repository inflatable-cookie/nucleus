# Codex Adapter Routing

Date: 2026-07-18
Lane: g04 engine boundary migration (card 214, first batch)

## Outcome

- `nucleus-agent-protocol::live_runtime` is the first executable adapter
  contract: `AgentSessionRuntime` (start sessions, model catalog) and
  `AgentLiveSession` (send turns) with a host-side `AgentToolCallHandler`
  for dynamic tool calls
- the Codex app-server driver moved to
  `nucleus-agent-adapters::codex_runtime`: process spawn, JSON-RPC,
  thread start/resume, the turn event loop, and the tool-call wire
  envelope; `AgentAdapterRegistry::with_builtin_adapters()` resolves
  runtimes by adapter id (`codex-app-server`)
- the server chat runtime is a thin wrapper: Nucleus tool instructions and
  specs, tool-call semantics and receipt accumulation, stored-session
  mapping, reply shape — a future Claude adapter is one
  `AgentSessionRuntime` impl plus a registry entry, no chat changes
- nucleus-agent-adapters stops being an orphan crate: the server now
  depends on it; sessions carry a `Send` bound so desktop state can hold
  them across threads

## Evidence

- adapter and protocol unit tests green (registry resolution, model
  catalog parsing); chat family tests pass through the new boundary (41
  green, live-auth ignored as before); workspace green

## Next

Card 214 remainder: server facade + CI module-count guard, and the
nucleus-contract-fixtures decision. Card 213/214 both otherwise done —
milestone 046 nearly closed.
