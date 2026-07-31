# 021 Explicit Harness Plan Mode

Status: completed
Owner: Tom
Created: 2026-07-31
Milestone: `../006-interactive-agent-chat-sessions.md`
Depends on: card 020
Auto-start next card: yes

## Objective

Make normal or plan mode an explicit, visible, immutable session selection.

## Acceptance

- [x] request, storage, history, and effective-session evidence retain mode
- [x] preparation uses Swallowtail `HarnessMode::Plan` only when selected
- [x] changing mode opens a newly prepared session with bounded transcript
      migration context
- [x] unsupported mode fails before provider effects
- [x] the composer exposes a compact mode control

## Evidence

- normal/plan mode crosses desktop DTO, storage, protocol, effective-session
  evidence, and Swallowtail preparation.
- route matching includes mode, so a change cannot reuse the previous prepared
  session.
- deterministic serialization and plan-route selection assertions pass.
