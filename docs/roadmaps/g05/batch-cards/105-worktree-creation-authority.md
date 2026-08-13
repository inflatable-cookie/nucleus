# 105 Isolated Worktree Creation Authority And Runner

Status: dispatched
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 1 unblocker)
Depends on: nothing (unblocks 099)
Auto-start next card: no

## Objective

Wire the declared branch/worktree authority chain so a run dispatch can
create an isolated worktree through the gate the repo built for it —
instead of bypassing contracts 007/011. Card 099 stopped on this gate
(stop log `docs/logs/2026-08-13-operator-dispatched-runs.md`, merged
`279005f2`); the operator chose to wire the chain (2026-08-13).

## Governing Refs

- The stop log — full citations and the chosen option (option 1)
- `crates/nucleus-server/src/provider_git_branch_worktree_runner_authority/`
  — the declared gate: `ReadyForRunner` requires admitted execution
  handoffs, `GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed` with
  `allow_isolated_worktree_creation`, and policy-approved target refs;
  records currently persist `worktree_created: false` and nothing feeds
  the chain outside its own tests
- `docs/contracts/007-server-boundary-contract.md:1728-1729,1822-1823` and
  `docs/contracts/011-scm-forge-sync-contract.md:599-601,1067-1068` — the
  realized-boundary exclusions this card deliberately amends
- `docs/architecture/implementation-gap-index.md:765-775,1471-1474` — the
  audit posture being lifted for this one effect
- Contract 033 (draft) — run dispatch rides this gate

## Scope (planned)

1. **Contract text first.** Amend 007/011 realized-boundary passages to
   admit exactly one new effect: isolated worktree creation via the
   branch/worktree runner authority chain, operator-confirmed per dispatch.
   Everything else in those exclusions stays. Contract 033 gains the
   reference: run worktree creation is admitted only through this chain.
2. **Operator effect intent command.** A control command that records a
   durable `GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed`
   (carrying `allow_isolated_worktree_creation` and the exact target ref)
   for one dispatch. First git mutation on the control surface — admission
   per `nucleus-command-policy`.
3. **Runner execution.** The execution path the chain gates:
   `git worktree add ../<repo>-wt/<run-slug> -b run/<run-slug>` (playbook
   convention; `Command::new("git")` + `--no-optional-locks` pattern per
   `provider_git_read_only_runner/working_copy/mutation.rs:124`), invoked
   only when the chain reaches `ReadyForRunner`; the resulting record
   flips `worktree_created: true` with the receipt.
4. **Fixtures**: full chain (handoff + intent + policy → worktree created
   on disk in a temp repo), each blocker (no intent, wrong target,
   unconfirmed), idempotency/repeat-dispatch behavior, and the contract
   text amendments.
5. Batch log `docs/logs/2026-08-13-worktree-creation-authority.md`.

Out of scope: run dispatch itself (099 consumes this), branch deletion /
worktree cleanup, any other SCM mutation (commit/push keep their existing
gates), checkout/switch on the primary tree.

## Acceptance (planned)

- [ ] 007/011/033 text admits this one effect through the chain, nothing
  wider
- [ ] operator-confirmed intent + admitted handoff + approved target →
  worktree exists on disk with `worktree_created: true` and receipts
- [ ] every blocker path refuses with its named blocker; no intent, no
  worktree
- [ ] fixtures + server suite green; batch log

## Stop Conditions

- The chain's record shape cannot express the dispatch-time confirmation
  without weakening another blocker → stop with citations
- The contract amendment scope creeps beyond isolated worktree creation →
  stop and re-scope
