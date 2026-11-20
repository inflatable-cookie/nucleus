# Handover

A planner (Chatterbox) hands over to a fresh successor when it needs a clean
context, a different skill, or a different model. The successor continues the
same planning. Nothing about the handover is written into the repository.

## Before handing over

- **Land every ruling.** Anything the operator decided in this thread goes into
  its owning knowledge file, or closes its entry in `questions.md`. A ruling
  that exists only in this conversation is lost at handover.
- **Note what's in flight:** Queue tasks this thread submitted or is watching,
  and anything waiting on the operator.
- **Check what you still own outside the project you are handing over.** The
  one read-only inventory lists this thread's own unfinished tasks by project,
  the selected project first and everything else as what a project-scoped
  handover leaves behind:

  ```sh
  nucleus helper reparent --inventory YOUR_AGENT_ID [--project PROJECT]
  ```

  It reads the same owner facts a reparent moves and writes nothing, so holds
  and pending notices are untouched and no notice is sent. A thread may run it
  for itself, and the operator may run it for any thread, including an archived
  or gone one. It refuses an identity no registered host proves and an unknown
  project.

## Steps

1. **Start the successor** in the same workspace, with the same provider and
   model settings and the `Chatterbox=true` label. Tell it to load
   `nucleus` for planning. Documentation structure stays in `northstar`.
2. **Brief it in its first prompt.** The brief is Queue-held, not a repository file. Keep the brief
   short:
   - the current state;
   - what's in flight;
   - what's waiting on the operator;
   - any instruction it must carry on, quoted word for word.

   Everything durable already lives in the repository. The brief only points at
   it.
3. **Move task routing** so completion and attention notices reach the
   successor. From this thread with its Nucleus ticket or host identity, reparent its open tasks for each project:

   ```sh
   nucleus helper reparent SUCCESSOR_AGENT_ID --project PROJECT --from OLD_OWNER_AGENT_ID --reason "Planner handover"
   ```

   For tasks outside those projects, use the `--task` form in
   [Change a task's owner](../SKILL.md#change-a-tasks-owner); the inventory in
   "Before handing over" names every one a project-scoped reparent leaves
   behind. Check the result
   and the task set. The project form moves open tasks owned by the old thread;
   it moves each task's own planner with that owner and does not change the
   project's planner.
4. **Route project notices** to the successor with `project.set-planner`. Project
   ownership and `project.claim` are retired; see the project commands in
   [SKILL.md](../SKILL.md).
5. **Tell the successor** `Ownership transfer complete` as a background message.
6. **Yield.** Leave this thread as history; the successor continues planning.
