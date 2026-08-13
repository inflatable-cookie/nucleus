# 106 Run Delivery Commit And Push Authority

Status: dispatched
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 1 unblocker)
Depends on: 105 (worktree-creation authority, merged `d85adc4d`)
Auto-start next card: no

## Objective

Extend the branch/worktree runner authority chain so a delivered run can
commit its worktree and push its branch — the two effects card 101 needs
and stopped for (stop log
`docs/logs/2026-08-13-run-delivery-pipeline.md`, merged `c9f618ec`). Card
105 admitted isolated worktree creation only; this card admits per-run
commit and remote push through the same chain, with the same
operator-confirmation discipline.

## Governing Refs

- The 101 stop log — citations for exactly which exclusions block delivery
- `docs/logs/2026-08-13-worktree-creation-authority.md` — how 105 shaped
  its amendment; mirror that shape
- `docs/contracts/007-server-boundary-contract.md` (the realized exception
  at :1738-1752), `011-scm-forge-sync-contract.md` (:599-611, :1068-1085),
  `033` Run Worktree Authority Rule — the amendment surfaces
- Contract 033 Delivery Rule: agent-initiated push to a shared remote
  requires an explicit grant — this card IS that grant mechanism:
  operator-confirmed per delivery, scoped to the run's own branch
- Cards 011-013 lineage — the working-copy stage/commit functions
  (`provider_git_read_only_runner::working_copy`) run `git add`/`git
  commit` in tests but have no request-handler callers; this card puts
  commit on the control surface through the authority chain, not around it

## Scope (planned)

1. **Contract text.** Extend the 007/011 realized exceptions and 033's
   authority rule: per-run `git add`/`git commit` in the run's isolated
   worktree, and `git push` of the run's own branch to the project remote.
   Both ride the branch/worktree runner authority chain with a durable
   operator-confirmed intent per delivery (distinct from the dispatch-time
   worktree intent). Explicitly still excluded: commit/push on the primary
   tree, force-push, branch deletion, PR creation, merge, and any ref
   beyond the run's own branch.
2. **Confirmation.** The delivery-time confirmation carries the commit
   message, the run's branch ref, and the remote target; replay-safe like
   the 105 intent.
3. **Execution.** Gated `git add` + `git commit` + `git push` in the run
   worktree through the runner path (structured argv, bounded spawn,
   sanitized outcome, receipts). Push failure leaves the run deliverable —
   branch committed locally, receipt explains.
4. **Fixtures**: full chain against a temp repo with a local bare remote;
   every blocker; push-failure semantics; intent replay.
5. Batch log `docs/logs/2026-08-13-run-delivery-commit-push-authority.md`.

Out of scope: the delivery pipeline itself (101 consumes this), PR
creation (103), merge authority, primary-tree mutations of any kind.

## Acceptance (planned)

- [ ] contract text admits per-run commit + own-branch push through the
  chain, nothing wider
- [ ] operator-confirmed delivery intent gates both effects; replay-safe
- [ ] push failure preserves `delivered` with an explaining receipt
- [ ] fixtures + server suite + ratchet green; batch log

## Stop Conditions

- Admitting push weakens an existing remote/write gate (contract 027
  territory) → stop with citations
- The intent record shape cannot carry delivery confirmation without
  weakening the 105 blockers → stop with citations
