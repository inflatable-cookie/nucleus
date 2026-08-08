# 085 Plan Decision Server Implementation

Status: completed
Owner: Tom
Created: 2026-08-07
Milestone: `../025-plan-decision-agent-chat.md`
Depends on: card 084
Auto-start next card: no

## Objective

Persist and project plan decisions on the server per the amended contracts:
pending plans stay queryable, exactly one decision attaches to one proposed
plan, and the settled record carries the plan snapshot and provenance.

## Acceptance

- [x] a pending plan record retains conversation id, turn id, and plan activity
  correlation plus the proposed plan snapshot
- [x] accept, revise, and dismiss each settle the pending plan exactly once
- [x] the durable decision record carries outcome, snapshot, and provenance
- [x] history projects the settled decision for transcript rendering
- [x] accepting a plan prepares a Normal-mode session per contract 010 and the
  existing route-mismatch rule in `local_codex_chat.rs`
- [x] duplicate, stale, or post-settlement decisions fail deterministically

## Validation

- [x] focused server fixtures cover pending, settle-once, and history
  projection paths
- [x] Rust check and docs QA pass

## Stop Conditions

- do not synthesize a user message for an accepted plan
- do not add a mid-session harness mode switch
- do not promote an accepted plan into tasks or execution in this card
- do not build desktop wiring here; card 086 owns it

## Evidence

- `StoredChatPlanDecision` persists under `product-chat-plan:{turn_id}` with
  the exact plan snapshot, plan activity correlation, decision timestamp, and
  accept follow-up turn id. Pending insert is `MustNotExist`; settle requires
  exact correlation and a pending status under an exact revision.
- Plan-mode turn completion accumulates plan activity content (delta and
  replacement semantics mirror the desktop projection) and persists one
  pending decision. An ordinary message sent while a plan is pending settles
  it as revised — the revise channel. Restart recovery leaves pending plans
  queryable.
- `decide_agent_chat_plan` settles once; on accept it drives the follow-up
  turn through the existing send path with `harness_mode: normal`, so the
  route-mismatch rule opens a fresh session with bounded message-only context.
  The accept turn rides the same cancellation, activity, and question wiring
  as an ordinary send.
- Seven focused server tests cover pending round-trip, exactly-once settle,
  correlation mismatch, revise-on-send, restart survival, accumulator
  semantics, and service-level dismiss. Workspace Rust check and docs QA pass.
