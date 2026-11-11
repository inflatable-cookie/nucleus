# 033 — Formal PR reviews under a separate reviewer identity

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-09-29
Decision owner: Tom (Northstar Chatterbox, 2026-09-29, via Project-g papercut 069984c5)
Governing refs: [orchestration contract](../contracts/orchestration.md),
[Spec 022 repository settings](022-queue-projects-without-manifests.md),
[Spec 017 external PR review entry](017-external-pr-review-entry.md),
[Spec 007 reviewed-head pre-merge hooks](007-reviewed-head-pre-merge-hooks.md)

## Problem

Today Nucleus publishes a reviewer's verdict as a PR comment from whichever GitHub
account the agent's `gh` happens to use — normally the operator's own login. A PR
comment cannot satisfy branch protection's required-review rule, so an
independent exact-head review is not a merge gate GitHub can enforce. Repositories
that want that gate need Nucleus to publish the verdict as a formal GitHub review
from a separate reviewer login.

## Opt-in

A repository opts in through `repository.set` with `reviewer: {login}`. The
setting is stored on the repository's existing permanent `repository_settings`
row (Spec 022), keyed by the same identity as outcomes, lanes and task numbers,
and exported and imported with the other rows. `login` is the GitHub login whose
`APPROVED` review merges require; it is not the token. Omitting `reviewer` on a
set replaces the row's mutable state and clears the opt-in, exactly as
`validation` and `closeout` already behave.

A repository without the setting keeps today's comment path byte for byte:
Comment publication, comment verification and comment-based merge evidence all
behave as before, and no keychain read happens.

## Token handling

Formal reviews need macOS: each org's token lives in the macOS login keychain
and is read at call time. Store it with:

```
security add-generic-password -a <org> -s nucleus.github-reviewer -w
```

```
security find-generic-password -s nucleus.github-reviewer -a <org> -w
```

- `<org>` is the owner of the repository's GitHub origin.
- The token is passed as an authorization header only to Nucleus's formal-review
  HTTPS requests, including verification and merge prechecks. It is never stored, logged, put in an agent
  environment, written into the repository or named in an error message.
- The read tries the `nucleus.github-reviewer` service first and then the legacy
  `paseo-queue.github-reviewer` service, so a token stored before the rename
  keeps working; move the item to the new service. The legacy name is recorded
  in [retired.toml](../retired.toml) (`legacy-reviewer-keychain-service`).
- A missing keychain item, an HTTP 401/403, or a missing write access refuses
  with a task attention reason naming the org, the keychain service (including
  the legacy fallback) and what is
  missing, and keeps GitHub's actionable HTTP refusal text. A formal-repository failure never falls
  back to a comment.

## Publication

Nucleus publishes the accepted verdict with
`POST repos/{owner}/{repo}/pulls/{number}/reviews` and `commit_id = run.head`.
The verdict maps to the review event:

| Verdict | GitHub review event | Verified review state |
| --- | --- | --- |
| `ready_to_merge` | `APPROVE` | `APPROVED` |
| `changes_required` | `REQUEST_CHANGES` | `CHANGES_REQUESTED` |
| anything else | `COMMENT` | `COMMENTED` |

Revision and verification prompts preserve the distinction between a formal
review id and a comment id. A comment id is linked as the PR's issue comment
URL (`#issuecomment-<id>`); it must never be presented as a PR review endpoint
id, because comment ids are not review ids.

The body keeps the existing immutable `<!-- northstar-review:task:run:head:status -->`
marker and the same substantive-findings rules as the comment path. The
publication record stored beside the run's publication key keeps the body hash
and the formal review id. The formal review id is durable evidence in its own
right: the run completion, `resolution.review` and the outcome review row carry
it as `reviewId`, never as `reviewCommentId`, so a formal review is never
recorded or named as a comment. Recovery has the same durable intent-then-recover
shape as a comment.

**Idempotent recovery.** When a persisted intent has no review id, Nucleus lists
`repos/{owner}/{repo}/pulls/{number}/reviews` and accepts a review whose
`user.login` equals the configured login, whose body carries the exact marker, and
whose body equals the persisted findings body (the stored hash is the authority: a
marked review whose findings changed is never adopted). Zero matches refuse with a
loud, inspect-the-PR reason; Nucleus never posts a duplicate.

**Single-flight publication (task 704).** One reviewer run publishes one review,
however many passes observe it. Publication is single-flight per run: concurrent
passes share one in-process flight, and the durable intent is claimed inside one
store transaction, so exactly one caller can own the POST. A pass that loses the
claim observes the winner's recorded publication instead of posting, and unknown
delivery is always observed before anything is reposted. The intent is written
before the GitHub side effect, so a restarted process or a handover racing the
same run finds it and reconciles rather than republishing. A repeat that reuses
the recorded publication ID is silent: it writes no `review_published` event.

**Duplicate exact-marker reviews (task 704).** Two reviews carrying this run's
exact marker at this head are the real outcome of a publication race, not an
ambiguity that stops the task. The earliest one (by `submitted_at`, then by ID) is
the record; the later one is left in place on GitHub and is never deleted. This
holds for the intent-recovery inventory, the owner recovery inventory, comment
publication and verification. A review whose findings differ from the persisted
hash still refuses, and only advances from the configured login are ever adopted;
markers existing under other logins alone still refuse.

**Owner-only missing publication recovery (Tom, 2026-10-07).** An accepted
reviewer verdict (`ready_to_merge` or `changes_required`) with a hash-only intent and no remote marker is a publication failure,
not missing reading or author work. `queue.task` action
`retry_effect` requires the fresh task version, the `review_publication.<runId>`
effect listed by `next`, and an operator `reason`. It uses the same authenticated,
released ordinary reviewer run and immutable verdict, with no new agent, ticket
or turn. `changes_required` remains `CHANGES_REQUESTED`, never approval.

Pause, dispatch/disposition fences, unfinished leases, changed task/run/head or
reviewer settings refuse. One matching review is adopted only with the exact
login, head, verdict, marker and complete body. Duplicate exact-marker reviews
settle on the earliest, as above; markers under other logins only and incomplete
inventories refuse. For zero matches the explicit owner action checks
the current PR again and a second complete inventory, then records one durable
recovery attempt before posting. A lost response retains that attempt; zero
matches thereafter never authorize another POST. An existing matching remote
result can still be reconciled. The original publication hash and callback remain
unchanged; only the real review ID is attached, attention is resolved and ordinary
exact-head completion/merge handling resumes. This is not a content retry or
permission to reissue an ambiguous request automatically.

## Verification

A formal verdict is verified against the reviewed head, never inferred from a
number. The review's `user.login`, `commit_id`, `state` and marker must all match
the configured login, `run.head`, the state mapped from the recorded verdict, and
the immutable marker. A neighbouring or absent numeric id is reconciled only from
the single authenticated exact-marker review, exactly as the comment path does.
The recorded `reviewId` is the lookup key; a comment id is never used for it.

## Merge precheck

For an opted-in repository, merge requires the configured login's `APPROVED`
review at the current head. The existing accepted-review gate runs
`requiredMergeReview`, which verifies the formal review under the reviewer
identity before the ordinary check, mergeability, base and identity gates
continue. A `CHANGES_REQUESTED`, `COMMENTED`, missing or stale-head review refuses
with a task attention reason.

This holds even for a `skipPRReview` task. The review-skipping lane does not
exempt an opted-in repository, and it never reads the keychain to invent a
review. A review-skipping submission for an opted-in repository is refused at dry
run and dispatch before any repository hook runs, so the dispatcher can still
choose an ordinary reviewed lane; a task submitted before the opt-in existed is
held at the merge gate instead of merging.

## Reviewer prompt

A reviewer run records the formal mode at launch. Its prompt then tells the
reviewer to supply all required findings in the report `reviewText` and not to
post its own PR comment or review: Nucleus publishes the verdict as a formal review
under the configured identity. The MCP and socket fallback paths both carry that
instruction. The revision and verification prompts name a formal review by its
`reviewId` (`Review ID: <n>` / `Review: <n>`), never as a comment id, while the
comment path keeps its original wording byte for byte. Legacy prompts are
unchanged when the repository has no opt-in.

## Boundaries

- Branch protection rules and the reviewer login's collaborator access are
  operator steps outside Nucleus. Nucleus only publishes and verifies the review.
- The live pilot is run after merge, once the token is in the keychain.
- A repository without the setting keeps today's behaviour, including the
  review-skipping lane. An opted-in repository refuses a review-skipping
  submission and its merge gate always requires that login's approved review at
  the current head.
- The reviewer login must not be the queue-owned worker's observed author model
  or the operator's personal login for branch protection to mean anything; Nucleus
  verifies the login it was configured with and does not decide that policy.

## Acceptance oracle

| # | Case | Expected |
| --- | --- | --- |
| 1 | `repository.set` with `reviewer: {login}` | Round-trips through get, list, export and import; `null` clears it; a non-login shape is refused |
| 2 | Verdict to review event | `ready_to_merge` → `APPROVE`, `changes_required` → `REQUEST_CHANGES`, anything else → `COMMENT` |
| 3 | Publication | `POST .../reviews` carries `commit_id = run.head` and the exact marker; the token is passed only in the HTTPS authorization header and appears in no stored record, event or error |
| 4 | Persisted intent recovery | One marked review from the configured login whose body equals the persisted findings is adopted with no duplicate POST; a duplicate exact marker settles on the earliest; zero matches or a changed finding set refuse |
| 5 | Verification | Login, commit, state and marker all checked; each mismatch refuses |
| 6 | Merge precheck | The configured login's `APPROVED` review at the current head is required; `CHANGES_REQUESTED`, `COMMENTED` and stale heads refuse |
| 7 | Missing keychain item | Loud refusal naming the org, the new service and the legacy fallback; no comment fallback |
| 8 | HTTP 401/403 or missing write access | Loud refusal naming the org and the actionable GitHub reason; no comment fallback; no token in the message |
| 9 | Repository without the opt-in | Comment publication, verification and merge evidence unchanged; no keychain read |
| 10 | Reviewer prompt | A formal run's prompt forbids the reviewer posting its own verdict; legacy prompts are byte-identical |
| 11 | Review identity in evidence | A formal review id is recorded as `reviewId` on the completion, task resolution and outcome review row, never as `reviewCommentId`; revision and verification prompts name it as a review |
| 12 | Opted-in review-skipping submission | Refused at dry run and dispatch before any hook runs; a task submitted before the opt-in is held at the merge gate and never merges without the reviewer's approved review |


## Findings bytes and recovery ownership

Formal review POSTs and reads use machine JSON over HTTPS. The transport preserves
literal Unicode escapes, actual Unicode and controls, backslashes, quotes,
newlines and verdict tables. It does not normalize findings. GitHub CLI 2.102.0
sanitizes JSON responses even when stdout is piped; a local echo reproduces
literal `\u0085` becoming `\^E` on read while the POST arrives intact. This proves
response corruption, not a mutation of stored GitHub content. Nucleus reads exact
remote bytes before deciding whether a historical publication matches.

The machine transport keeps the keychain identity, bounds responses and time,
refuses redirects or foreign pagination, and never retries a failed POST.
Review inventories request `per_page=100` initially. Pagination may retain the
original named path or use GitHub's canonical
`/repositories/<id>/pulls/<samePR>/reviews` path. Before following that alias,
Nucleus reads the original named repository's metadata and requires its numeric ID
to match. That ID stays fixed for the inventory; another repository, PR or
resource refuses. The metadata read shares the same deadline and response budget.
The 1 MB cap covers aggregate response-body bytes across the whole inventory,
including that metadata, rather than resetting for each page. The 30-second
deadline, 1,000-page ceiling, loop checks, fixed HTTPS API origin, no-userinfo and
no-redirect rules remain. Exceeding a bound leaves the inventory unproven.

Unavailable or malformed inventories are not absence. A remotely mismatching
body remains mismatching evidence regardless of login, head, state or marker.
A refused publication retry preserves the task's stop and recovery findings.

Publication failure is not another missing callback. Repeated wakes or a service
restart keep the existing incident, stop and coordinator outcome; `cannot` does
not reopen equivalent recovery. A genuinely new authenticated callback still
reconciles a missing-result stop. Explicit owner controls can re-evaluate through
their normal gates. To return work to the author, use Spec 050 `move to=work`;
the original verdict and unresolved publication intent remain history without
review credit.
