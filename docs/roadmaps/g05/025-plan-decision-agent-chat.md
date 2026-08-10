# 025 Plan Decision Agent Chat

Status: completed
Owner: Tom
Created: 2026-08-07

## Purpose

Make plan-mode accept/revise a first-class Agent Chat workflow and stop
dropping the turn-failure detail the runtime already reports.

Two slices share this lane:

- failure detail: preserve the Swallowtail diagnostic code in surfaced turn
  errors and keep persisted failure reasons inspectable after reload
- plan decision: the operator reviews a proposed plan in the composer region,
  the transcript gains a settled `decided-plan` record, and accepting a plan
  is a durable action with provenance, not a synthesized user message

## Governing Refs

- `../../contracts/010-agent-session-lifecycle-contract.md`
- `../../contracts/019-conversation-timeline-contract.md`
- `../../contracts/026-open-ended-planning-conversation-contract.md`
- `../../contracts/030-swallowtail-agent-runtime-integration-contract.md`

## Generation Runway Goal

Extend the consolidated Agent Chat surface with an honest failure trail and an
explicit plan-decision boundary while keeping normal state quiet.

## Goals

- [x] keep Swallowtail diagnostic codes in surfaced Codex turn failures
- [x] surface persisted turn failure reasons through history and the panel
- [x] record plan-decision promotion in contracts 019, 026, and 030
- [x] persist and project plan decisions with provenance on the server
- [x] wire composer plan review and the settled transcript record on desktop

## Acceptance Criteria

- [x] focused server and adapter fixtures cover failure-detail round-trip
- [x] a failed turn stays inspectable after conversation reload
- [x] plan decisions persist exactly one decision per proposed plan
- [x] accepting a plan opens a Normal-mode prepared session per contract 010
- [x] native acceptance proves the composer plan-review and settled record (operator GUI pass 2026-08-07 + recorded live proof, card 091)

## Batch Cards

- `batch-cards/083-failure-detail-preservation.md`
- `batch-cards/084-plan-decision-contract-amendments.md`
- `batch-cards/085-plan-decision-server-implementation.md`
- `batch-cards/086-plan-decision-desktop-wiring-and-native-acceptance.md`
- `batch-cards/087-plan-mode-proposed-plan-instructions.md`
- `batch-cards/088-plan-terminal-turn-completion.md`
- `batch-cards/089-chat-thread-deletion.md`
- `batch-cards/090-resource-free-chat-sentinel-resolution.md`
- `batch-cards/091-plan-decision-live-provider-proof.md`
