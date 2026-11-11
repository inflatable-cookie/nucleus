# 007 — Reviewed-head pre-merge hooks

Status: implemented
Owner: Nucleus and repository policy maintainers
Created: 2026-09-15
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/contracts/repository-hooks.md`,
`docs/knowledge/specs/001-generic-repository-hooks.md`

## Problem

Some repository policy is meaningful only after implementation and independent
review, but must pass before merge. Running it at closeout discovers a
worker-fixable defect after the PR is already merged and turns an ordinary
revision into a Chatterbox escalation.

Nucleus currently offers no generic hook target for the clean accepted PR head.
Repositories either duplicate policy in review prompts or wait until
post-merge closeout.

## Contract

Add `paseo.queue.control.v3` and `paseo.queue.event.v2`. Existing v1 and v2
manifests and stored occurrences remain unchanged.

A v3 hook adds one closed target field:

```json
{
  "id": "repository-pre-merge",
  "events": ["task.pre_merge"],
  "target": "reviewed_head",
  "mode": "read_only",
  "delivery": "required",
  "program": {
    "kind": "trusted_runner",
    "runner": "effigy",
    "argv": ["skill", "run", "northstar/queue:hook", "--stdio", "passthrough"]
  },
  "timeoutMs": 30000,
  "maxOutputBytes": 65536,
  "allowedPaths": [],
  "commitSubject": null
}
```

`task.pre_merge` requires exactly `target: reviewed_head`, `mode: read_only`
and `delivery: required`. Existing events use `target: integration_base` in a
v3 hook. A definition that mixes events with different targets is invalid;
repositories use separate hook entries.

The v2 event payload retains the existing fields and adds
`repository.target`. For this event:

- `event` is `task.pre_merge`;
- `repository.target` is `reviewed_head`;
- `repository.root` is the retained Nucleus task workspace;
- `repository.baseCommit` is the accepted exact PR head;
- `task.instruction` is the Nucleus-pinned submitted instruction artifact;
- `delivery.prUrl`, `delivery.prNumber`, `delivery.head`, and
  `delivery.review` carry Nucleus-accepted exact-head evidence;
- merge and integration commits are `null`.

The manifest, program and event are pinned from the reviewed head before
process intent. Nucleus runs only after the reviewer verdict is accepted and its
lease is released. It rechecks the queue branch, clean worktree, local HEAD,
remote branch and open PR head before and after execution. The hook receives no
write authority and must return no changed paths or commit subject.

## Lifecycle result

`ok` records the occurrence and lets normal verification and merge continue.
A confirmed `blocked` or `failed` result, after Nucleus proves the workspace is
unchanged, becomes the next ordinary semantic revision finding. Nucleus retains
the old hook occurrence and accepted review as evidence, returns the same PR
and workspace to the retained worker, consumes one semantic revision round,
and later requires a fresh independent verdict and fresh pre-merge occurrence
at the new exact head.

Process uncertainty, malformed transport, workspace mutation, changed branch
or PR identity, and inability to prove the exact target are operational holds.
They do not merge or invent a worker finding. Normal bounded recovery applies.
A semantic refusal creates no closeout occurrence, closeout incident, or
Chatterbox notice. Notification occurs only if the existing semantic revision
authority exhausts or a separate operational ambiguity reaches its normal
escalation boundary.

## Required check waits

A pending required check is polled again every minute at the same recorded PR
head. Nucleus persists the next observation time, yields the repository FIFO
integration turn while it waits, and lets later reviewed tasks proceed. Once the
check settles, Nucleus closes any check-attention episode, reacquires a fresh FIFO
turn, and reruns every exact-head merge gate before it can merge or return the
same PR to its worker for a failed terminal check.

An overdue `QUEUED` check with fetched zero-step evidence remains in the pending
poll path while GitHub still reports `QUEUED`; it does not consume the rerun
intent because the existing workflow rerun call cannot dispatch a queued run.
Once GitHub reports `CANCELLED`, the existing positive evidence applies: zero
fetched steps or a runner-acquisition annotation. Nucleus records one durable,
exact-head rerun intent before dispatching a same-head workflow rerun. Repeated
runnerless evidence or a dispatch failure escalates once; polling continues,
and infrastructure checks never revise the worker.

## Ordering and compatibility

A settled occurrence at one exact reviewed head answers for that head: a
restart, a retry, or a re-verification of the unchanged head reuses it instead
of executing the gate again. A changed exact head invalidates prior approval
and mints a fresh occurrence that a fresh independent review still gates.

The event runs inside the existing per-repository integration turn after
accepted review and before post-review verification and merge. Multiple bound
hooks retain deterministic manifest order and all must pass. A changed PR head
invalidates prior approval and occurrence through existing exact-head rules.

Manifest absence, v1/v2 manifests, and v3 manifests without `task.pre_merge`
preserve current behavior. Nucleus does not infer this event from a closeout hook
and never parses the submitted instruction, hook summary, repository files, or
document grammar.

## Acceptance oracle

- A clean exact-head fixture receives the pinned instruction and accepted
  review, passes, verifies, and merges once.
- A valid refusal returns the same retained worker, workspace, branch and PR
  through one semantic revision; the new head receives independent re-review
  and a new occurrence before merge.
- A semantic refusal continues the open approved round: it launches the
  retained worker without consuming a review round and never parks at the
  revision cap; only a new `changes_required` review past the cap exhausts the
  budget (task 576, 2026-11-02). Administrative runs remain outside it.
- Dirty, switched, unpushed, mismatched, missing and changing PR-head targets
  fail before merge.
- Mutation, timeout, crash, malformed output and uncertain delivery retain
  current read-only safety and recovery guarantees.
- Restart reconciles one pinned occurrence without duplicate execution or
  worker prompts.
- v1/v2 schema fixtures and repositories without the hook remain byte-stable.
- Nucleus source and tests contain no Northstar path, Markdown rule, roadmap ID,
  or backlink parser.

## Northstar integration

Northstar may implement `task.pre_merge` support against event schema v2 in
parallel. Its repository manifest binds the existing trusted `effigy` runner
and exact argv shown above. The Northstar hook reads the pinned instruction and
applies its own bounded backlink resolver. Nucleus treats its result as opaque.

Integration waits only for both independently reviewed changes to land. Nucleus
does not require a Northstar implementation commit to dispatch g01.020.

## Exclusions

No consumer repository edit, Markdown parsing, new review agent, closeout
fallback, manual merge, provider-routing change, revision-budget expansion, or
existing task recovery belongs to this task.
