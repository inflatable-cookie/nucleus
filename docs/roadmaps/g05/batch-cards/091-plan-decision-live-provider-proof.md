# 091 Plan Decision Live Provider Proof

Status: completed
Owner: Tom
Created: 2026-08-10
Milestone: `../025-plan-decision-agent-chat.md`
Depends on: card 086
Branch: `thread/091-plan-live-proof`

## Worker Rules

- You are an execution worker. Execute this card exactly — scope, steps,
  acceptance criteria, stop conditions. No planning authority.
- Do NOT spawn sub-agents or parallel research tasks; read sources directly.
- Do NOT touch roadmap, milestone, card, or dispatch status files. Write only:
  the deliverables listed in Scope, your batch log, and PAPERCUTS.md friction
  notes if you hit any.
- External/provider APIs are authoritative over this card's assumptions. A
  mismatch is a stop-condition finding with citations, not something to
  work around.
- Commit your work on the branch above and push with
  `git push -u origin thread/091-plan-live-proof`. Do not merge.

## Governing Refs

- `docs/contracts/019-conversation-timeline-contract.md` — Plan Decision Rule
  and Thread Deletion Rule
- `docs/contracts/026-open-ended-planning-conversation-contract.md` — Plan
  Decision Promotion Rule
- `docs/contracts/030-swallowtail-agent-runtime-integration-contract.md`
- Cards 085, 086, 088, 090 (same directory) — the implemented behavior being
  proved
- `crates/nucleus-server/src/local_codex_chat/tests.rs` — live-test pattern
  (`#[ignore = "requires a locally authenticated Codex app-server"]`, e.g.
  `live_chat_keeps_follow_up_turns_on_one_thread`)

## Scope

Two ignored live integration tests in
`crates/nucleus-server/src/local_codex_chat/tests.rs` (or a sibling live
module if the file's structure prefers it), proving the plan-decision flow
against the real Codex app-server. Nothing else in the crate changes. If a
test reveals a production bug, STOP and report it — do not fix production
code.

Out of scope: `apps/desktop` (all of it), Poodle, Longhorn, Swallowtail
sources, any status/roadmap file, any existing test.

## Environment Notes (read before building)

- Copy `.cargo/config.toml` verbatim from the main checkout
  (`/Users/tom/Dev/projects/nucleus/.cargo/config.toml`) into this worktree
  before the first build. It patches swallowtail to the local sibling, which
  carries a fix (late activity correlation adoption) that 0.147.0 tool-call
  turns need. Without it the build uses the v0.2.0 tag and live tool calls
  will crash the turn.
- The tests run live against the operator's authenticated Codex app-server.
  They must stay `#[ignore]`d so routine suites never touch the network.

## Steps

1. Copy the cargo patch config (Environment Notes). Build the test target:
   `cargo test -p nucleus-server --no-run`.
2. Write `live_plan_decision_dismiss_settles_without_follow_up`:
   - temp sqlite state (`tempfile::tempdir` + `ServerStateService::new` +
     `SqliteBackend`, following the existing live tests' setup)
   - seed a transient project and start a Plan-mode chat conversation;
     send a message certain to produce a proposed plan, e.g. "Plan how to
     make a cup of tea, then present the final plan." (Plan mode plus the
     harness instructions make Codex emit a typed plan item.)
   - after the turn completes, assert `read_history(...).plan_decisions`
     contains exactly one decision with status `pending`; capture its
     `turn_id`, `runtime_operation_id`, `activity_id`
   - call `LocalCodexChatService::decide_plan` with decision `dismissed`
   - assert the decision settles to `dismissed`, no follow-up turn exists,
     and a fresh `ServerStateService` over the same sqlite file still shows
     the settled decision
3. Write `live_plan_decision_accept_drives_normal_mode_follow_up`:
   - same setup, fresh conversation; Plan-mode send producing a plan
   - decide `accepted`
   - assert: decision settled `accepted` with `accept_turn_id` set; the
     accept follow-up turn completed; the follow-up ran in Normal harness
     mode (check the follow-up reply's `harness_mode`); a fresh state
     service over the same file shows both turns and the settled decision
4. Run exactly these tests, never the whole ignored suite:
   `cargo test -p nucleus-server live_plan_decision -- --ignored --nocapture`
5. Write the batch log (Evidence below).

## Acceptance Criteria

- Both tests exist, compile, and are `#[ignore = "requires a locally
  authenticated Codex app-server"]`
- Both tests pass live, in one process run of the command in step 4
- Assertions cover: pending persistence, exactly-once settle, dismiss
  leaves no follow-up, accept records `accept_turn_id` and drives a
  completed Normal-mode follow-up turn, and post-reopen read-back truth
- The batch log records the exact commands and their exit states, plus the
  model/effort the live run used

## Evidence

- Batch log at `docs/logs/2026-08-10-plan-decision-live-provider-proof.md`:
  commands + exit states, the live run's salient output (turn ids, decision
  statuses), and anything you could not verify. No recommendation needed —
  the planner rules from the log.

## Closeout

Merged `e8cbe60a` via `95e89935`. Both live tests pass on the merge result
under an independent orchestrator re-run (2 passed, 17.1s). Worker finding
ruled correct: the card's Environment Notes were stale — `Cargo.toml` pins a
swallowtail rev that already contains the late-correlation fix, so the
cargo patch is no longer load-bearing. Recorded in PAPERCUTS.md.

## Stop Conditions

- No authenticated Codex app-server is reachable → stop, record the probe
  output
- The provider does not emit a typed plan after one retry with a more
  explicit prompt → stop with the turn evidence
- Any API or behavior contradicts this card (including the cards/refs it
  cites) → stop with citations
- You feel scope pressure toward production-code changes → stop and report
  the finding instead
