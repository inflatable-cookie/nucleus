# 086 Plan Decision Desktop Wiring And Native Acceptance

Status: operator-held
Owner: Tom
Created: 2026-08-07
Milestone: `../025-plan-decision-agent-chat.md`
Depends on: card 085
Auto-start next card: no

## Objective

Wire the server plan-decision surface into the desktop: interactive plan
review mounts in the composer region through the Poodle `AgentPlan` component,
and the transcript renders the settled `decided-plan` record.

## Acceptance

- [x] a pending plan moves the composer into plan review
- [x] accept, revise, and dismiss reach the server decision route unchanged
- [x] the settled `decided-plan` record renders in the transcript after reload
- [x] the rest of the UI stays responsive while a plan is pending
- [ ] native acceptance proves review, settle, reload, and route-switch truth

## Validation

- [x] focused desktop fixtures cover pending and settled plan rendering
- [x] svelte check, vitest, and docs QA pass
- [ ] native acceptance passes

## Stop Conditions

- do not render plan review as a chat message or transcript pseudo-turn
- do not add plan editing beyond the contracted revise route
- do not widen Poodle `AgentPlan`; its component work is tracked separately

## Evidence

- `AgentChatPanel` projects `history.plan_decisions`, mounts Poodle
  `AgentPlan` through `AgentChatInput`'s plan snippet under `reviewing-plan`,
  and calls `decideAgentChatPlan` for accept and dismiss. Revise focuses the
  composer editor; the sent message settles the plan as revised server-side.
- Accept sets the pending affordances while the Normal-mode follow-up turn
  runs, then rehydrates so the transcript, turn truth, and settled record
  agree with the store.
- `assembleAgentTranscript` emits `decided-plan` records for settled decisions
  and stops flattening decided plan activities into markdown; undecided legacy
  plans keep the old rendering.
- Desktop transcript fixtures cover settled, pending, dismissed, and undecided
  rendering. Svelte check reports zero errors and warnings; bun and vitest
  suites pass.

## Remaining Gate

The operator-authorized live pass: run a Plan-mode turn to a pending plan,
exercise accept, revise, and dismiss, reload the conversation, and confirm the
Normal-mode follow-up session and the settled `decided-plan` records.
