# Run Delivery Forge Pull Requests Implementation

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/103-run-delivery-forge-pull-requests.md`
Branch: `thread/103-run-delivery-forge-pull-requests`

## Outcome

Wired forge PR creation into the run delivery pipeline behind the merged
PR-creation authority (card 107). A forge-backed delivery now runs the full
spine: validation, durable per-delivery intent (now carrying the confirmed
PR-creation scope), gated commit/push, then — after the gated push — the forge
pull-request lane (`run_forge_pull_request_creation`) under the confirmed
intent, never a bare forge call. The run closeout appends `delivery:pr-created`,
`delivery:pr-reference`, and `delivery:pr-url` evidence (the reference and link
ride the run record exactly like commit/push evidence), and the host
notification surfaces the pull-request link when the lane produced one.

- `RunDeliveryExecutionCommand` carries an optional confirmed
  `pull_request_creation` scope (forge provider, base/head refs, title/body
  sources); the DTO layer mirrors the scope with sanitized DTO enums and the
  pipeline enforces the same scope validation the standalone delivery
  confirmation command applies (complete, head = the run's own branch, base
  differs)
- the delivery intent record is written with the confirmed scope; the
  preflight set is built from the pipeline's observed evidence (ready forge
  credential recorded, run branch pushed) with refs mirroring the scope
- the first implementation's admitted forge route is the forge test double
  configured to report that no real provider route is admitted yet; a
  confirmed PR-creation lane therefore records an honest
  `ProviderUnavailable` outcome and receipt, and the branch-only delivery
  stands until real provider routes get their own lane
- the desktop host derives the scope from the configured origin remote
  (provider inferred from the remote URL, base branch from the project's
  default branch), submits it with the delivery command, and after the
  synchronous delivery command returns reads the run closeout evidence and
  passes `delivery:pr-url` into the run-delivery notification. Publication
  stays host-owned; renderer code does not publish
- fallbacks keep the 101 branch-only packet with explaining receipts: no
  remote (no confirmed remote), no ready credential (preflight blocked with
  `ForgeCredentialNotReady`), PR API failure, and scope drift. The run stays
  delivered on its pushed branch in every case

Fixtures (handler-level, driving the real propose -> dispatch -> running ->
delivery flow with real git worktrees):

- PR-open happy path against the forge test double: reference + URL persist
  on the run closeout, completed receipt carries the link, one reconciliation
  + one open
- no-remote fallback: failed outcome and receipt ("no confirmed remote;
  branch-only delivery preserved"), zero adapter calls
- no-credential fallback: blocked outcome and receipt
  (`ForgeCredentialNotReady`), zero adapter calls
- PR API failure: failed outcome and receipt, branch delivered
- default adapter: unavailable-route outcome and receipt
- scope rejection (head branch not the run's own branch)
- DTO round-trip for the delivery command with PR scope
- preflight builder unit tests (ready / credential blocker / visibility
  blocker) and default-adapter behavior
- desktop notification tests: delivery with a PR link surfaces the URL;
  without one keeps the branch summary

## Authority boundary

The pipeline never spawns or calls the forge directly: PR creation runs only
through `run_forge_pull_request_creation` behind the durable confirmed intent
carrying the scope, with the authority chain's preflight and idempotency
reconciliation intact. No merge, comment, label, reviewer, review-sync,
branch-mutation, or stacked-run authority was added. Credential readiness is
the persisted forge credential-status refresh evidence (host-provider
credential boundary); the first implementation treats any ready recorded
credential as ready — provider-specific credential records are a later lane.

## Validation

- `cargo test -p nucleus-orchestration -p nucleus-server` — green
  (orchestration 22; server 2101 + 14 ignored; ratchet 1)
- `cargo test -p nucleus-server --test module_ratchet` — green (323, unchanged;
  the new preflight/adapter helpers live as a submodule of
  `provider_forge_pull_request_runner_authority`)
- `cargo test -p nucleus-desktop` — green (101)
- `effigy qa:docs` — all checks pass (links, vision index, roadmaps
  next-action, forbidden)
- `bun run check` in apps/desktop — 0 errors (generated bindings)
- `bun run test` in apps/desktop — 30 passed; the known pre-existing
  settingsDialog tabindex vitest failure remains

## Not touched

No roadmap, milestone, card, or dispatch status files. No swallowtail,
longhorn, or poodle sources. No renderer (Svelte/TS) sources — the desktop
changes are host-side (`src-tauri`) plus the generated control DTO bindings.
