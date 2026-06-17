# 067 Native Tool Action And Receipt Linkage

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../018-steward-native-harness-and-effigy-tools.md`

## Purpose

Link native steward tool actions to engine runtime receipts without executing
tools yet.

## Scope

- Add or refine records that connect native tool actions, approval requests,
  audit events, and runtime receipt refs.
- Preserve command-backed and receipt-backed behavior.
- Keep raw command output and model output out of durable task state.
- Do not implement tool execution.

## Acceptance Criteria

- [x] A native tool action can reference approval and receipt evidence.
- [x] Receipt family keeps Effigy, steward, command execution, and tool calls
  distinct.
- [x] Rejected, blocked, completed, and waiting-for-approval states are explicit.

## Outcome

Extended native tool action records with lifecycle state, approval request ids,
runtime receipt refs, audit event ids, and sanitized evidence refs.

Added receipt-family tests proving Effigy, steward, command execution, and
tool-call receipt families stay distinct. Tool records remain reference-only
and do not execute commands or model calls.

## Validation

- [x] `cargo test -p nucleus-native-harness tool`
- [x] `cargo test -p nucleus-engine runtime_receipt`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if implementing this requires real command execution or model calls.
