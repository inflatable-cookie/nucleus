# Run Delivery Commit And Push Authority

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/106-run-delivery-commit-push-authority.md`
Branch: `thread/106-run-delivery-commit-push-authority`

## Outcome

- amended contracts 007/011/033 to admit exactly per-run `git add`/`git commit`
  in the run's isolated worktree plus `git push` of that run's own branch to a
  confirmed remote;
- kept dispatch-time worktree creation confirmation separate from the durable
  per-delivery confirmation, which carries the commit message, exact branch,
  worktree location, remote target, operator, and idempotency key;
- added the delivery command path under the existing branch/worktree runner
  authority module: `git add --all`, `git commit --no-gpg-sign -m <message>`,
  and `git push <remote> <run-branch>` use structured argv, bounded capture,
  no shell, sanitized persisted outcomes, and runtime receipts;
- push failure preserves the local commit, records a failed push outcome and
  explaining failed receipt, and leaves the delivery result deliverable;
- delivery replays persisted stage/commit/push outcomes without spawning again;
- no primary-tree mutation, force-push, branch deletion, pull request, merge,
  forge/provider/callback/recovery/task mutation, or raw output retention was
  admitted.

## Evidence

- `cargo test -p nucleus-orchestration -p nucleus-server`: green
  (orchestration 22; server 2086)
- `cargo test -p nucleus-server --test module_ratchet`: green (ratchet at 323)
- `effigy qa:docs`: green (links, vision index, roadmap next-action, forbidden)

## Not touched

No roadmap, milestone, card, or dispatch status files. No swallowtail,
longhorn, or poodle sources.
