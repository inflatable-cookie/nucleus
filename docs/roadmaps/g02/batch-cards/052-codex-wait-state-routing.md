# 052 Codex Wait State Routing

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../014-codex-live-runtime-supervision.md`

## Purpose

Represent Codex approval and user-input callbacks as Nucleus-owned wait states.

## Scope

- Add wait-state records for approval, user input, interruption, and timeout.
- Route wait states through runtime receipts and control responses.
- Keep model output separate from operator approval.
- Keep UI controls proof-only.

## Acceptance Criteria

- [x] Approval and user-input callbacks become explicit wait states.
- [x] Wait states can be cancelled or timed out without losing timeline
  identity.
- [x] Provider completion does not imply task acceptance.

## Outcome

- Added server-owned Codex wait-state routing records.
- Routed approval and structured user-input callback events to harness-provider
  runtime receipts.
- Added cancellation and timeout terminal routing without changing the evidence
  event id.
- Kept provider callback state separate from task acceptance and UI controls.

## Validation

- [x] `cargo test -p nucleus-server codex`
- [x] `cargo test -p nucleus-agent-protocol codex`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if wait-state routing requires UI decisions not present in contracts.
