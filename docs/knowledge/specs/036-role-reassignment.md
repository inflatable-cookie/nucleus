# 036 — Operator role reassignment after worker intent

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-10-01
Decision owner: Tom
Governing refs: [Spec 030](030-routing-changes.md) (routing before dispatch),
[Spec 033](033-formal-pr-reviews.md) (formal reviews)

## Ruling

Tom, 2026-10-01, relayed by the Project-a Chatterbox, on Project-a #1725: "I'm not
unpausing Claude, I'll run out of usage. Queue needs to be updated to allow for
these situations." His requested outcome stands: Sol writes #1725, then a fresh
Luna agent reviews it. This was given after he was told that a Luna agent had
written an earlier revision on the same PR.

His ruling changes review independence from the model to the agent that
actually wrote the work. A model is no longer excluded for good because a
different, earlier agent of that model wrote part of the task. The same agent
can never certify its own changes.

## Problem

Once a worker has an intent, `set_routing` refuses, and the replacement
controls change only the worker. #1725 needed the author and reviewer swapped:
- Sol was its required reviewer, so Sol couldn't be chosen as worker.
- Every model that had ever written the task was excluded as reviewer.
- The only strong alternative's subscription was paused.

`replace_retained_worker` accepted Sol anyway, then dropped it and its
instruction behind a generic "no eligible replacement" message (papercut
bdd9307a).

## Outcome

- **Control.** An operator `queue.task` action `reassign_roles`:
  `{taskId, version, worker?: {profileId, reason}, reviewer?: {profileId,
  reason}, instruction?, reason, note}`.
  - At least one role is required, and so is `reason`.
  - CLI callers pass `note` naming the operator authority. It's recorded as
    relayed.
- **Preconditions,** each refused with a specific reason:
  - the task is dispatched and unmerged;
  - no merge intent;
  - no unreleased run of any role;
  - no active reviewer;
  - the version is current.
- **Preflight.** Before anything is accepted, each requested profile must be
  catalogued, enabled in the pool for its role, capable of the task, in an
  available subscription group, and pass the independence rule below. A
  failure refuses the whole control with the reason. Nothing is half-applied.
- **Effect,** in one transaction:
  - `profileRequests.worker` and `.reviewer` are replaced.
  - The recorded `reviewerProfile` and `reviewerAgentId` are cleared, so the
    next review uses the new request.
  - If a worker is requested, the retained worker is retired and the
    replacement is selected, as `replace_retained_worker` does today. The task,
    workspace, branch, PR and head are kept.
  - A `roles_reassigned` event records the old and new requests, the reason and
    the authority.
  - Finished runs, reviews and agents are never relabelled.
- **Durable continuation.** `instruction` is stored on the task before the
  control returns. It's delivered exactly once to the replacement worker's first
  revision run, or recorded as refused with the reason. It's never dropped
  silently. The same holds for `replace_retained_worker`'s instruction (fixes
  bdd9307a).
- **Independence:**
  - A reviewer must never be an agent that authored worker, revision or
    checkpoint work on the task. Historical review-only agents are not authors;
    an independent retained reviewer may keep its own reading context for an
    explicitly authorized ordinary review. Reassignment always clears the agent
    binding and creates a fresh agent on the requested profile, even if the old
    binding used that profile. A profile identity is not an agent identity.
  - The reviewer's model must differ from the model of the worker whose head is
    under review.
  - An earlier author's model is allowed only when the operator names that
    profile explicitly through `reassign_roles`.
  - The same rule applies when the review result is verified (the adapter's
    independence guard), not only when the reviewer is selected. #1725's first
    reassigned review was held because only selection had the exception.
  - Automatic selection keeps today's rule, which excludes every author model.
    This is never an automatic fallback. Admission now also refuses a required
    same-model worker/reviewer pair before the task exists
    ([Spec 030](030-routing-changes.md)); this runtime guard stays because the
    actual author or catalog can change after admission.
  - The reviewer prompt lists every prior author model and agent, so the
    reviewer knows which content it is independent of.
- **Gates unchanged.** Exact-head review, formal reviews, merge gates, revision
  budget and every brief acceptance requirement stay as they are.
- **Visibility.** Task detail shows the reassignment event. The Pipeline shows
  the task's current worker and reviewer requests.

## Acceptance

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Reassign while any run is unreleased or a reviewer is active | Refused with the reason; nothing changes |
| 2 | Stale version | Refused |
| 3 | Requested profile matches an old reviewer binding, including an actual earlier author | Accepted only as a fresh agent; old author never reused |
| 4 | Requested reviewer shares the current author's model | Refused at preflight |
| 5 | A fresh agent of an earlier author's model (#1725: Luna), explicitly requested | Accepted; recorded; the review prompt lists prior authors |
| 6 | Automatic reviewer selection after an earlier author's model | Still excluded |
| 7 | Requested worker unavailable or in a paused group | Refused at preflight with the group and reason |
| 8 | Worker plus reviewer swap (#1725: Sol worker, Luna reviewer) | One transaction; replacement worker gets the instruction once; PR and head kept; next review uses Luna |
| 9 | Replacement worker can't be created after acceptance | Instruction recorded refused with the reason; task to needs_attention; nothing silently dropped |
| 10 | History | Earlier runs, reviews, agents and models unchanged |

After steps retirement (Tom, 2026-10-07), historical review-only stage records
must not become author exclusions. Current and retired workers, revision
agents and actual work/publish records remain excluded. Saved partial reading
is evidence of that same reviewer's work, not completion or another agent's
reading. No automatic checkpoint continuation is restored.

## Explicit historical reviewer selection (retired)

Tom's 2026-10-07 continuation let an owner reuse an authenticated historical
reviewer run through `rereview`'s `retainedReviewerRunId`. It was retired on
2026-10-15 when `rereview` folded into `move to=review`: every fresh review now
binds a fresh independent reviewer. Stored records stay readable.
