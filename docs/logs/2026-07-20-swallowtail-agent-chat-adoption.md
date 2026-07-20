# Swallowtail Agent Chat Adoption

Date: 2026-07-20
Lane: g04 roadmap 049, cards 220–222

## Outcome

- Agent Chat no longer owns a direct Codex app-server wire implementation.
- `nucleus-agent-adapters` registers `SwallowtailCodexSessionRuntime` under the
  existing `codex-app-server` id and preserves the current Nucleus runtime
  facade, server chat service, Tauri commands, and UI DTOs.
- Swallowtail owns model discovery, session and turn protocol, streamed events,
  dynamic callback transport, deadlines, interruption, and cleanup.
- Nucleus owns approved process and resource access, preflight, prompts, tool
  declarations and execution, receipts, durable chat state, and transcript
  migration.
- Stored tool-enabled history opens a fresh provider session with sanitized
  transcript context. Provider thread ids remain audit refs, not unsafe resume
  authority.
- Exact model selection is enforced at the Swallowtail Codex boundary; provider
  fallback is disabled.
- tool-enabled sessions advertise Codex's experimental API capability; plain
  sessions do not widen their initialization shape
- whitespace-only stream deltas and blank intermediate agent completions are
  accepted as progress without constructing invalid normalized content

## Evidence

- Swallowtail Codex integration: 14 passed
- Nucleus adapter: 8 passed
- authenticated model catalogue through Swallowtail: passed
- authenticated focused acceptance: 4 passed for same-session follow-up,
  route-change isolation, restart context, and task-ledger receipts
- authenticated native task/Goal inspection: passed through the two dynamic
  portals without mutation
- full `effigy qa`: passed
- Nucleus server: 1,981 passed, 11 ignored
- desktop Svelte diagnostics: 0 errors, 0 warnings
- desktop TypeScript tests: 14 passed

## Follow-on Boundary

`local_codex_chat/task_execution.rs` still contains a separate direct Codex
task-execution transport. It was not folded into Agent Chat because its durable
task, review, and execution semantics need a dedicated mapping. Provider
settings and non-Codex routes also remain later work.

The inventory also found a direct read-only diagnostic smoke under `nucleusd`.
The large `codex_supervision` and `codex_task_runtime` trees do not own process
or wire transport; they remain Nucleus policy and evidence machinery.

Roadmap 050 now governs the contract-first writable task-execution migration.

## Task Execution Contract Gate

- Nucleus Contract 031 names the `TaskExecutionRuntime` consumer port and
  retains task, Goal, mandate, work-item, evidence, review, and receipt
  authority.
- Swallowtail Contract 013 expands read-only and bounded-workspace profiles
  into independent resource, filesystem, approval, network, provider-request,
  deadline, and cleanup dimensions.
- resource-free and remote-authoritative writable execution fail closed.
- both repos now point to policy/preflight implementation before Codex driver
  changes.
