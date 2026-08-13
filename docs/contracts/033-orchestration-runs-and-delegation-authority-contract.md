# 033 Orchestration Runs And Delegation Authority Contract

Status: draft
Owner: Tom
Updated: 2026-08-13

## Purpose

Define managed delegation in Nucleus: an operator-designated orchestrator
agent that dispatches work to worker agents as harness-owned runs, and the
authority, lifecycle, delivery, and review rules those runs follow.

A run is a first-class operation bound to a worktree and a run record. It is
not a provider-owned child thread; swallowtail contract 045 governs
provider-internal child work and does not apply to runs except where a
worker's own provider spawns children inside it.

Governing evidence and design translation:

- `../research/source-hubs/harness-agent-orchestration.md`
- `../research/translation-memos/agent-orchestration-lane.md`
- `018-orchestration-contract.md` (command, event, projection, receipt spine)
- `032-longhorn-desktop-systems-integration-contract.md` (consumer boundary)

## Run Record Rule

Every run has one durable run record carrying: objective (scope, acceptance,
stop conditions), worktree identity, provider instance and model, owning
orchestrator designation, operation and conversation identity, lifecycle
state, budget envelope, and closeout (summary, evidence, diff reference).

Lifecycle states: `proposed`, `dispatched`, `running`, `delivered`,
`accepted`, `rejected`, `failed`, `cancelled`. Every transition is a
command; every command produces an event; side effects (worktree creation,
commit, push, PR) produce receipts under contract 020.

A run without a closeout cannot be `delivered`. Structured completion is a
precondition of review by either an orchestrator agent or the operator.

## Run Worktree Authority Rule

Run worktree creation is admitted only through the Git branch/worktree runner
authority chain (`nucleus-server`
`provider_git_branch_worktree_runner_authority`). The operator confirms the
effect per dispatch with a control command that records a durable
`GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed` carrying
`allow_isolated_worktree_creation` and the exact target refs (branch ref and
worktree location) for that dispatch. The execution path runs
`git worktree add <location> -b <branch>` only when the chain reaches
`ReadyForRunner` — admitted execution handoff, operator-confirmed intent,
and policy-approved target refs — and the outcome record flips
`worktree_created: true` with a runtime receipt (contract 020). Commit and
push do not ride this dispatch confirmation.

## Run Delivery Authority Rule

Run delivery commit and push are admitted only through the same Git
branch/worktree runner authority chain, but use a distinct operator-confirmed
per-delivery intent. The delivery confirmation carries the commit message,
exact run branch ref, isolated worktree location, and confirmed project remote.
At `ReadyForRunner`, structured argv runs `git add` and `git commit` in the run's
isolated worktree, then `git push <remote> <run-branch>`; no shell text, force
push, branch deletion, primary-tree mutation, or ref beyond the run's own branch
is reachable. Each command has bounded capture, sanitized outcomes, and a
contract-020 receipt. A push failure preserves the local commit and records an
explaining failed push receipt; it does not make the delivery authority wider.

## Orchestrator Designation Rule

An orchestrator is a configured provider instance designated by the operator
for one project. The instance's route must realize consumer tool exchange
under swallowtail contract 041 (Codex, Anthropic Messages, and DeepSeek
routes qualify at drafting time; CLI/ACP routes do not). Designation carries
a grant envelope:

- allowed worker provider instances and models
- concurrent-run budget and per-run token/time budgets
- allowed delegation actions (delegate, message, cancel, accept, reject)
- whether worker steering is permitted

Grants are deny-by-default. An action outside the envelope is rejected
before dispatch with the refusal recorded. Designation is revocable;
revocation cancels no running work but blocks new delegation.

## Delegation Action Rule

The orchestrator acts only through harness-owned delegation tools:

- `delegate` — objective, provider, model, budget; returns a run id
- `run_status` — read one or all runs
- `message_run` — post into the worker conversation (when steering is
  granted)
- `cancel_run` — request cancellation with deadline truth
- `accept_delivery` / `reject_delivery` — disposition a delivered run

Each tool call is validated against the grant envelope before dispatch.
Rejection is explicit and recorded. No tool may impersonate the operator.

## Worker Operation Rule

A worker run executes as an ordinary operation on its own worktree. The
objective is the worker's brief. The operator may open any run as a thread
and interact with it directly; that interaction uses the ordinary
conversation path and needs no child-control authority.

Orchestrator messages inside a worker thread are attributed to the
orchestrator designation, never to the operator.

## Delivery Rule

`delivered` means: the worker finished, the closeout is written, the
validation hook ran, and the branch is committed and pushed with a PR opened
— or, where no forge is configured, the delivery packet is prepared: the
closeout, the branch (pushed where a remote exists), and a notification to
the operator. Review rides the existing diff/review workflow; a missing
forge never blocks delivery. Delivery is a pipeline with receipts at each
side effect.

Acceptance is a separate act from delivery. The default merge authority is
the operator: the orchestrator prepares and may recommend; the operator
merges. Agent-initiated merge remains separate. The per-delivery confirmation
above is the explicit grant for pushing only that run's own branch; it does not
grant force-push, branch deletion, or any other shared-remote mutation.

## Audit Rule

Every designation, grant change, delegation decision, refusal, delivery, and
disposition is a durable receipt. The fleet projection renders from
receipts, not from mutable run state alone.

## Open Questions

Resolved 2026-08-13 (see the translation memo's Decisions section):
operator-merge is the posture (agent-merge deferred to a later per-project
grant), workers start from fresh playbook-shaped briefs, the orchestrator
is a mode of the agent chat panel, and no-forge delivery is closeout +
branch + notification.
