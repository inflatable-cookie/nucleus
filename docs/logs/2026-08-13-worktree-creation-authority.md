# Isolated Worktree Creation Authority And Runner

Date: 2026-08-13
Lane: agent orchestration phase-1 unblocker (card 105)

## Outcome

- amended contracts 007/011 realized-boundary text to admit exactly one new
  effect: isolated worktree creation for a dispatched run through the
  branch/worktree runner authority chain, operator-confirmed per dispatch;
  every other exclusion in those lists stays (no primary-tree checkout, no
  branch mutation, no commit/push/PR/forge/provider/callback/recovery/task
  mutation, no raw output retention)
- contract 033 (draft) gained the Run Worktree Authority Rule: run worktree
  creation is admitted only through this chain
- added the operator effect intent confirmation control command
  (`ServerCommandKind::GitBranchWorktreeRunner`): rides the contract-018
  admission spine under the new `GitBranchWorktreeRunner` orchestration
  family, writes a durable
  `GitBranchWorktreeRunnerOperatorEffectIntent::Confirmed` record per
  dispatch (allow_isolated_worktree_creation + exact branch/worktree refs),
  and emits a contract-020 receipt; repeat dispatch replays, same key bound
  to a different target conflicts
- landed the gated execution path (`run_git_branch_worktree_runner`): reads
  the durable intent, evaluates authority + adapter, and spawns
  `git --no-optional-locks worktree add <location> -b <branch>` (playbook
  convention, working-copy mutation pattern) only at `ReadyForRunner`;
  success flips the persisted outcome record to `worktree_created: true`
  with a worktree-created receipt; blocker paths return their named blockers
  with no spawn and no worktree
- fixtures: full chain creates a real worktree on disk in a temp repo
  (verified via `.git` gitdir file, checked-out branch, bounded capture,
  receipt); every blocker path (no intent -> `OperatorEffectIntentMissing`,
  missing/stray target -> `MissingIsolatedWorktreeLocationRef` /
  `MissingRunnerTarget`, unconfirmed -> `IsolatedWorktreeCreationNotConfirmed`);
  repeat-dispatch replays the persisted outcome without a second spawn
- module ratchet respected: no new top-level server modules (323, unchanged);
  intent store and execution live as submodules of
  `provider_git_branch_worktree_runner_authority`
- outcome persistence now accepts execution evidence (gated to `Ready`
  commands) and diagnostics aggregate effect flags from records

## Evidence

- `cargo test -p nucleus-orchestration -p nucleus-server`: green
  (orchestration 22; server lib 2055 + 14 ignored; integration 1)
- `cargo test -p nucleus-server --test module_ratchet`: passes at 323
- `effigy qa:docs`: all checks pass (links, vision index, roadmaps
  next-action, forbidden)

## Next

Card 099 consumes this chain: run dispatch writes the confirmation command,
then invokes the gated execution path with the run's handoff chain and target
refs. Branch deletion / worktree cleanup and any wider SCM mutation remain
out of scope, as does checkout/switch on the primary tree. The architecture
audit text (`docs/architecture/implementation-gap-index.md`) still describes
the chain as spawn-free; it lags this card's realized exception.
