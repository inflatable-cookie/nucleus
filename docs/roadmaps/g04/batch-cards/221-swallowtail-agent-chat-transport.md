# 221 Swallowtail Agent Chat Transport

Status: completed
Owner: Codex
Updated: 2026-07-20
Milestone: `../049-swallowtail-agent-chat-adoption.md`
Auto-start next card: yes

## Objective

Replace Agent Chat's direct Codex app-server implementation with a
Swallowtail-backed implementation of the existing Nucleus runtime facade.

## Scope

- sibling Swallowtail workspace dependencies
- Nucleus-owned local host services and preflight construction
- model catalogue projection
- fresh session open with instructions, reasoning, and two tools
- turn event draining, callback response, terminal mapping, deadline, and
  cleanup
- fresh-session transcript migration after restart or route/resource change
- focused adapter and local-chat tests

## Acceptance

- [x] current registry id and public DTOs are unchanged
- [x] direct Codex app-server process/RPC code is removed from the adapter crate
- [x] callback success and failure preserve current host semantics
- [x] stored tool-enabled sessions open fresh with transcript context
- [x] focused Rust tests pass

## Evidence

- `SwallowtailCodexSessionRuntime` is registered under the existing
  `codex-app-server` id and implements the existing Nucleus runtime facade.
- Nucleus owns preflight, host process authority, tool execution, transcript
  migration, receipts, and durable chat state.
- adapter tests: 8 passed
- local Agent Chat tests: 4 passed, 9 authenticated or product checks ignored
- authenticated model catalogue check passed through Swallowtail

## Stop Condition

Stop if implementation requires a durable schema change or a Swallowtail
dependency on Nucleus.
