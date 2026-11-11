# 015 — Prospective-merge pre-merge hooks

Status: implemented
Owner: Nucleus and repository policy maintainers
Created: 2026-09-15
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/contracts/repository-hooks.md`,
`docs/knowledge/specs/007-reviewed-head-pre-merge-hooks.md`

## Problem

`task.pre_merge` currently runs only against the reviewed branch head. A
repository-wide required check therefore sees stale integration files that the
lane never changed and that the actual merge would take from current main.
Unrelated policy drift becomes a false semantic refusal, spends an author
revision cycle and can force workers to merge main solely to satisfy the check.

Project-a g03.021, g03.029 and g03.033 all failed on one roadmap file already
fixed on main. The measured g03.029 lane changed 169 note/log files and no
roadmap document, yet its branch-head check refused that unrelated file.

## Versioned target

Add a new manifest and event version with the closed hook target
`prospective_merge`. It is valid only for required read-only `task.pre_merge`
hooks. Existing `reviewed_head` hooks and prior manifest/event versions retain
their exact behavior.

The event identifies, separately:

- the accepted reviewed PR head;
- the current synchronized integration-base commit;
- the Nucleus-created prospective merge commit/tree used as the execution root;
- the immutable submitted instruction and accepted review evidence.

Nucleus does not infer target scope from repository paths, commands or results.

## Candidate construction

After acquiring the existing repository integration turn, Nucleus fetches and
pins the clean local/remote base and re-verifies the open PR at the accepted
reviewed head. It computes a normal two-parent merge candidate using the same
parent order and merge semantics as the configured GitHub `merge` operation.
One Nucleus-owned warm checkout per repository can carry successive candidates.
Each reuse proves the previous pin and clean detached checkout, fetches the
exact inputs, resets to the integration base and checks out the new candidate.
If ownership or checkout identity cannot be proved, Nucleus builds the existing
disposable candidate instead. New warm and disposable checkouts live under
the Nucleus data directory (`isolation/<digest of the git common dir>/…`),
outside any repository, so a resolver that walks parent directories never
reaches the repository's `node_modules`, `.git`, `package.json` or workspace
lockfiles (Vite and Vitest workspace-root detection). The former repository-local
isolation root is retired; a one-time sweep disposes only its proved owned warm
clones after their occurrences settle (Tom, 2026-11-09). A failed repository
or warm-clone lookup leaves the sweep incomplete so a later bootstrap retries it;
only a missing warm-clone path counts as absent. All candidate paths
stay outside canonical and task workspaces. Candidate build time is recorded
apart from hook execution time.

A conflict stops before hook execution and uses the existing worker-update
path. Nucleus never modifies or pushes the worker branch to manufacture a pass.
The candidate checkout must be clean at its synthetic commit before and after
the hook. A disposable checkout is removed only after absence of uncertain
process state is proved. A settled warm checkout remains for the next candidate;
an uncertain occurrence retains its checkout and prevents reuse.

## Identity and race rules

The durable occurrence pins base, reviewed head, merge tree/commit, manifest,
program, instruction and task/PR identities before process intent. After a
result, Nucleus re-fetches the integration base and PR. Any movement invalidates
the result as operationally stale, spends no semantic revision round and
rebuilds at most one current candidate per normal lifecycle pass. It never
converts a stale pass or refusal into success.

The later merge gate must still prove the same base and exact reviewed head.
External base movement between the hook and merge discards the candidate result
and reruns on the new prospective result. Repository FIFO serialization remains
unchanged.

## Result semantics

A confirmed refusal from a current candidate follows the ordinary semantic
revision loop. Uncertainty, mutation, candidate cleanup failure, identity drift
or inability to reproduce the merge is operational attention. Neither case
creates post-merge closeout authority.

Telemetry distinguishes reviewed-head and prospective-merge occurrences and
records stale-candidate rebuilds separately from semantic refusals and recovery
coordinators.

## Acceptance oracle

- A branch behind main whose untouched stale file is fixed on main passes when
  the prospective merge tree passes.
- A defect introduced by the lane and present in the prospective tree refuses
  and returns the retained worker through one semantic revision that continues
  the open round without consuming a review round (task 576, 2026-11-02).
- A real merge conflict never runs the hook or changes either checkout.
- Base or PR movement during execution invalidates the result without revision
  cost or merge.
- Mutation, timeout, crash and uncertain cleanup fail closed.
- The candidate tree and parent order match a local fixture's normal merge
  result; the later actual merge remains exact-head/base gated.
- Existing manifest versions and `reviewed_head` fixtures remain unchanged.
- RPC, stored occurrence, telemetry and native detail projections distinguish
  the target without repository-specific vocabulary.

## Exclusions

No automatic worker-branch merge/rebase, consumer repository edit, document
parsing, revision-budget increase, merge-conflict resolution, GitHub merge
bypass or task-specific exception belongs to this change.
