# 087 Plan Mode Proposed-Plan Instructions

Status: completed
Owner: Tom
Created: 2026-08-07
Milestone: `../025-plan-decision-agent-chat.md`
Depends on: card 085
Auto-start next card: no

## Objective

Close the plan-presentation gap found in live testing: Nucleus plan-mode
sessions never produced provider plan items, so the plan-decision UI never
had a pending plan to review.

## Root Cause

Codex replaces its built-in plan-mode instructions when the client supplies
developer instructions (`collaboration_mode.settings.developer_instructions`,
null = built-in). Nucleus Agent Chat always supplies `TASK_TOOL_INSTRUCTIONS`,
so the model never learned the `<proposed_plan>` presentation convention and
freeformed plans as ordinary markdown. Confirmed by two controlled app-server
probes against Codex 0.147.0: identical plan-mode turns produce a typed
`plan` item with `item/plan/delta` streaming without Nucleus instructions,
and only ordinary agent messages with them.

## Acceptance

- [x] plan-mode chat sessions append the proposed-plan presentation
  convention to the developer instructions
- [x] normal-mode sessions keep the exact prior instruction text
- [x] migration-context sessions in plan mode carry both the transcript
  context and the convention

## Validation

- [x] focused unit test covers plan, normal, and migration-context
  instruction composition (`cargo test -p nucleus-server local_codex_chat`:
  70 passed)
- [ ] live plan-mode turn produces a pending plan (covered by card 086's
  operator-held native acceptance pass)

## Stop Conditions

- do not copy Codex's built-in instruction text verbatim; Nucleus authors
  its own addendum
- do not parse plan prose out of ordinary assistant messages (contract 030
  boundary stands)

## Evidence

- `chat_developer_instructions` in
  `crates/nucleus-server/src/local_codex_chat/runtime.rs` appends
  `PLAN_PRESENTATION_INSTRUCTIONS` when the route harness mode is Plan.
- Probe transcripts: `/tmp/codex-probe.jsonl` (no Nucleus instructions: plan
  item emitted) and `/tmp/codex-probe2.jsonl` (Nucleus instructions: no plan
  item), captured against Codex `0.147.0-alpha.1.2` with `gpt-5.4-mini`, low
  effort, 2026-08-07.
