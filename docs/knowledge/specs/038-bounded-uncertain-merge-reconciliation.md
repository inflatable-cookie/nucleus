# 038 — Bounded uncertain-merge reconciliation

## Context

A lost response to Nucleus's sha-guarded merge request can leave the PR open and
unmerged while Nucleus holds that repository's integration turn indefinitely.
Tom's ruling on papercut `8997eeb8` (2026-10-01) is to allow one guarded
re-issue only after Nucleus proves the exact PR has stayed unmerged, then give up
and escalate if the outcome remains uncertain. Tom’s later ruling
(2026-11-04) retains the turn while a possibly delivered merge is unresolved.
Tom's ruling (2026-11-05) shortens the proof window from ten minutes to two:
"I'd be happy to shorten the merge retry wait if it's safe to do so, 10 minutes
is excessive." On `project-a-accelerator#4751` (2026-11-05) a merge request got a
blank response at 16:05:24 UTC. The PR stayed open and mergeable; the re-issue
merged it about ten minutes later, with six tasks waiting behind it. The stored
events show 10 uncertain responses against 1,406 merge intents. Of those, 8 went
to a re-issue. In the 2 where a merge appeared without one, it appeared within
3 s. The two-minute window keeps the same rule: the re-issue still waits for a
full window of continuous non-merge proof.

## Rule

While durable `mergeIntent` is set and no merge commit is verified, a check
starts or continues a proof window only when GitHub proves that the PR is open,
unmerged, on the recorded merge head and task base, has no auto-merge request or
merge-queue entry, and is mergeable with `CLEAN` or `UNSTABLE` state. Any
missing or changed fact, incomplete merge-queue observation, or unavailable
merge-queue API resets the window. Nucleus records the first complete proof and
each reset as an event.

After the proof remains complete for `uncertainMergeRetryMs` (default two
minutes), Nucleus records and sends one more merge request with the same reviewed
head SHA. The durable retry intent is written before the request so restart
cannot send it twice. If complete proof cannot reach the configured duration
within 30 minutes from the original request, Nucleus sets `needs_attention`,
records the evidence, and retains the repository integration turn until the
merge outcome is settled. An uncertain response to the single re-issue has the same attention outcome after Nucleus's
next live check confirms the PR is still unmerged. Nucleus never retries a second
time automatically. An operator may resume read-only reconciliation; only a
verified merge proceeds to sync.

The default interval is configurable per Nucleus host with `uncertainMergeRetryMs`
in `settings.json`, from 1 millisecond to 30 minutes. Existing merge gates,
exact-head review, and external-merge verification are unchanged.

## Acceptance

- A lost initial response followed by two minutes of complete continuous proof
  sends exactly one same-SHA merge request and then verifies a merged PR.
- A head/base change, auto-merge request, merge-queue entry, incomplete
  observation, or unavailable merge-queue API resets or prevents proof.
- An uncertain response to the one re-issue enters `needs_attention`, retains
  its evidence and integration turn until the merge outcome is settled, and is
  never automatically re-issued.
- If the configured proof interval cannot complete within 30 minutes, Nucleus
  enters `needs_attention` and retains the integration turn until the merge
  outcome is settled.
