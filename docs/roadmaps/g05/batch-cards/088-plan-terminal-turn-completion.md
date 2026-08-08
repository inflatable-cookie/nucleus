# 088 Plan-Terminal Turn Completion

Status: completed
Owner: Tom
Created: 2026-08-07
Milestone: `../025-plan-decision-agent-chat.md`
Depends on: card 087
Auto-start next card: no

## Objective

Let a plan-mode turn whose whole closing output is the proposed plan complete
cleanly, so the pending plan reaches the composer instead of failing the turn.

## Root Cause

The adapter required every completed turn to end with a non-empty assistant
message ("Codex completed the turn without an assistant message"). When the
model emits only a `<proposed_plan>` block, Codex turns it into a plan item
and the turn has no final assistant message at all, so Nucleus failed an
otherwise successful turn and never persisted the pending plan.

## Acceptance

- [x] a completed plan-mode turn without an assistant message succeeds and
  persists the pending plan
- [x] no empty assistant message record is persisted for such turns
- [x] normal-mode turns keep the non-empty assistant message requirement
- [x] contract 019 states the plan-terminal completion rule

## Validation

- [x] adapter tests cover completed-without-message in both modes and the
  non-empty passthrough
- [x] `cargo test -p nucleus-agent-adapters` (25), `cargo test -p
  nucleus-server` suites, desktop svelte-check and vitest all pass

## Stop Conditions

- do not relax the assistant-message requirement outside plan mode
- do not synthesize a placeholder assistant message for plan-terminal turns

## Evidence

- `AgentTurnReply.assistant_message` is `Option<String>` end to end
  (protocol, adapter, server reply, desktop DTO); `completed_output` takes
  the harness-mode allowance; `persist_turn_completion` skips the message
  record when absent.
- Live evidence: operator plan-mode test on Codex 0.147.0 rendered the plan
  content but failed the turn with "Codex completed the turn without an
  assistant message" before this change.
