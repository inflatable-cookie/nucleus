# 020 — Briefs stored in Nucleus

Status: implemented
Owner: Nucleus runtime and protocol maintainers
Created: 2026-09-26
Decision owner: Tom
Governing refs: Northstar Spec 042 item 2,
[Spec 018](018-queue-owned-closeout-and-durable-outcomes.md),
[orchestration](../contracts/orchestration.md)

## Problem

A Nucleus task runs from a handoff committed under `docs/handoffs/` at a pushed
planning commit. Every identity check compares those bytes in the repository:
capture, submission validation, dispatch, the worker worktree and continuation.
Under Spec 042 repositories hold no process records, so a brief has to be
submitted as content and pinned by Nucleus, not committed and later deleted.

## Brief mode

A submission carries either `handoffPath` (today) or `brief`, never both.

```json
{ "brief": { "text": "…", "mediaType": "text/markdown" }, "planningCommit": "…" }
```

- Nucleus computes the brief's digest and stores the text as the task's pinned
  instruction, with source `queue`. The limit is the existing 128 KB.
- `planningCommit` stays required. It is the pushed integration commit the brief
  was written against, and it keeps planning ancestry exact.
- **Eligibility.** Brief mode is allowed only when the repository's manifest at
  the planning commit is v5 (Spec 018), or there is no manifest. v1–v4 lifecycle
  hooks read committed handoffs, so brief mode on them is refused at dry run and
  at submission. Lead checks and brief admission also run the independent-review
  routing preflight ([Spec 030](030-routing-changes.md)) so a required
  worker/reviewer pair that shares a model fails before Ready and before any
  task is created.
- **Submission helper.** `nucleus-submit --brief <file>` (named `northstar-submit` before the 2026-11 rename) reads a local Markdown
  file. Its frontmatter needs only `title`, `queue_approval` and optional `queue:`
  routing (amended 2026-09-26 at the Northstar Chatterbox's request: the
  handoff-transport fields are not required). Nucleus imposes no section structure;
  the body only has to be non-empty. The file need not be committed or under
  `docs/handoffs/`. It records the current
  clean, pushed integration head as the planning commit. `--dry-run` returns the
  digest.
- **Storage.** The task stores one copy of that text, keyed by its digest, and
  derives `handoffText` from it, so the legacy handoff protocol reads the same
  bytes without a second copy in the task row (audit B6, 2026-10-25; the rule is
  in the [service boundary](../contracts/service-boundary.md) "Task rows stay
  slim"). A brief amended by `amend_brief` keeps every earlier version in
  `task_brief_versions`; only the current text and the exact handoff bytes are
  held once. A task whose stored handoff bytes are not its brief's bytes keeps
  both copies, and neither read is collapsed into the other.
- **Merge hold.** `queue.mergeHold: true` is accepted on a brief or handoff and
  creates the task with its visible merge hold already set. This hold does not
  block initial dispatch: worker, review and other pre-merge steps continue,
  while Nucleus waits for operator `release` before merge. An ordinary `hold` on
  a queued task still blocks dispatch.

## Identity checks

For a brief-mode task, every check that compared handoff bytes in the repository
compares against Nucleus's pinned brief instead, and planning identity becomes
ancestry:

| Check | Handoff mode (unchanged) | Brief mode |
| --- | --- | --- |
| Submission validation | Handoff bytes at the planning commit | Brief digest matches; the planning commit is on the pushed base |
| Dispatch | Handoff unchanged at the current base | Planning commit is an ancestor of the current base |
| Worker worktree | Handoff at the worktree head | Planning commit is an ancestor of the worktree head |
| Continuation (`verifyResume`) | Handoff at the planning commit | Planning commit is an ancestor of the worktree head |

## Delivery

The worker and reviewer prompts carry the brief text inline, labelled as held by
Nucleus. The worker is told not to commit it. Scoped revision instructions and
review findings are unchanged. A blocked/error retry keeps any unconsumed explicit
continuation and gives the revision the current brief version. If no explicit
continuation is pending, the run carries a neutral continuation action and keeps
the latest authenticated blocked revision result in a separate diagnostic field.
The diagnostic can explain where work stopped, but cannot grant permission or
override the Nucleus-held brief.

## Amendment

Operator control `amend_brief` (complete text, reason) pins a new brief version
and applies supported queue-routing edits while the task is queued and dispatch
has never begun. Unsupported fields, or routing edits after dispatch, refuse
with every field named; the transaction changes neither routing nor brief on a
refusal. The reply lists changed task fields. Removing a declared routing field
restores its submission default; omitted `interactive` keeps the existing mode.
Profile requests keep ordinary validation and
sign-off; document text grants no operator authority. The
[Nucleus skill](../../../skills/nucleus/SKILL.md#holds-cancellation-and-brief-edits)
lists supported fields (Tom, 2026-11-10).

`queue.reportOnly` and `queue.reportLane` changes are unsupported amendments and
refuse by name before and after dispatch, including removal with all frontmatter.
Unchanged delivery declarations allow ordinary brief-body edits.

The new brief is pinned by digest. If its frontmatter changes `queue.mergeHold`
or its reason, the amendment applies
that hold change to the task in the same transaction and records a
`brief_merge_hold_changed` event. (Spec 058 cutover 2: `queue.manualVerification`
and `queue.reviewVerdicts` are retired — an amendment carrying them is refused
with the replacement named, and the gate-change recording for them is deleted.) It is refused once merge intent is recorded or merging has
started, and after merge. Earlier versions are kept for the task in their own
table (schema 43, Tom 2026-10-21), so an ordinary task update never rewrites
them, and each run records the version it was given. A live worker or reviewer is
told of the amendment as a message queued behind its current step; an open
`nucleus_ask` is answered with the new brief and any board decision linked by
`agent_ask_decision` is withdrawn. The next run receives the new version, and its
prompt says the brief was amended, with the reason. For brief-mode tasks,
A re-pin (`amend_brief` with no text) is refused with a pointer to `amend_brief` with the new text.

Routine coordination updates use `queue.task` with `action: "note"` and a
message. Nucleus appends a `coordination_note` task event and shows it in Activity;
it does not change the task version or brief history. Use `amend_brief` only
when the task's actual scope or instructions change.

## Outcome record

The Spec 018 outcome row stores the brief version the task finished under, with
its digest, and the digests of earlier versions.

## External PR review entry

Spec 017 allows an external PR to enter review from a Nucleus-held brief without
committing a handoff or copying brief text into the repository. Review-entry
binding must prove the brief against its checked Nucleus lead or approved draft:
the current version, text digest, approval, successful check and planning commit
must all match. Binding consumes/promotes that checked source in the same Store
transaction as the review task. A caller-supplied brief with no matching checked
Nucleus source is refused. The task retains the exact brief version and digest.

External review entry may use this Nucleus-held brief in an existing isolated
workspace. It checks the exact digest, version, stored approval and pushed
planning ancestry, then consumes the checked source atomically with task binding.
It reads and writes no repository handoff. An explicit
`workspaceMode: shared_canonical` request refuses with
`exclusive_writer_unavailable` before workspace inspection or binding because
Nucleus cannot reserve exclusive writers for a canonical checkout. Ordinary brief
dispatch and legacy handoff review entry keep their existing behavior.

On 2026-09-30 Tom answered operator-board decision
`8f759587-b206-4161-91a6-f4687d22e1dc` version 2: **"Allow one isolated PR124
review workspace and finish the brief-mode intake fix"**. The ruling permits
one isolated PR124 review after the fix lands; the planner handles that live
intake separately. It does not permit shared-canonical intake, live Project-d
acceptance in implementation tests, source-thread changes or another task or
dispatch.

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Brief submission to a v5 repository | Accepted; brief pinned by digest; nothing read from or written to the repository |
| 2 | Brief submission to a v1–v4 repository | Refused at dry run and at submission |
| 3 | Both `brief` and `handoffPath`, or neither | Refused |
| 4 | Dispatch after main advanced | Dispatches from the new base; planning ancestry holds |
| 5 | Planning commit not on the pushed base | Refused |
| 6 | Worker, revision and reviewer prompts | Carry the brief text; handoff-mode prompts match the reviewed canonical fixture byte for byte |
| 7 | Continuation after a stopped worker | Passes on ancestry with dirty work kept |
| 8 | `amend_brief` before merge; after merge | New version queued to a live worker or reviewer behind its current step, given to the next run with the reason, and used to answer an open `nucleus_ask`; refused after merge |
| 9 | Outcome row | Holds the final brief text, its digest and earlier digests |
| 10 | Handoff-mode tasks and repositories | Behaviour unchanged |
| 11 | Restart and migration | Brief tasks keep their pinned versions; old stores migrate unchanged |
| 12 | External PR review entry from a checked Nucleus brief | Exact source approval, digest, version and pushed ancestry match; no repository handoff read/write; the checked source and review task bind atomically |
| 13 | Missing, stale or amended Nucleus approval | Refused before binding; no approval is inferred from caller text or a digest alone |
| 14 | Brief or handoff with `queue.mergeHold: true` | Task is visibly held but dispatches; review and other steps run; merge waits for operator `release` |
| 15 | Brief amendment changes merge hold, manual verification or review verdicts | Task gate fields change in the same transaction and each changed field has its own event |
| 16 | Brief amendment after merge intent or entry into merging | Refused with the merge-start reason |

The handoff prompt fixture is the current reviewed baseline, not a historical
pre-brief snapshot. Its reviewer entries include two approved handoff-mode
changes on `main`: commit `5ed958b33df026bc7d78dc04b9dc48323cc2cab9` retains
blocked findings for external or owner-gated review evidence without publishing
a review or starting an author revision; commit
`6df4be78cf87db9f591ae97954b5a61f105300c3` limits review publication to
`ready_to_merge` and `changes_required` verdicts. Spec 037 owns these review
rules. Commit `ecac007d1bddd218d43cad202226c11f9fd1304f` (task 395) added the
run-bound build output cleanup disclosure to the worker, revision and reviewer
continuation prompts, and the fixture's continuation entries carry the
"no run-bound cleanup record" wording these frozen inputs render. The acceptance test still compares every rendered handoff prompt shape
byte for byte and separately checks that brief-mode prompts carry the brief.

## Out of scope

Removing handoff mode, brief templates, editing briefs from the board, and lanes
(Spec 019, which adds its lane field to brief submissions after this lands).
