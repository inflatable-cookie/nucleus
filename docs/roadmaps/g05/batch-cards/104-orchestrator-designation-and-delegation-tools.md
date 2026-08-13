# 104 Orchestrator Designation And Delegation Tools

Status: planned
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 3)
Depends on: 099 (operator-dispatched runs), 101 (delivery pipeline); phase
  2 cards 102-103 recommended first
Auto-start next card: no

## Objective

The feature as titled: the operator designates a provider instance as a
project orchestrator, and that agent's session gains the delegation verbs —
`delegate`, `run_status`, `cancel_run`, `accept_delivery`,
`reject_delivery` — implemented as nucleus server tools over the run
registry, admitted per the grant envelope. (`message_run` is phase 4 with
steering.)

## Governing Refs

- Contract 033 (draft) — Orchestrator Designation Rule (grant envelope,
  deny-by-default, tool-capable route requirement) and Delegation Action
  Rule (pre-dispatch validation, explicit recorded rejection, no operator
  impersonation)
- Swallowtail contract 041 §Consumer Tool Exchange — native client tools;
  the realization matrix in the translation memo (Codex, Anthropic,
  DeepSeek qualify; CLI/ACP routes do not)
- `crates/nucleus-agent-adapters/src/swallowtail_codex/tools.rs` — the
  existing dynamic-tool declaration path (`task_ledger` precedent)
- The 2026-08-13 decision: orchestrator is a mode of the agent chat panel

## Scope (planned)

- Designation: per-project operator setting binding a provider instance +
  grant envelope (allowed worker providers/models, budgets, allowed
  actions); the designation surface refuses tool-incapable routes with the
  reason.
- Delegation tools: server-side implementations against the run registry,
  declared to the orchestrator session through the existing dynamic-tool
  channel only when the session's project has a designation; every call
  validated against the envelope before dispatch; rejections returned as
  tool results AND recorded as receipts.
- Agent chat panel: orchestration mode indicator and the delegation tool
  calls rendered as ordinary tool activity in the transcript.
- Budget enforcement: concurrent-run and per-run budgets fail closed with
  visible receipts.
- Fixtures: designation admission, envelope rejection, each verb's happy
  path, budget exhaustion, tool-incapable route refusal.

Out of scope: `message_run` / steering (phase 4), agent-initiated merge,
cross-project orchestration.

## Acceptance (planned)

- [ ] operator designates an orchestrator per project with a grant envelope
- [ ] the orchestrator session receives the delegation verbs; a
  non-designated session never does
- [ ] every verb validates against the envelope pre-dispatch; rejections
  are tool results + receipts
- [ ] budgets fail closed and visibly
- [ ] fixtures + suites green; batch log

## Stop Conditions

- The dynamic-tool channel cannot scope declarations per session/project →
  stop with citations
- Grant enforcement would need provider-side cooperation the routes don't
  offer → stop and report
