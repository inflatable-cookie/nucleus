# Run Delivery Pipeline — STOPPED at commit/push authority gate

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/101-run-delivery-pipeline.md`
Branch: `thread/101-run-delivery-pipeline`

## Outcome

Card stopped before implementation. The delivery objective requires committing and
pushing the run worktree, but the realized authority surface admits isolated
worktree creation only. Commit and push remain gated. No code was written. No
commit or push was attempted.

## Findings

### 1. Card 105 admits only isolated worktree creation

- The card's governing scope amends contracts 007/011 to admit exactly one new
effect: isolated worktree creation through the branch/worktree runner,
operator-confirmed per dispatch (`docs/roadmaps/g05/batch-cards/105-worktree-creation-authority.md:35-45`).
- The same card explicitly keeps all other SCM mutation out of scope: branch
delete/cleanup, “any other SCM mutation (commit/push keep their existing gates),”
and primary-tree checkout/switch (`docs/roadmaps/g05/batch-cards/105-worktree-creation-authority.md:59-61`).
- The merged batch log records the unchanged exclusions: “no ... commit/push/PR/forge”
(`docs/logs/2026-08-13-worktree-creation-authority.md:8-14`).

### 2. Contract 007 still rejects commit and push

The realized exception admits only `git worktree add <location> -b <branch>`.
Every other rejected effect remains rejected, including commit and push
(`docs/contracts/007-server-boundary-contract.md:1738-1752`).

### 3. Contract 011 still rejects commit and push

The realized exception admits isolated worktree creation through the same
operator-confirmed authority chain. Provider mutation stays false, and every
other effect remains excluded (`docs/contracts/011-scm-forge-sync-contract.md:599-611`).
The working-session surface likewise says it does not create branches/worktrees
or mutate provider state except for that one exception
(`docs/contracts/011-scm-forge-sync-contract.md:1068-1085`).

### 4. Contract 033 describes delivery, but does not grant the missing authority

The draft Delivery Rule defines delivery as closeout plus a committed/pushed
branch and notification where no forge exists
(`docs/contracts/033-orchestration-runs-and-delegation-authority-contract.md:98-105`).
It separately states that agent-initiated merge or push to a shared remote
requires a per-project grant not covered by the draft
(`docs/contracts/033-orchestration-runs-and-delegation-authority-contract.md:107-111`).
That delivery description does not amend the active 007/011 gates.

## Stop-condition result

Card 101 stop condition 1 fires: “Committing in a run worktree requires authority
beyond cards 011-013's admission.” The required commit/push authority is not
admitted by the current contracts or the 105 authority chain. Implementing the
pipeline would require bypassing those gates or silently widening authority.
Neither is permitted.

The validation hook was not run: this is an authority stop before implementation,
not a test failure. The requested cargo tests, module ratchet, and `effigy
qa:docs` do not validate an unadmitted commit/push effect.

## Not touched

No roadmap, milestone, card, or dispatch status files. No swallowtail, longhorn,
or poodle sources. No Rust, TypeScript, or UI code.

## Recommended next move

Amend the authority surface in a separate policy card: define the per-run commit
and remote-push grant, confirmation, target/ref restrictions, receipts, failure
semantics, and no-remote behavior in contracts 007/011/033 before re-dispatching
101. Keep forge PR creation and merge authority separate unless explicitly
admitted.
