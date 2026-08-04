# 005 Observable Agent Chat Transcript

Status: completed
Owner: Tom
Created: 2026-07-30

## Purpose

Carry Swallowtail's exact observable activity through Nucleus persistence and
the desktop into Poodle's agent-output components without reviving native Codex
event parsing.

## Governing Refs

- `../../contracts/019-conversation-timeline-contract.md`
- `../../contracts/030-swallowtail-agent-runtime-integration-contract.md`
- `../../../swallowtail/docs/contracts/044-observable-agent-activity-and-disclosure.md`
- `../../../swallowtail/docs/releases/0.1.0-nucleus-observable-activity-handoff.md`
- `../../../poodle/docs/contracts/components/agent-transcript.md`
- `../../../poodle/docs/contracts/components/agent-message.md`
- `../../../poodle/docs/contracts/components/tool-call-group.md`
- `../../../poodle/docs/contracts/components/tool-call.md`

## Generation Runway Goal

Make Agent Chat show provider-visible work as it happens while preserving
Nucleus-owned conversation state and the sparse project workspace.

## Goals

- [x] inspect exact prepared activity support before provider effects
- [x] forward portable activity without provider-native parsing
- [x] persist ordered activity separately from messages
- [x] replay activity through conversation history
- [x] stream durable activity to the calling desktop window
- [x] adopt Poodle transcript, message, and collapsed work presentation
- [x] preserve receipts, cancellation, terminal output, and cleanup truth

## Execution Plan

### Batch 5.1 — Portable Projection And Persistence

- [x] Execute card 014.
- [x] Extend the Nucleus adapter boundary with Swallowtail activity and exact
      sequence.
- [x] Persist and replay bounded activity observations.

### Batch 5.2 — Desktop Transcript Adoption

- [x] Execute card 015.
- [x] Emit caller-window activity DTOs only after durable projection.
- [x] Map history and live activity into Poodle transcript items.

### Batch 5.3 — Focused Closeout

- [x] Execute card 017.
- [x] Prove rich, completion-only, reasoning-summary, unknown, failure, and
      final-output separation without live provider effects.
- [x] Leave native visual and authenticated proof as explicit operator gates.
- [x] Inspect the current app bundle, stored transcript readability, and
      non-stealing scroll behavior without provider effects.

### Batch 5.4 — Portable Activity Key Adoption

- [x] Execute card 082.
- [x] Upsert durable activity by Swallowtail's complete portable `ActivityKey`.
- [x] Keep Nucleus thread, turn, and transcript-message identity separate.
- [x] Prevent consumer runtime-operation identity reuse across retained state.
- [x] Prove equal provider/activity ids in two operations retain two rows.

## Acceptance Criteria

- [x] no Nucleus code switches on Codex native event names
- [x] one operation-local activity identity updates one displayed work item
- [x] one complete portable activity key upserts one durable row
- [x] assistant messages and work activity persist separately
- [x] reasoning is labelled only as a summary
- [x] consecutive work collapses through Poodle-owned grouping
- [x] final output remains usable when activity is ignored
- [x] task and workflow receipts remain actionable
- [x] provider, cancellation, persistence, terminal, and cleanup failures stay
      distinct
- [x] durable turn terminal truth settles still-open presentation activity
      after cancellation without synthesizing provider lifecycle

## Decision Gates

- Do not edit Poodle or Figmatic; they are read-only component and adoption
  evidence.
- Do not run authenticated Codex work without a separate operator gate.
- Stop if current Poodle components require Nucleus to parse native payloads or
  surrender receipt actions.

## Next Planning Checkpoint

Card 017 passed the current-bundle, authenticated activity, collapse, scroll,
final-output, cancellation, joined-cleanup, and restart checks. Existing
project-layout and Forge manual validations remain held; this lane does not
mark them complete.
