# Plan Decision Agent Chat

Date: 2026-08-07
Status: lane implementation complete; native acceptance operator-held

## Changed

- Amended Contracts 019, 026, and 030: plan decisions are first-class
  timeline exchanges with exactly one decision per proposed plan, durable
  provenance, and a Normal-mode prepared session on accept. Cards 083 and 084
  closed that slice.
- Kept Swallowtail diagnostic codes in surfaced Codex turn errors across the
  chat, task-execution, and smoke paths; persisted turn failure reasons now
  reach history and the desktop panel, so a failed turn stays inspectable
  after reload.
- Added the durable `StoredChatPlanDecision` record: conversation and turn
  ids, plan activity correlation, exact plan snapshot, pending or settled
  status, decision timestamp, and the accept follow-up turn id.
- Plan-mode turn completion now persists one pending plan decision built from
  the accumulated plan activity content (delta and replacement semantics match
  the desktop projection).
- Added the `decide_agent_chat_plan` control route. Accept, revise, and
  dismiss each settle the pending plan exactly once; duplicate, stale, and
  mismatched-correlation decisions fail deterministically. Accept settles the
  decision, then drives the follow-up turn in Normal mode with the accepted
  plan embedded; the existing route-mismatch rule opens a fresh session with
  bounded message-only context.
- An ordinary message sent while a plan is pending settles it as revised —
  the revise channel from the Poodle `AgentPlan` contract.
- Pending plans survive restart as queryable pending; history projects all
  decisions for transcript replay.
- Composed the pending plan through Poodle `AgentPlan` in `AgentChatInput`
  under `reviewing-plan`; settled decisions render as `decided-plan` records
  via `AgentTranscript`. Decided plan activities no longer flatten into plain
  markdown messages; undecided legacy plans keep the old rendering.

## Boundaries Preserved

- No synthesized user message stands in for a decision; the durable record
  carries the outcome and provenance.
- No mid-session harness mode switch; accept rides the existing fresh-session
  route rule.
- An accepted plan does not create tasks, promote planning artifacts, or grant
  execution authority by itself.
- The plan-decision route adds no provider parsing; the snapshot comes from
  the portable plan activity Nucleus already persists.
- Swallowtail and Poodle sources were not modified from this lane.

## Evidence

- focused server plan-decision tests: pending round-trip, exactly-once settle,
  correlation mismatch, ordinary-message revise settle, restart survival,
  service-level dismiss and repeat rejection
- focused plan-draft accumulator test for delta and replacement accumulation
- desktop transcript fixtures for settled, pending, dismissed, and undecided
  plan rendering
- desktop Svelte check: 0 errors, 0 warnings
- desktop bun and vitest suites pass
- `effigy check:rust` and the desktop host crate tests pass
- docs QA passes

## Residual Risks

- Accept settles the decision before the follow-up turn runs. If provider
  admission then fails, the transcript holds an accepted plan with no executed
  follow-up; the failure surfaces as ordinary turn truth and the operator can
  restate intent in a new message.
- A decided plan's transcript position follows its proposing turn; the accept
  follow-up turn renders its own accept message and reply after it.
- The pending plan appears in the composer only after history loads or the
  proposing turn completes; there is no mid-turn plan preview.
- Native acceptance (review, settle, reload, and route-switch truth against a
  live provider) is not yet run.

## Next

Operator-authorized native acceptance for card 086: run a Plan-mode turn to a
pending plan, exercise accept, revise, and dismiss, reload the conversation,
and confirm the Normal-mode follow-up session and the settled `decided-plan`
records.

## Addendum: Plan-Presentation Instruction Gap (card 087)

Live acceptance surfaced a trigger gap: Plan-mode turns completed with only
ordinary assistant messages and zero plan activity, so no pending plan ever
reached the composer. Two controlled app-server probes against Codex
`0.147.0-alpha.1.2` isolated the cause. With the exact Nucleus session shape
minus its developer instructions, Codex emits a typed `plan` item with
`item/plan/delta` streaming; adding Nucleus's `TASK_TOOL_INSTRUCTIONS` (which
every chat session sends) suppresses it, because Codex replaces its built-in
plan-mode instructions — the only place the model learns the
`<proposed_plan>` convention — when the client supplies developer
instructions.

Resolution: `chat_developer_instructions`
(`crates/nucleus-server/src/local_codex_chat/runtime.rs`) appends a
Nucleus-authored proposed-plan addendum when the route harness mode is Plan.
Normal-mode instruction text is byte-identical to before. Unit coverage added;
`cargo test -p nucleus-server local_codex_chat` passes (70 tests). This is
prompt shaping, not provider payload parsing; the contract 030 boundary
stands. The card 086 native acceptance pass should now observe a pending
plan in the composer.

## Addendum: Plan-Terminal Turn Completion (card 088)

The first live plan-mode run after card 087 rendered the proposed plan but
failed the turn with "Codex completed the turn without an assistant
message": the model emitted only a `<proposed_plan>` block, Codex turned it
into a plan item, and the turn legitimately had no final assistant message,
which the adapter required. `AgentTurnReply.assistant_message` is now
`Option<String>` end to end; plan-mode turns may complete message-free (the
pending plan record is the outcome artifact per contract 019's Plan Decision
Rule), while normal mode keeps the requirement. Adapter, server, and desktop
suites pass.

## Addendum: Resource-Free Sentinel on Plan Accept (card 090)

The first live accept settled the decision and rendered the record, but the
Normal-mode follow-up turn failed with "project resource target not found:
resource:none" on resource-free quick chats: the stored session persists the
`resource:none` sentinel as its resource id, and the accept path resolves it
from the stored session, so the sentinel hit the resource lookup as a
literal id. `resolve_chat_working_context` now normalizes the sentinel to
resource-free for every caller. Focused server tests pass.
