# 014 Codex Live Runtime Supervision

Status: active
Owner: Tom
Updated: 2026-06-17

## Purpose

Move from static Codex app-server fixtures to the first live provider runtime
supervision path.

The milestone should prove process ownership, handshake, event ingestion,
approval/user-input wait states, interruption, and recovery using Codex before
generalizing to other harnesses.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/research/specimen-dossiers/codex-runtime-boundary.md`
- `docs/roadmaps/g02/011-codex-app-server-runtime-runway.md`

## Goals

- [x] Start a scoped nucleus-owned Codex app-server process under host policy.
- [x] Run version, auth, and stdio handshake probes before accepting work.
- [ ] Convert live Codex events into canonical runtime events.
- [ ] Represent approval and user-input callbacks as server-owned wait states.
- [ ] Record interruption, completion, failure, and recovery as runtime
  receipts.

## Execution Plan

- [x] Supervision batch: add owned-process lifecycle for Codex app-server.
- [x] Handshake batch: implement schema/version/auth preflight gates.
- [ ] Live event batch: connect stream ingestion to the static fixture mapper.
- [ ] Wait-state batch: route approvals and user input through receipts and
  command responses.
- [ ] Recovery batch: test restart, resume, unsupported events, and failure
  receipts.

## Batch Cards

Ready cards:

- `batch-cards/051-codex-live-event-ingestion.md`

Planned cards:

- `batch-cards/052-codex-wait-state-routing.md`
- `batch-cards/053-codex-recovery-and-runtime-validation.md`

Completed cards:

- `batch-cards/049-codex-process-supervision-boundary.md`
- `batch-cards/050-codex-handshake-preflight.md`

## Acceptance Criteria

- [ ] One live Codex session can start and emit canonical timeline events.
- [ ] Provider refs remain external refs; Nucleus ids remain authoritative.
- [ ] Cancellation/interruption and recovery outcomes are visible.
- [ ] Raw provider payloads stay behind sanitized evidence policy.
- [ ] UI behavior remains proof-only and does not become state authority.

## Gate

Do not broaden to Claude, Cursor, OpenCode, Pi, or native personas until the
Codex live path proves the common runtime spine.
