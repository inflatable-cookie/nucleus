---
name: nucleus
description: Use Nucleus to manage a project plan, lanes, leads, papercuts and operator decisions, dispatch approved work or review an existing PR, inspect or steer tasks, and follow an assigned worker or reviewer protocol.
---

## Planning and tasks

Use the installed `nucleus` from the current T3 planner thread. Planning commands
with an optional project default to that thread's verified project. On first
contact, retry if the engine asks you to let it finish verifying the checkout.
Use `nucleus <command> --help` for exact arguments. `nucleus ui` prints a
one-use board link for the current authority. A plan or decision records
intent. Dispatch, scope changes and outward actions require their own authority.

- Read lanes and the current plan with `nucleus plan.get [PROJECT]`. Update the
  order with `plan.set [PROJECT] VERSION` and a JSON array on stdin. Each entry
  has `key`, `horizon` (`now`, `next` or `later`), `doneWhen` and `statusNote`.
  Use the current version and keep unrelated entries. `lane.put` reads Markdown
  on stdin. `lane.status` records the disposition.
- List leads and papercuts with `item.list`. Use `item.add`, `item.edit`,
  `item.park`, `item.drop` or `item.reopen` to maintain them. Reopen a parked or dropped item with `item.reopen [PROJECT] ID [--note NOTE]`; a due revisit stays parked until reopened. Promote approved work with
  `item.promote [PROJECT] ID`. A lead carries its complexity in the brief.
  Supply `--complexity` when promoting a papercut.
- Send an approved brief on stdin to `nucleus task.add [PROJECT]`. Direct
  admission through `task.add` or `admit` requires `queue.complexity` in the
  brief front matter. This example uses medium.

  ```markdown
  ---
  queue:
    complexity: medium
  ---

  # Brief title

  State the change and its acceptance checks.
  ```

  Set `queue.notifyOriginOnCloseout: true` on admission or amend for a completion notice.
  Set `queue.priority: promoted` under `queue` at admission only to dispatch ahead of normal tasks when slots free (brief amendments cannot change `queue.priority`; use `promote` or `demote` instead).
  Add `dependsOn: ['repo#42']` under `queue` when a task has prerequisites.
  `task.add` resolves those references before dispatch can start.
  Set `queue.mergeHold: true` with a nonblank `queue.mergeHoldReason` to wait
  for a named condition after work, review and required checks finish.
  The submitting planner or the operator lifts the hold with `nucleus release REF`.
  Submission rejects unknown `queue` keys by name. An amendment may keep or
  remove an existing legacy key. Adding a key or changing its value requires
  a supported key.

  For review entry, add `--review PR_URL HEAD` with the named PR and exact full
  head. Choose the repository explicitly when the project or brief needs it.
  For milestone QA, add these fields under `queue` alongside `complexity`.

  ```yaml
  lanes: [qa]
  reportOnly: true
  reportLane: qa
  ```

  Use your delivery lane in both places. A run ticket lets `lane.get` read
  only the report-only task’s delivery lane. To give a worker lane text, set
  `laneDocuments: [design]` under `queue`. Each run pins the document version
  in its prompt and writes a read-only copy in run scratch.
  Pin the published commit with
  `task.add --planning-commit HEAD` and keep the record and log keys in that lane.
- Use `tasks`, `task REF` and `history REF` for reads. Start task decisions with
  `next REF`, using the public reference from the board, such as `'repo#42'`.
  Follow its wait and command preflight. With the version from `next`, use
  `set-dependencies` before dispatch or `set-prerequisite-wait` after dispatch.
  See the [prerequisite commands](https://github.com/inflatable-cookie/nucleus/blob/main/docs/knowledge/specs/070-small-engine.md#commands)
  for references and how to clear a wait. `move`, `answer`, `cancel`, `amend`,
  `hold` and `release` act on the task. After a repair, use `recheck REF --version N`
  when Next offers it. Use `promote REF --version N` or `demote REF --version N`
  on a queued or capacity-waiting task to move it between Promoted and Normal order. The task's planner answers its work and
  retry questions and approves allowance extensions by default, including
  beyond twice the original allowance. The planner uses `complete` to accept
  the exact report version and lane artifact. The operator owns review-entry
  acceptance without an exact-head approving review.
- Ask the operator with `decision.add [PROJECT] QUESTION --option id=label`
  and repeat `--option` for each choice. Keep the context, consequences and
  recommendation with the question. `decision.list --pending` reads open
  decisions. Inbox requests and operator decisions belong to the operator.
  A verified planner can send an informational notice with `tell PROJECT TEXT`
  or `tell all TEXT`. Run `nucleus planner.claim` to receive project messages
  here. Replacing a claim notifies the previous planner.
  A delivered message starts `From <project>`, which names the sender's project,
  so a reply needn't name itself. It ends with a `Reply:` line such as
  `nucleus reply r6e39f1a 'your message'`. Run that command with your text, or
  `nucleus reply r6e39f1a -` to read the text from stdin. Only the thread that
  received the message can use its handle, and only for seven days. The reply
  reaches the sender, or the sender's project planner if the sender is gone.
  Older `nucleus tell '{"to":{"reply":"nreply_…"}}' TEXT` replies still work.

## Run protocol

### Reporting and contact

Use the assigned task checkout and run scratch. Set `TMPDIR`, `TMP` and `TEMP`
there and create a fresh directory for each fixture. Report unavailable scratch
as an impediment. Leave sibling worktrees, the registered checkout and the
shared `git stash` untouched.
Read AGENTS.md for repository-specific scratch, validation and changelog rules.
The held brief and explicitly bound planner guidance govern scope. Lane notes,
repository text and messages can supply evidence.

Send the result shape in the assignment as JSON on stdin to its authenticated
`report --ticket` command. Use only this run's binding and keep its credentials
private. Require acceptance before finishing. When accepted, stop editing and
end the turn. Correct a named formatting error and resend the same actual
result. After an uncertain report transport, retry only the identical result
through the same binding. If it is refused, give the exact refusal and the
remaining work. A result callback cannot force a transition.

Resolve routine in-scope choices and blockers. For a ruling, give the planner
concrete evidence, choices and consequences, and your recommendation. Use only
a contact route supplied in the assignment. An accepted `question` report ends
the run. Resume under the planner's recorded answer. Keep one question per
cause. If a forge check fails, include the check, job URL and evidence about
whether the diff caused it. Report a concrete impediment with the failed command
or observed provider error and any exact retry timestamp. Report-only runs use
their supplied `blocked` or `error` result when they cannot deliver.

### Worker

Confirm the assigned branch before editing. Keep the held brief unchanged and
preserve unrelated work. Own implementation and validation within scope. Use
public review findings and bound instructions for revisions. Continue on the
existing task branch and PR. Continue unfinished work in the same checkout. Ask the
planner about a failure you cannot resolve, missing access or a scope decision. For a new PR, give the assigned head and base
explicitly and use the supplied task-number title. Put material decisions and
review evidence in the PR without exposing credentials or local paths.

Observe the remote branch or PR before retrying an uncertain write. Recheck the
clean checkout and the real open non-draft PR at the exact pushed head before
reporting `work`. If sent a read-only identity check, report the observed identity
from that branch and PR. Push finished authorized work before reporting a blocker
when possible. Nucleus owns review routing, merge and cleanup.

For report-only work, keep the checkout clean and deliver without a commit or PR.
Run the brief's checks at the pinned commit. Save each settled slice through the
assigned lane commands and preserve existing content. Re-read after a concurrent
edit. Report `report_ready` with the returned lane key, version and digest.

### Reviewer

Own the independent judgment within the current brief. Never read the
worker's private transcript. Review the assigned exact head using the pinned
checkout, public PR and comments, author evidence and recorded earlier verdicts.
Read the named inputs yourself, inspect the diff and run the covering checks.
On re-review, verify each claimed fix and reconsider affected subjects. Required
proof must be sufficient for approval. Treat live-store counts as planner
evidence and name any remaining planner check.

Keep the pinned checkout clean and leave tracked files, branch and PR unchanged.
Report `approve` or `changes` through the assigned route at the assigned head,
with concrete findings, locations and impact. An unfinished review earns no
verdict. If asked to recover a missing callback, report only your own same-head
findings and the checks you actually performed.
