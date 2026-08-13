# Forge PR-Creation Authority

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/107-forge-pr-creation-authority.md`
Branch: `thread/107-forge-pr-creation-authority`

## Outcome

- amended contract 027 to admit exactly one real forge network write: pull-request
  creation for a delivered run through an operator-confirmed per-delivery intent
  (the "later explicit lane" the 103 stop log reserved). The lane carries the full
  spine: admission with operator approval ref and idempotency key, preflight
  (credential ready, remote branch visible, target refs matching prepared
  evidence), idempotency reconciliation against provider state before any open,
  sanitized PR-created evidence, receipts, and fallback discipline (no remote, no
  ready credential, or PR API failure keeps the branch-only delivery with an
  explaining receipt). Explicitly no merge, comment, label, reviewer, review-sync,
  branch-mutation, or stacked-run authority; `pull-request or merge-request update`
  and every other mutating family stay admission-only
- amended contracts 007/011/033 narrowly: the realized exceptions and the Run
  Delivery Authority Rule now admit the per-delivery confirmation carrying
  PR-creation scope (forge provider, base/head refs, title/body sources) on top of
  the confirmed remote, through the dedicated forge pull-request runner authority
  chain; every other rejection in those lists stays
- extended the durable per-delivery confirmation (`GitBranchWorktreeRunnerDeliveryEffectConfirmationCommand` /
  `GitBranchWorktreeRunnerDeliveryIntentRecord`) with an optional
  `pull_request_creation` scope; the confirmation command validates the scope
  (complete, head = the run's own branch, base differs) and the idempotency
  conflict check compares the scope so the same key bound to different PR targets
  conflicts
- wired the forge pull-request runner authority chain to execution: the
  `PullRequestCreationConfirmed` intent variant reaches `ReadyForCreation`
  (record and set gain `pull_request_creation_permitted`) when preflight is ready
  and the confirmed scope matches the preflight refs; creation/forge-request flags
  no longer block under the confirmed intent, while provider effects, raw output
  retention, callbacks, interruption, recovery, and task mutation stay blocked;
  scope drift blocks with `PullRequestCreationScopeMismatch`, incomplete scope with
  `PullRequestCreationScopeMissing`
- landed the gated execution path (`run_forge_pull_request_creation`): reads the
  durable delivery intent, requires the PR-creation scope, evaluates the authority
  chain, replays a persisted completed/reconciled outcome without any provider
  call, reconciles against provider state (adopt an existing PR for the head
  branch before any new open), then calls the admitted forge adapter test double
  (`ForgePullRequestCreationTestDouble`, shared call counters) for the open.
  Success persists a completed outcome (reference + URL, `pull_request_created`,
  `forge_effect_executed`) and a contract-020 receipt carrying the link; no
  remote, preflight-blocked (no credential), scope drift, reconciliation failure,
  or PR API failure persists a failed/blocked outcome with an explaining receipt
  and keeps the run delivered on its pushed branch. Failed/blocked outcomes may be
  superseded by a later attempt; completed/reconciled outcomes never re-open
- PR reference and link are run delivery evidence: the fixture drives a run
  propose -> dispatch -> running -> deliver through the engine run command service
  and asserts the closeout evidence refs carry the reference and URL on the run
  record (the 103 pipeline integration appends them exactly like commit/push
  evidence today)
- fixtures: happy path (PR opened, reference + URL persisted, receipt with link,
  one reconcile + one open), idempotent re-delivery (replay, no duplicate PR, no
  second provider call, no duplicate receipt), reconciliation (existing PR adopted,
  zero opens), each fallback (no remote, no credential preflight, PR API failure)
  with explaining receipts, each new blocker (missing intent, no scope, scope
  drift, creation widening), retry-after-failure reconciling instead of duplicating
- module ratchet respected: no new top-level server modules (323, unchanged);
  execution, adapter, and outcome persistence live as submodules of
  `provider_forge_pull_request_runner_authority`

## Evidence

- `cargo test -p nucleus-orchestration -p nucleus-server`: green (orchestration
  22; server lib 2087 + 14 ignored; module ratchet 1)
- `cargo test -p nucleus-server --test module_ratchet`: passes at 323
- `effigy qa:docs`: all checks pass (links, vision index, roadmaps next-action,
  forbidden)

## Not touched

No roadmap, milestone, card, or dispatch status files. No swallowtail, longhorn,
or poodle sources. The 103 pipeline integration itself (running
`run_forge_pull_request_creation` after push and appending the PR evidence to the
run closeout) is re-dispatched after this merges, per the card's scope.
