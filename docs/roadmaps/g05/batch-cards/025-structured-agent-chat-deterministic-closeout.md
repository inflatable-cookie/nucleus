# 025 Structured Agent Chat Deterministic Closeout

Status: completed
Owner: Tom
Created: 2026-07-31
Milestone: `../008-structured-agent-chat-acceptance.md`
Depends on: card 024
Auto-start next card: no

## Objective

Validate the complete lane with bounded fixtures and no authenticated provider
effects.

## Acceptance

- [x] focused Rust adapter and server fixtures pass
- [x] desktop mapping, interaction, and Svelte checks pass
- [x] docs QA passes
- [x] `effigy check:rust` passes
- [x] pre-existing Doctor structural debt is recorded separately

## Evidence

- Focused protocol and server selectors cover typed questions, restart,
  portable activity, session mode, and subagent-directory persistence.
- Agent Chat transcript fixtures cover question composition, structured work,
  and exact operation-local actor filtering.
- Desktop Svelte checks, Rust checks, docs QA, formatting, and diff hygiene pass.
- Doctor still reports the 25 pre-existing oversized-file errors. No new
  structural finding belongs to this lane.
- No authenticated provider work ran. Card 026 remains operator-held.
