# Orchestrator Designation And Delegation Tools

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/104-orchestrator-designation-and-delegation-tools.md`
Branch: `thread/104-orchestrator-designation`

## Outcome

Implemented the phase-3 capstone: the operator designates a provider
instance as a project orchestrator with a deny-by-default grant envelope, and
that agent's sessions receive the delegation verbs — `delegate`,
`run_status`, `cancel_run`, `accept_delivery`, `reject_delivery` — as server
tools over the run registry, admitted per the envelope. `message_run` /
steering stays phase 4 per the card.

### Designation aggregate (engine-owned, `nucleus-engine/src/designations/`)

`EngineOrchestratorDesignation` binds a provider instance to a project with
the contract-033 grant envelope: allowed worker provider instances and
models, concurrent-run budget, per-run token/time budget caps, allowed
delegation actions, steering flag (recorded for phase 4), and an
Active/Revoked status. Designate (create or replace-at-revision) and Revoke
are commands; the engine service enforces revision expectations and
deny-by-default shape. Revocation is one-way and blocks new delegation;
running work is untouched.

- Persistence rides the phase-1 pattern end to end: `PersistenceDomain::
  OrchestratorDesignations` / `PersistenceRecordKind::OrchestratorDesignation`
  in `nucleus-core`, SQLite table + kind codec + schema + domain boundary in
  `nucleus-local-store`, `ServerStateDomain::OrchestratorDesignations` facade
  in `nucleus-server`.
- Commands ride the contract-018 spine with an additive
  `OrchestrationCommandFamily::OrchestratorDesignation`; every accepted
  designation/revocation writes a contract-020 receipt. The module ratchet is
  unchanged (323): all new server logic landed as nested modules of
  `request_handler` and `local_codex_chat`.
- Query surface: `orchestrator_designations` control query (`list`, optional
  provider-instance filter) returning the envelope plus the persisted
  revision the desktop needs to re-designate or revoke.
- The designation surface refuses tool-incapable routes with the reason: the
  provider catalogue now carries `tool_capable` + `tool_capable_reason`,
  computed from the 2026-08-13 realization matrix (Codex
  `codex-app-server` qualifies; Anthropic Messages/DeepSeek qualify at
  drafting time but are not registered in this repo; CLI/ACP routes — claude-
  agent, gemini, kimi, cursor, opencode, pi, oh-my-pi — do not). Deny-by-
  default.

### Delegation tools (server-side, `local_codex_chat/delegation.rs`)

- The five verbs are declared through the existing dynamic-tool channel
  (the `task_ledger` path) only when the session's project has an active
  designation binding the session's provider instance. Tool-set presence is
  part of session identity: a designation created/revoked since the session
  started forces a restart with migration context (the Codex channel cannot
  redeclare tools on resume — runtime.rs comment cites this; per-session
  declaration at start is the scoping point). A non-designated session never
  receives the verbs, and every call re-validates against the envelope.
- Every call is validated before dispatch: action in the envelope, worker
  provider/model in the allowlists, requested budgets within per-run caps,
  concurrent-run budget counted from non-terminal runs owned by the
  designation. Refusals are tool results AND durable `ToolCall` receipts
  (Blocked); accepted calls write Completed receipts — the contract-033
  audit trail for every delegation decision.
- `delegate`: envelope validation → propose → operator-confirmed dispatch
  through the gated branch/worktree runner (the designation is the recorded
  actor, never the operator) → worker brief seed (the worker's first chat
  turn runs to completion; the run transitions `dispatched -> running` from
  observed provider activity) → delivery through the run delivery pipeline
  (validation, commit, push when an origin remote exists). PR creation stays
  operator-side: `pull_request_creation: None` for delegated runs (the
  per-delivery PR confirmation is an operator act; deny-by-default).
- `run_status` reads one run or the project fleet. `cancel_run` and
  accept/reject dispositions are refused for runs not delegated by the
  designation (operator runs and other designations' runs are not
  touchable), with the engine enforcing lifecycle transitions.

### Chat turn restructure (`local_codex_chat/turn.rs`)

The chat service's turn core became non-generic (`send_turn_inner` over
`dyn` callbacks) behind the existing generic public wrapper, and the session
is taken out of the map for the duration of a turn. That makes the
`delegate` worker-brief seeding safely reentrant: the seeder calls back into
the same service for the worker conversation (activity persistence and
run-transition hooks intact) without aliasing the session map or
instantiating an unbounded closure-type chain. Worker activities persist to
the run thread; the orchestrator panel sees the tool call.

### Desktop

- `OrchestratorDesignationDialog.svelte` (header action beside "Dispatch
  run"): picks the orchestrator instance from tool-capable routes (refused
  routes listed with the contract-041 reason), allowlists worker
  providers/models, sets concurrent/per-run budgets, allowed actions, and
  the steering flag; updates replace the envelope at the recorded revision;
  revoke is one click.
- Agent chat panel: orchestration-mode badge when the session's
  (project, provider instance) has an active designation; re-queried on
  route change and on `nucleus:designations-changed`. Delegation tool calls
  render as ordinary tool activity in the transcript (generic path).
- `control/designations.ts` control client; provider-instance type gained
  `tool_capable` / `tool_capable_reason`; TS bindings regenerated via
  `TS_RS_EXPORT_DIR` (`ControlOrchestratorDesignationDto`,
  `ControlDelegationActionDto`).

## Fixtures

Server-side, driving the real stack:

- designation admission (designate + spine event + receipt), revoke
  (blocks new delegation, double-revoke rejected), duplicate designate
  conflict, envelope replacement at recorded revision
- envelope rejection for each axis (action, worker provider, worker model,
  per-run budget cap) with Blocked receipts, concurrent-run budget
  exhaustion failing closed
- each verb's happy path: run_status (one + fleet), cancel_run (owned run
  cancelled; operator run refused), accept/reject dispositions (delivered
  runs, explicit recorded rejection reason)
- `delegate` happy path through the REAL authority chain: git repo, gated
  isolated-worktree creation, worker brief seed (fixture seeder marking
  running from observed truth), delivery pipeline commit/push, designation
  ownership on the delivered run
- tool-incapable route refusal (realization matrix predicate)

## Decisions Recorded

- **Synchronous delegate**: `delegate` dispatches and runs the worker's
  first turn to completion before returning, then delivers — mirroring the
  operator dispatch dialog's synchronous flow. Phase 4's steering/concurrency
  polish is where this changes.
- **No PR creation for delegated runs**: the per-delivery PR confirmation is
  an operator act; delegated runs deliver branch-only (pushed where a remote
  exists), and the orchestrator reviews/accepts through the verbs.
- **Orchestrator attribution**: dispatch and delivery intents record the
  designation id as the actor, never the operator (contract attribution
  rule).
- **`run_status` is project-scoped** (the fleet), including operator runs —
  the orchestrator manages the project's run board.

## Validation

- `cargo test --workspace --exclude nucleus-desktop` — green (server 2144
  passed + 14 ignored, engine 122, orchestration 22, local-store 20,
  ratchet 1, rest passing). `nucleus-desktop` excluded per the known
  pre-existing `tauri::generate_context!`/`dist` environment requirement.
- `cargo test -p nucleus-server --test module_ratchet` — green (323,
  unchanged).
- `TS_RS_EXPORT_DIR=… cargo test -p nucleus-server export_bindings` — exit
  0; generated `ControlCommandDto.ts`, `ControlQueryDto.ts`,
  `ControlResponseBodyDto.ts` updated, new `ControlOrchestratorDesignationDto.ts`
  + `ControlDelegationActionDto.ts`.
- `bun run check` in apps/desktop — 0 errors, 0 warnings.
- `bun run test` in apps/desktop — 37 passed; the known pre-existing
  settingsDialog tabindex vitest failure remains.
- `effigy server:smoke` — exit 0 (bootstrap includes the new designations
  table).
- `effigy qa:docs` — passed.
- `git diff --check` — passed.

## Not touched

No roadmap, milestone, card, or dispatch status files. No swallowtail,
longhorn, or poodle sources. No renderer-side Tauri host changes were needed
(designation commands ride the control envelope). Stop conditions did not
trigger: the dynamic-tool channel scopes declarations per session start (and
session identity includes the tool set), and grant enforcement is fully
server-side with no provider cooperation required.
