# 179 Management Capture Review Read Model

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../039-scm-management-capture-and-share-foundation.md`

## Purpose

Expose capture/share gate state to clients and steward flows without making
clients authoritative.

## Scope

- Add a read model for management capture preparation state.
- Include projection refs, evidence links, policy gates, blocked reasons, and
  provider-neutral next actions.
- Keep provider execution, forge review requests, and desktop polish outside
  this card.

## Acceptance Criteria

- Clients can inspect whether management changes are ready to capture/share.
- The read model distinguishes local capture preparation from later provider
  share/publish/promote operations.
- Tests cover ready, blocked, and review-required states.

## Validation

- Targeted Rust tests for the capture review read model.
- `cargo check --workspace`

## Stop Conditions

- Stop if the read model requires clients to own authority over capture/share
  decisions.
