# 028 — Fresh sibling checkouts

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-09-26
Decision owner: Tom
Governing refs: [Spec 027](027-multi-repository-projects.md) (Nucleus-owned sibling
worktrees under the data directory are a different surface), papercut `b64aa02e`.

## Problem

A Paseo worktree root holds the task worktree (`ns-<taskId>`) and, beside it,
detached clones created by repository link tasks such as Effigy `deps link`.
Those clones are shared by every task in the root. Nothing refreshed them, so a
dependant whose build resolves `../sibling` could see a pin from weeks earlier
after its prerequisite had already merged. Tom ruled that cross-repository
`dependsOn` stays, so the dependant must see what the prerequisite merged
(2026-09-26).

This is not Spec 027's Nucleus-owned sibling worktrees under the Nucleus data
directory. Those remain pinned copies for prompt context. This spec is the
existing checkouts in the worktree root that relative paths already resolve.

## Contract

At worker creation and when a task is released from `prerequisite_wait`, Nucleus
looks at each sibling checkout in the task's worktree root: a Git checkout
beside the task worktree that is not itself a Nucleus task worktree
(`ns-<uuid>`, `ns-<uuid>-N`, `ns-closeout-<uuid>`).

- A sibling that is clean and on a detached HEAD is fetched and fast-forwarded
  to its origin default branch. The event records the sibling, its old commit
  and its new commit.
- A dirty sibling, or one on a branch, is never touched: it is a finding in
  task detail and in the worker's prompt, naming the sibling and its state.
- A detached HEAD that is not an ancestor of the origin default branch is
  reported, not moved.
- Fetch or fast-forward failures are reported, never retried blindly, and never
  block dispatch by themselves.
- Siblings in a root are shared across tasks; the clean-and-detached rule is
  what makes the fast-forward safe for another task reading it.

Nucleus also keeps one isolated shared object store per sibling origin under the
Nucleus data directory (`sibling-store/<sha256 of the normalised origin>.git`),
so the same sibling at the same head across worktree groups holds its Git
history once instead of a full clone each. After the pass leaves a sibling
clean, detached and at origin default, Nucleus links the checkout's objects to
that store (`objects/info/alternates`) and repacks, so the store holds the
objects and the checkout holds only what the store lacks. The checkout keeps
its own refs, HEAD, index and working tree — no task can see or change another
group's source or build inputs through the store, and objects are shared only
by their content address, never by path. The store is bare, never pruned
(`gc.auto=0`) and never built in; a store that vanished is rebuilt from the
sibling's origin and the checkout is re-proved in the same pass. A sibling
whose `objects/info/alternates` names any store other than Nucleus's own is
never touched, never migrated and never rewritten — entries are read the way
Git reads them (relative entries resolve against the checkout's objects
directory) and every line is kept, so a vanished foreign store surfaces
through the refresh finding instead of a repair. An already-linked checkout
absorbs locally packed increments into the store on the next pass; loose
incremental objects stay checkout-local until they are packed. Sharing
preserves the recorded head exactly and re-proves head, cleanliness and object
access afterwards; a failed share is a `store_failed` finding and never blocks
dispatch.

When the task has no worktree yet (still queued after a prerequisite finishes),
Nucleus uses another live task of the same repository that already has a
directory in that root. If no root is known, the pass is a no-op; worker
creation retries once the workspace exists. A filesystem root is never scanned.

Findings replace the previous inspection of this surface. A later pass that
fast-forwards a sibling that was dirty clears that finding. Spec 027
`siblingFindings` are unchanged.

Nucleus shares Cargo's downloaded registry and Git dependency source caches
through the standard per-user `CARGO_HOME` it places in each local Paseo
worker's environment (the existing `CARGO_HOME`, or `~/.cargo` by default).
Cargo build outputs stay local to each task checkout. Nucleus does not share or
link sibling build caches: build-script outputs, incremental state, test
executables, and final binaries can depend on each task's source revision.
The separate sibling build-cache store is deferred to a follow-up. Closing a
task discovers and removes each Cargo package/workspace `target` directory and
each `node_modules` root only after the clean, published-head, idle-thread and
no-live-run proofs in Spec 003 and the orchestration contract. Any root Nucleus
cannot safely remove is shown on the task with its full path and reason, and
prevents cleanup from being reported complete.
Cargo metadata runs from each package directory and supplies that invocation's
configured `target_directory`, so member-level config, quoted keys and
environment overrides follow Cargo's own resolution. Resolved target paths are
deduplicated; each package and workspace's conventional `target` directory is
also checked for stale output. Cleanup rejects intermediate symlinks before
checking tracked paths, and metadata failures, outside targets, or unsafe roots
block cleanup with full paths, package/workspace roots, applicable config paths,
and reasons on the task.

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Clean detached sibling behind origin, worker creation | Fast-forwarded to origin default; event records path, old and new commits; dispatch proceeds |
| 2 | Clean detached sibling behind origin, release from `prerequisite_wait` | Same fast-forward and event, even if this task has no workspace yet, using another live task's worktree root |
| 3 | Dirty sibling | Finding in task detail and worker prompt; checkout untouched |
| 4 | Sibling on a branch | Finding; checkout untouched |
| 5 | Diverged detached sibling (HEAD not an ancestor of origin default) | Finding; checkout untouched |
| 6 | Fetch failure | Finding; dispatch proceeds |
| 7 | Nucleus task worktree in the same root (`ns-<uuid>` and closeout/collision forms) | Never treated as a sibling; never fetched or moved |
| 8 | Two task revisions build the same executable while sharing Cargo home | Each checkout keeps and runs its own final binary after both builds; only downloaded packages are shared |
| 9 | Two worktree roots with the same sibling origin at the same head | Both checkouts share one bare object store; each checkout's own object store holds no packs; on-disk, both checkouts plus the store are smaller than one full copy plus the store |
| 10 | One group's sibling fast-forwards to a new origin head | The other group's sibling keeps its recorded head: working tree, HEAD commit and tree blobs unchanged |
| 11 | The shared store directory is deleted | The pass rebuilds the store from the sibling's origin, re-refreshes the checkout and records no finding; a failed repair is a `store_failed` finding and the checkout is untouched |
| 12 | A sibling whose `objects/info/alternates` names any store other than Nucleus's own — relative entries, multiple lines, or a named store that is missing | Left untouched; never migrated, never rewritten |

## Out of scope

Creating the clones (repository link tasks such as Effigy `deps link` keep
creating full clones; Nucleus shares the ones it finds), moving Paseo's worktree
layout, writing into a dirty or attached checkout, sharing build outputs beyond
Git's content-addressed objects, and Spec 027 Nucleus-owned sibling worktrees.
