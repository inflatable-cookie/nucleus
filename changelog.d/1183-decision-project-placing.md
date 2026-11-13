Every board decision is tied to a project and names who asked. `decision.add`
derives the project and task from the authenticated calling thread — a run
ticket links its task, a planner or named-agent ticket gives its project, else
the linked records do — and refuses an explicit project that contradicts the
caller or a decision it cannot place. The board shows the task reference and
role, or the planner or agent name, instead of a bare thread ID, and
`decision.backfill` retargets legacy project-less decisions where the asker
still resolves.
