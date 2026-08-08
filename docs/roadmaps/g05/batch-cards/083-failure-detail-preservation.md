# 083 Failure Detail Preservation

Status: completed
Owner: Tom
Created: 2026-08-07
Milestone: `../025-plan-decision-agent-chat.md`
Depends on: card 082
Auto-start next card: no

## Objective

Stop dropping Swallowtail diagnostic detail that already exists: keep the
diagnostic code in surfaced Codex turn failures and carry the persisted turn
failure reason through history into the desktop panel.

## Acceptance

- [x] adapter turn errors include the `SafeDiagnostic` code
- [x] terminal provider/host/runtime failures include the diagnostic code
- [x] history turns carry `failure_reason` from persistence through the DTO
- [x] the panel renders the persisted failure reason on failed turns
- [x] failed turns stay inspectable after conversation reload

## Validation

- [x] focused server history/persistence fixtures cover the round-trip
- [x] focused adapter fixtures pass
- [x] Rust check, desktop checks, and docs QA pass

## Stop Conditions

- do not repin Swallowtail; the v0.2.1 excerpt enrichment lands separately
- do not add failure classification formatting beyond the stable code
- do not redesign panel error presentation

## Evidence

- `runtime_error` and the `TerminalStatus` failure arms in
  `crates/nucleus-agent-adapters` prefix the stable diagnostic code.
- `LocalCodexChatHistoryTurn` and its `AgentChatHistoryTurn` mirror carry
  `failure_reason`; `AgentChatPanel` renders it next to the composer error
  region for failed turns.
- `FailureClassification` exposes no `Display` in Swallowtail v0.2.0, so the
  surfaced string keeps the code only.
