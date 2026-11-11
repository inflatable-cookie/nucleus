# 051 — Interactive tasks

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-10-18
Decision owner: operator (Tom, 2026-10-18: "build this into the queue as a priority")
Governing refs: [Spec 050](050-owner-task-controls.md) (stops and owner verbs),
[Spec 020](020-briefs-stored-in-queue.md) (brief frontmatter),
[orchestration contract](../contracts/orchestration.md)

## Problem

The operator often wants a strong worker to build a first tranche from a brief,
then to work with that same thread directly: try the result, ask for changes,
refine it. Only when the operator is happy should the worker submit for review.
An ordinary worker reports as soon as it finishes. If it stops without
reporting, Nucleus treats that as a missing callback: a reminder, then an
incident, then a coordinator. The worker's brief-bound scope also fights the
operator's in-thread requests.

## Rule

A task is interactive when its brief or handoff frontmatter sets
`queue.interactive: true`, or its `queue.submit` input sets `interactive: true`.
Absent means not interactive; legacy submission identity is unchanged.

1. **Worker prompt.** The worker implements the first tranche the brief
   describes, then ends its turn without reporting. It summarizes what it built
   and how to try it. The operator's direct instructions in the worker's thread
   are its authority: they may extend, narrow or change the scope, and the
   worker follows them rather than refusing on scope grounds. It reports
   nothing (no readiness, checkpoint, blocked or error) until the operator says
   submit. Then it commits, pushes its queue branch, opens the PR and reports
   `ready_for_review`. The one exception to reporting nothing is its own
   provider's quota exhaustion; Nucleus refuses a checkpoint report during the
   session. Fixed rules the operator's instructions do not override:
   stay on the queue branch in its workspace, never merge, never dispatch other
   workers or coordinators, never `git stash`, never report readiness the
   operator has not asked for.
2. **Session lifecycle.** The session is open until the worker submits. Any
   submission evidence closes it for good, even across a replacement worker: a
   completion, any PR evidence (a failover keeps `resumePrNumber`), a review, or
   a revision or reviewer run. While it is open and the task is `working`:
   - a live turn reads "Interactive session: the worker is running" (a
     `lifecycle` wait);
   - an idle thread is the typed wait `interactive` with no owner verb,
     "Interactive session: waiting for the operator in the worker's thread".
   No stall detection, completion-delivery grace, callback reminder, incident or
   coordinator recovery applies. A worker that resumed after a transient
   provider error and went idle is back in its session, not missing a result.
   An errored or closed thread is handled as any stopped worker. `task.next`
   offers no `move to=work` during the session, since the worker is already
   working.
3. **After submission.** The `ready_for_review` report ends the session. From
   there the task follows the ordinary flow: independent exact-head review,
   revisions, merge and closeout. Revision runs are not interactive. The
   operator can still message the thread, but Nucleus drives the revision turns as
   usual.
4. **Changing the mode.** An `amend_brief` whose frontmatter states
   `queue.interactive` changes the mode only while the task is queued and
   undispatched, because the worker prompt carries the mode. After dispatch such
   an amendment is refused. An amendment that omits the key leaves the mode
   unchanged.
5. **Visibility.** The board card shows an "Interactive" badge for an unfinished
   interactive task, and "Interactive · your turn" while it waits on the
   operator. `task.next` and the task detail show the `interactive` wait.

## Boundaries

- The operator's authority comes from the operator being in the thread, not
  from the document: the flag only says the operator wants a session.
- Review independence and exact-head merge gates are unchanged. Interactivity
  never skips review.
- An interactive task holds its project slot for the whole session, like any
  dispatched worker.
- Pick the model with the existing `profileRequests.worker`. A frontier profile
  still needs an explicit per-role request and reason.
