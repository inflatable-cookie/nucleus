# 006 Interactive Agent Chat Sessions

Status: completed
Owner: Tom
Created: 2026-07-31

## Purpose

Adopt Swallowtail's typed user-input exchange and immutable harness plan mode
through the existing Nucleus Agent Chat session.

## Governing Refs

- `../../contracts/010-agent-session-lifecycle-contract.md`
- `../../contracts/019-conversation-timeline-contract.md`
- `../../contracts/024-harness-mediation-tool-projection-contract.md`
- `../../contracts/030-swallowtail-agent-runtime-integration-contract.md`
- `../../../swallowtail/docs/contracts/041-input-callback-and-provider-tool-admission.md`
- `../../../poodle/docs/contracts/components/agent-chat-input.md`
- `../../../poodle/docs/contracts/components/agent-question.md`
- `../../../poodle/docs/contracts/components/agent-question-record.md`

## Generation Runway Goal

Let an Agent Chat turn ask a typed question and resume from one operator answer
without freezing the workspace or weakening session-plan truth.

## Goals

- [x] restore compatibility with the current Swallowtail callback vocabulary
- [x] persist pending and answered provider questions with exact correlation
- [x] route one separately submitted answer to the waiting callback exactly once
- [x] compose pending and answered questions through Poodle
- [x] select normal or plan mode as an immutable prepared-session property

## Execution Plan

### Batch 6.1 — Contract And Compatibility

- [x] Execute card 018.
- [x] Promote lifecycle, timeline, mediation, and integration rules.
- [x] Restore the Rust build without pretending task execution is interactive.

### Batch 6.2 — Typed Question Exchange

- [x] Execute cards 019 and 020.
- [x] Add the non-blocking rendezvous, durable records, IPC, and Poodle
      composition.
- [x] Prove duplicate, stale, cancellation, timeout, terminal, and restart
      behavior without provider effects.

### Batch 6.3 — Explicit Plan Mode

- [x] Execute card 021.
- [x] Carry selected and effective mode through request, preparation,
      persistence, and the composer.
- [x] Replace sessions when mode changes.

## Acceptance Criteria

- [x] no Codex-native question payload is parsed
- [x] a pending question blocks only its turn and composer
- [x] cancellation remains independently routable
- [x] one accepted answer resolves the exact Swallowtail responder once
- [x] a restart leaves an unanswered request visible but unanswerable
- [x] normal and plan sessions cannot silently reuse one another

## Decision Gates

- Do not edit Swallowtail, Poodle, or Figmatic.
- Do not run authenticated provider work without a separate operator gate.
- Task execution retains its explicit unsupported question posture.
