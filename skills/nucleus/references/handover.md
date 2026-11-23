# Planner handover

When the operator asks for a "planner handover", "handoff" or "hand this to a new
thread", run the whole procedure without stopping between steps. The only stop is
the model question in step 1, and only if the operator didn't name a model.

The successor takes over:

- the project's planner role;
- every open task this thread owns on the board;
- everything this thread was working on.

The old thread then stops acting.

## 1. Choose the model

- If the operator named a model ("hand over to Sonnet", "use GPT-6.2 Sol"), use
  it. Don't ask.
- Otherwise ask with the host's question card (in T3 Code and Claude Code,
  `AskUserQuestion`). Offer two to four options:
  - your recommendation first, marked "(Recommended)", with a one-line reason;
  - this thread's own model;
  - one or two alternatives that fit the work ahead, such as a stronger model for
    design-heavy planning or a cheaper one for routine queue tending.

  The operator can always type another model.

## 2. Gather before writing

Collect all of this before you write the handoff:

- **Rulings.** Every operator ruling from this thread must already be in its
  owning knowledge file (commit any that aren't), or close its entry in
  `questions.md`. A ruling that exists only in this conversation is lost.
- **Your tasks:**

  ```sh
  nucleus helper reparent --inventory YOUR_AGENT_ID
  ```

  This lists every unfinished task this thread owns, by project, and writes
  nothing. Then read `next` for each task that is stopped, escalated or awaiting
  a decision.
- **The plan:** `plan.get` for each project you plan; the lanes and their state.
- **Open decisions** this thread raised for the operator (`decision.list`), with
  their IDs.
- **Leads and papercuts** you filed or are tracking, with their state.
- **Promises:** anything you told the operator or a peer you would do later, and
  what it waits on. For example: "check the UI after #1554 rolls", "brief lead X
  once #1522 merges", "tell the Barge planner when `queue/` can go".
- **Peers:** other project planners you are in conversation with, their open
  questions, and reply addresses still valid.
- **Working knowledge:** scratch locations, workarounds you rely on (for example
  an explicit `NUCLEUS_TICKET` when the host is slow), and quirks you hit this
  session.

## 3. Write the handoff

The handoff is thorough. The successor has none of your context, and anything
missing is lost. Write it under the configured scratch root, as
`handover/<project>-<YYYY-MM-DD>.md`, never in the repository. Sections:

1. **Who you are now:** the role, the projects, the operator, and your thread's
   identity once ownership moves.
2. **Standing direction:** the operator's instructions that still apply, quoted
   word for word with dates. Include preferences about how to work (for example
   "approve by default", "decisions always in the Inbox").
3. **Plan state:** each lane, its horizon, what's done, and what's next.
4. **In flight:** one line per task: reference, title, phase, what it's waiting
   on, and the next action, with who takes it. Group them as running, waiting
   on review, stuck or needing you, and queued behind dependencies.
5. **Waiting on the operator:** decision IDs and open questions, each with your
   recommendation.
6. **Promises and follow-ups,** each with its trigger.
7. **Recent rulings** landed this session, with the file each one lives in.
8. **Peers and routing:** open conversations and reply addresses.
9. **Known issues and workarounds:** open papercuts that affect your work, and
   how you've been handling them.
10. **Where things are:** specs, scratch directories, evidence and memory notes
    worth reading.

## 4. Start the successor

In T3 Code, use `t3_thread_launch`:

- the same project, `workspaceStrategy` `root` (the project checkout, never a
  worktree);
- `modelSelection` from step 1;
- the operator's runtime mode;
- a title such as "Nucleus planner";
- this first prompt:

  ```text
  You are taking over as the <project> planner from thread <old link>. Load the
  `nucleus` skill. Read the handoff at <path> in full before acting. Ownership
  of the planner role and the project's tasks is moving to you now; wait for
  "Ownership transfer complete" before running owner commands. When it arrives:
  take your participant ticket, tell every peer planner in the handoff's
  routing section that you are the new planner, then continue from "In flight".
  ```

  Include the handoff inline as well when it fits (under about 100k
  characters), so the successor doesn't depend on reading a file.

On another host, start the equivalent top-level thread with the same prompt.
Record the successor's thread ID and link.

## 5. Transfer ownership

From this thread, with your Nucleus ticket. Move the tasks first: assigning
the planner role revokes your participant ticket.

1. **Tasks:** for each project in the inventory:

   ```sh
   nucleus helper reparent SUCCESSOR_AGENT_ID --project PROJECT --from YOUR_AGENT_ID --reason "Planner handover"
   ```

   Move any task outside those projects with the `--task` form; see
   [Change a task's owner](../SKILL.md#change-a-tasks-owner).
2. **Planner role:** `project.set-planner` with the project `key` and the
   successor's agent ID. This revokes your participant ticket and issues the
   successor's, which it takes on its next authenticated call.
3. **Check:**
   - `nucleus helper reparent --inventory YOUR_AGENT_ID` now lists nothing;
   - the same inventory for the successor lists the moved tasks;
   - `project.get` names the successor.

   If anything didn't move, fix it before going on.

## 6. Hand over and yield

- **Tell the successor** "Ownership transfer complete", with any last facts
  that changed while you were transferring. In T3 Code, use `t3 thread send`;
  elsewhere, `nucleus tell` to the successor.
- **Tell the operator,** in your reply:
  - the successor's link and model;
  - the handoff path;
  - how many tasks moved;
  - anything that didn't move.
- **Stop acting** for the project. If a message reaches this thread afterwards,
  point the sender to the successor and do nothing else. Leave the thread as
  history; never archive it during the handover.
