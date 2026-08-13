# Run Delivery Forge Pull Requests — STOPPED at forge PR-creation authority gate

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/103-run-delivery-forge-pull-requests.md`
Branch: `thread/103-run-delivery-forge-pull-requests`

## Outcome

Card stopped before implementation. The card's stop condition fires: contract
027's admission does not cover agent-initiated PR creation. PR creation is a
real provider network write; 027's Initial Implementation Gate still blocks it,
the realized authority surfaces stop at PR *request preparation* (never
creation), and the 106 per-delivery operator confirmation grants exactly
commit + push of the run's own branch. No code was written. No forge call,
credential resolution, or PR creation was attempted.

The 101 pipeline machinery (validation hook, delivery intent, gated
`git add`/`git commit`/`git push`) is unchanged and remains the branch-only
delivery path.

## Findings

### 1. Contract 027 admits the PR-create family but blocks its execution

The effect taxonomy lists `pull-request or merge-request create` as an initial
mutating family (`docs/contracts/027-provider-auth-forge-execution-contract.md:135`),
so the family is not deferred like merge. But the Initial Implementation Gate
is explicit that actual PR creation is not admitted yet:

- the first implementation after the contract is "stopped by default"
  (`027:534-536`);
- the blocked list includes "pull-request creation" (`027:553`);
- "Real provider network writes require a later explicit lane after stopped
  admission, preflight, receipts, idempotency, and recovery surfaces are
  proven" (`027:560-561`).

PR creation is precisely a real provider network write. The stopped admission /
preflight / request-preparation surfaces exist (see finding 4), but no later
explicit lane admitting PR creation does.

### 2. 027 requires its own operator approval; none exists for PR creation

027's Authority Rule separates domains: "A prepared PR request does not grant
PR creation. A PR creation approval does not grant merge, comment, label,
reviewer, or branch mutation authority" (`027:40-43`). Preflight for mutating
effects requires "operator approval present and current" (`027:195`) and
admission records carry an "operator approval ref for mutating effects"
(`027:172`).

The only forge-PR operator intent that exists confirms *request preparation*
(`ForgePullRequestRunnerOperatorEffectIntent::Confirmed { allow_request_preparation }`,
`crates/nucleus-server/src/provider_forge_pull_request_runner_authority/types.rs:96`),
never creation. The 106 per-delivery confirmation (finding 3) is a commit/push
grant. By 027's own domain-separation rule it does not extend to PR creation.

### 3. The 106 delivery authority admits exactly commit + push

Contract 033's Run Delivery Authority Rule admits `git add` / `git commit` in
the run's isolated worktree, then `git push <remote> <run-branch>`, through a
distinct operator-confirmed per-delivery intent carrying the commit message,
branch ref, worktree location, and remote target. "A push failure preserves the
local commit and records an explaining failed push receipt; it does not make
the delivery authority wider" (`docs/contracts/033-orchestration-runs-and-delegation-authority-contract.md:55-66`).

The Delivery Rule describes delivery as "the branch is committed and pushed
with a PR opened" (`033:111-115`) and the per-delivery confirmation "is the
explicit grant for pushing only that run's own branch; it does not grant
force-push, branch deletion, or any other shared-remote mutation"
(`033:121-123`). As with the card-101 finding, the delivery *description*
does not amend the realized gates: no PR-creation scope exists in the delivery
confirmation or its durable intent record.

### 4. Every realized authority surface hard-blocks PR creation

- Contract 007 realized exceptions admit exactly worktree add plus per-run
  add/commit/push; "pull-request, forge, provider, callback, interruption,
  recovery, task mutation, or raw-output retention is admitted by these
  exceptions" — i.e. they stay rejected
  (`docs/contracts/007-server-boundary-contract.md:1738-1757`).
- Contract 011's realized exceptions admit the same two effects; "it does not
  grant provider API or forge authority under contract 027. Provider/forge
  mutation stays false" (`docs/contracts/011-scm-forge-sync-contract.md:600-620`).
- The 106 closeout log records the unchanged exclusion: "no ... pull request,
  merge, forge/provider/callback/recovery/task mutation, or raw output
  retention was admitted"
  (`docs/logs/2026-08-13-run-delivery-commit-push-authority.md`).
- The Git branch/worktree runner unconditionally blocks
  `PullRequestRequested` and `ForgeEffectRequested` when requested
  (`crates/nucleus-server/src/provider_git_branch_worktree_runner_authority/blockers.rs:134-139`).
- The forge PR runner is deliberately stopped at request preparation: module
  doc "Stopped authority records for forge pull-request request preparation"
  (`crates/nucleus-server/src/provider_forge_pull_request_runner_authority.rs:1`),
  status `ReadyForRequest` (`types.rs:66`), `pull_request_creation_requested`
  and `forge_effect_requested` produce `PullRequestCreationRequested` /
  `ForgeEffectRequested` blockers
  (`provider_forge_pull_request_runner_authority/blockers.rs:71-80`), and
  preflight records hardcode `pull_request_created: false` /
  `forge_effect_executed: false`
  (`crates/nucleus-server/src/provider_forge_pull_request_execution_preflight.rs:94-95,141-142`).
- No forge test double for PR creation exists (`ForgeScmNoEffects` is a
  no-effects marker), so the card's planned PR-open fixture has no admitted
  execution surface to exercise.

## Stop-condition result

Card 103's stop condition fires: "Contract 027's admission does not cover
agent-initiated PR creation." The admission surfaces prove the stopped
admission/preflight/request-preparation spine only; PR creation requires a
later explicit lane with its own operator approval, idempotency, receipts, and
recovery per `027:534-561`. Implementing PR creation now would require
bypassing the 007/011/033 realized gates or silently widening the per-delivery
confirmation. Neither is permitted.

The validation hook was not run: this is an authority stop before
implementation, not a test failure. No crate was modified, so no cargo suite
is affected; the module ratchet and `effigy qa:docs` were run to validate the
docs-only change (batch log).

## Not touched

No roadmap, milestone, card, or dispatch status files. No swallowtail,
longhorn, or poodle sources. No Rust, TypeScript, or UI code. The 102 review
surface worktree and the fleet/review desktop UI were not touched.

## Recommended next move

Amend the authority surface in a separate policy card before re-dispatching
103:

- contract 027: admit an operator-confirmed per-delivery PR-creation effect as
  the "later explicit lane" — admission record with operator approval ref,
  preflight (credential ready, network authority, idempotency, retry/recovery,
  sanitization), idempotency reconciliation against provider state, receipts,
  and sanitized PR-created evidence; explicitly not granting merge, comment,
  label, reviewer, or branch mutation;
- contracts 007/011/033: extend the realized exceptions and the per-delivery
  confirmation so it can carry PR-creation scope (forge provider, base/head
  refs, title/body sources) on top of the confirmed remote;
- then implement: PR open after the 101 push via a forge runner execution
  path, PR reference stored on the run record, notification link, and the
  fallbacks (no remote / no credential / PR API failure keeps the branch
  delivered with an explaining receipt).

Keep merge, comment, and review-sync authority out of scope per the operator
merges decision (`docs/research/translation-memos/agent-orchestration-lane.md`
Decisions 2026-08-13).
