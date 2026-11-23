# Brief

A brief tells one worker what to achieve. It lives in Queue as the body of a
lead from its first version, so it is visible on the board before approval. It
is never a file in the repository or a loose file on disk.

## Template

```markdown
---
title: Farmyard mock drafts, review and resume
queue:
  lane: mock-exams
  laneDocuments: [mock-exams]
  scope: general
  complexity: medium
  notifyOriginOnCloseout: true
---

## Outcome

What will be true when this is done, in one short paragraph.

## Context

Links to the owning knowledge files and question IDs. Link; don't restate.

## Constraints

What must not change, what is out of scope, and any operator rulings that
bound the work.

## Acceptance

How a reviewer will know it is done: behaviour, and the targeted checks that
prove it (named tests or selectors). Full QA isn't part of a task.

## Stop and report if

The conditions where the worker should stop rather than guess.
```

`queue.laneDocuments` pins the lane document's current version into the
worker's prompt; add it when the worker needs the lane's wider intent. Queue
needs only `title` and a non-empty body; the sections are Northstar's
convention.

## Writing a good brief

- Aim at the outcome. A capable worker picks the steps.
- Leave model choice to Queue. Every brief needs `complexity` (`very_low` to
  `very_high`): how capable a model the work needs, not its size. Use `medium`
  for ordinary work (Worker profiles), `high` for subtle or cross-cutting
  changes (starts on Worker and may step up to Heavyweight after review
  changes), and `very_high` only when the work needs Heavyweight from the
  start. For work that needs a particular profile, a planner can name it in
  `profileRequests` with a reason for each role. At Low, Normal and High,
  this is how a role gets Frontier. The request applies on that role's first run.
- Keep it short. If it needs pages of context, that context belongs in
  `docs/knowledge/` or the lane document, and the brief links to it.
- Name what the worker must update in `docs/knowledge/` if the work changes
  what is true.
- One brief per independently reviewable PR, in one repository. Cross-repository
  work is several linked tasks (`queue.dependsOn`).
- Submit approved briefs straight away, however full the board is. Slots limit
  running, not queueing, and `queue.dependsOn` sets the order (see "Queue every
  approved brief" in [SKILL.md](../SKILL.md)).
- Queue numbers each task per repository (`repo#N`). Quote it to the operator,
  and start the PR title with the bare number (`304: Title`). On GitHub, `#304`
  would link an unrelated PR.
- Make acceptance about behaviour, not text. A grep-based check can push a
  worker into rewording files it shouldn't touch: answered questions in
  `questions.md` keep their original wording.

## Lead, approve, promote

From any directory, with the payload on stdin
(`nucleus METHOD - <<'JSON'`, the JSON, then a closing `JSON`
line; see [SKILL.md](../SKILL.md)):

1. **Write:** `lead.add` with `repositories` (a list of `{origin, path}`),
   `title`, the complete brief Markdown as `body`, `lanes` and `author` (your
   agent ID). Queue checks the brief as coming from the creation `author`, and
   a later edit can't change it: with a display name the check fails with
   "Agent not found", and the only fix is `lead.drop` and a new `lead.add`. A body with brief frontmatter makes it a brief-bearing lead:
   Queue checks each version at the pushed head. The result gives its `version`,
   `digest` and `check`. A lead that already holds the idea gets the brief
   through `lead.edit` instead.
2. **Revise:** `lead.edit` with `id`, the current `version`, the complete new
   `body` and `author`. Any edit clears approval and the check, and Queue
   checks the edited version. `lead.submit` checks the current version again
   too, so a submission after a fix never returns the old failed check. A
   version that fails its check can't be approved; `lead.get` shows versions,
   digests and checks.
   `lead.check` with `id` re-checks the current version on demand. It takes an
   optional `hostId` with the same meaning as on `lead.submit`, and the calling
   thread's identity, which Nucleus stamps from the CLI, decides the origin host
   of a brief that notifies its origin, as at promotion.
3. **Approve:** only after the operator has authorized this brief, or under the
   standing routine-dispatch ruling recorded in [Spec 026](../../docs/knowledge/specs/026-planning-records.md)
   (Tom, 2026-11-20: the planner decides whether to dispatch an ordinary
   in-scope brief). Product or scope changes, releases
   and other reserved operator actions still need the operator. A relayed
   approval under the standing ruling names that ruling and the brief it
   covers, with `relayed: true`.
   `lead.approve` takes the latest `id`, `version` and `digest`, `approver`
   (your agent ID), `relayed: true` and a `note` naming the authorization
   ("Tom approved in the planning thread on 2026-09-27"). The operator can
   also approve on the board. A brief that should wait simply stays an open
   lead.
4. **Promote:** `lead.promote-task` with `id`, `agent` and the authorization
   `note` (plus `repository` when the lead lists several) re-checks and returns
   the `taskId`. A refused promotion admits nothing and keeps the approval:
   repair the condition and promote again.

A papercut promotes directly: `papercut.promote-task` with `id`, `agent`,
`complexity` and an authorization `note` turns its text into the brief.

`notifyOriginOnCloseout: true` tells the submitting planner thread when the
task closes; `completionNotificationAgentIds` notifies other threads. To change
a brief after promotion and before merge, use Queue's `amend_brief` control;
don't create a second lead.

`queue.planner: AGENT_ID` names the thread that answers this task's planning
questions first and hears its task-level notices. Unset means the submitting
thread; reparenting the task moves it. The project planner answers only when the
task planner cannot, and a short-lived decider follows (task 1109).
