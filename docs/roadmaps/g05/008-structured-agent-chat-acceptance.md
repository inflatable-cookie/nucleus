# 008 Structured Agent Chat Acceptance

Status: planned
Owner: Tom
Created: 2026-07-31

## Purpose

Close the interactive and structured Agent Chat lane through deterministic
fixtures first, then one separately gated native provider pass.

## Governing Refs

- `006-interactive-agent-chat-sessions.md`
- `007-structured-provider-work.md`
- `../../contracts/030-swallowtail-agent-runtime-integration-contract.md`

## Generation Runway Goal

Leave one cohesive, restart-safe Agent Chat surface with explicit limits and
honest native evidence.

## Goals

- [ ] pass focused Rust, desktop fixture, Svelte, and docs validation
- [ ] exercise question, mode, checklist, and child scenarios deterministically
- [ ] record unresolved provider-version and restart limits
- [ ] gate authenticated native acceptance separately

## Execution Plan

### Batch 8.1 — Deterministic Closeout

- [ ] Execute card 025.
- [ ] Validate the complete lane without credentials or provider calls.
- [ ] Record pre-existing Doctor structural debt separately.

### Batch 8.2 — Native Acceptance

- [ ] Execute card 026 only after explicit operator approval.
- [ ] Run bounded question, plan-mode, task-list, and child-observation cases.
- [ ] Record exact provider/version limitations and cleanup evidence.

## Acceptance Criteria

- [ ] focused deterministic selectors pass
- [ ] `effigy check:rust` passes
- [ ] no unrelated Doctor debt is misreported as this lane's regression
- [ ] native evidence is either recorded or clearly operator-gated

