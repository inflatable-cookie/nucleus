# Plan Decision Live Provider Proof

Date: 2026-08-10
Card: `docs/roadmaps/g05/batch-cards/091-plan-decision-live-provider-proof.md`
Branch: `thread/091-plan-live-proof`

## Outcome

Two ignored live integration tests were added to
`crates/nucleus-server/src/local_codex_chat/tests.rs`, proving the
plan-decision flow against the real authenticated Codex app-server:

- `live_plan_decision_dismiss_settles_without_follow_up`
- `live_plan_decision_accept_drives_normal_mode_follow_up`

Both pass in one process run of the card's step-4 command. No production
code changed. No existing test changed.

## Commands And Exit States

1. `cargo test -p nucleus-server --no-run` — exit 0 (built after the
   swallowtail patch; 22 pre-existing warnings, untouched).
2. `cargo test -p nucleus-server live_chat_model_catalog_exposes_reasoning_options -- --ignored --nocapture` — exit 0. Authentication probe: the prepared Codex facade discovered instance `codex:local-default` with 7 models, so the app-server is reachable and authenticated.
3. `cargo test -p nucleus-server live_plan_decision -- --ignored --nocapture` — exit 0; `2 passed; 0 failed` in 22.83s.
4. `cargo test -p nucleus-server --test catalogue_probe -- --ignored --nocapture` — exit 0 (throwaway probe, deleted before commit). Live catalogue: `gpt-5.4-mini` has `default_reasoning_effort = medium`, supported efforts `[high, low, medium, xhigh]`.

## Live Run Evidence

Requests left `model` and `reasoning_effort` unset, so `selected_route`
applied the catalogue defaults: model `gpt-5.4-mini`, reasoning effort
`medium`.

Deterministic identity (transient project ids derive from the idempotency
keys used by the tests):

- Dismiss conversation: `project:4dad069fe44885d91069eaf4:panel:plan-dismiss-live`
  - turn 1 (Plan mode, proposed plan): `turn:chat:project:4dad069fe44885d91069eaf4:panel:plan-dismiss-live:1`
  - decision: `pending` -> `dismissed`; exactly-once (repeat settle rejected with "Agent Chat plan is stale or already decided"); no follow-up turn; post-reopen read-back still `dismissed`
- Accept conversation: `project:23ea98f3fc3528659d4737b2:panel:plan-accept-live`
  - turn 1 (Plan mode, proposed plan): `turn:chat:project:23ea98f3fc3528659d4737b2:panel:plan-accept-live:1`
  - turn 2 (accept follow-up, Normal mode): `turn:chat:project:23ea98f3fc3528659d4737b2:panel:plan-accept-live:2`
  - decision: `pending` -> `accepted` with `accept_turn_id` == the turn-2 id; follow-up reply `harness_mode` == Normal and `timeline_turn_id` == `accept_turn_id`; both turns `completed`; post-reopen read-back shows both turns and the settled decision

Both tests asserted exactly one `pending` decision after the plan turn, so
no retry with the more explicit prompt was needed (a retry would have left
two turns, failing the `turns.len() == 1` assertion in the dismiss test).

The `runtime_operation_id` and `activity_id` on each pending record are
provider-native Swallowtail ids; the tests captured them from the persisted
pending record and echoed them into the decision request. The settle
succeeded under exact correlation — a mismatch fails with "Agent Chat plan
correlation does not match".

Transient quick-chat projects are resource-free, so the accept follow-up
exercised the `resource:none` sentinel path (card 090) live; it completed.

## Not Verified

- The proposed-plan snapshot text is not reproduced here: contract 030's
  proof-evidence policy excludes prompts and assistant output. The plan
  snapshot persisted and survived settle and reopen byte-for-byte per the
  assertions.
- The provider-native thread/run/activity ids themselves are not quoted;
  they are ephemeral per-run values and are not retained by design.

## Papercuts

- The main checkout's `.cargo/config.toml` (card Environment Notes, step 1)
  was absent at dispatch time — the `.cargo/` directory exists but is
  empty and the file is gitignored. Reconstructed per the card's own
  description: `[patch."https://github.com/inflatable-cookie/swallowtail"]`
  mapping `swallowtail-adapter-codex`, `swallowtail-core`,
  `swallowtail-host-local`, `swallowtail-idioms`, and
  `swallowtail-runtime` to `/Users/tom/Dev/projects/swallowtail/crates/*`.
  Recorded in `PAPERCUTS.md`.
- Note for the planner: the card's Environment Notes claim the unpinned
  build "uses the v0.2.0 tag" and that the pinned rev lacks the late
  activity correlation fix. Current state differs: `Cargo.toml` pins
  `rev = 1b19ccfe...`, which already contains the fix commit
  (`a941346f`), and the local sibling is only docs-ahead of that rev. The
  patch was still applied as instructed; the build and live run both
  succeeded.
- The active patch rewrites the five swallowtail entries in `Cargo.lock`
  to path sources on every cargo invocation. `Cargo.lock` was restored to
  the committed git-source state before commit; the patch file itself is
  gitignored machine-local state.

## Validation

- Step-4 command run: `2 passed; 0 failed` (one process run).
- `cargo test -p nucleus-server --no-run` after adding the tests: exit 0.
