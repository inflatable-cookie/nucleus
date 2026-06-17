# 052 Codex Wait State Routing

Status: planned
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

- Approval and user-input callbacks become explicit wait states.
- Wait states can be cancelled or timed out without losing timeline identity.
- Provider completion does not imply task acceptance.

## Validation

- `cargo test -p nucleus-agent-protocol codex`
- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if wait-state routing requires UI decisions not present in contracts.
