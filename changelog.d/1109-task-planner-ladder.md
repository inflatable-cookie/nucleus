Each task now records its own planner, and Nucleus asks it first: a task's
planning questions, blocker escalations, proof waits and board-question notices
reach the thread that submitted or promoted the task (or the thread its brief
names with `queue.planner`) before the project planner. A project planner that is
a different thread is the fallback rung, then the short-lived decider, then the
board for operator-only kinds; a rung observed archived or gone is skipped at
once. Reparenting a task moves its planner with its owner. Task planners receive
a participant ticket scoped to the tasks they plan, so they can answer with
`nucleus question.answer` on any host, and `task.next` and the question records
name the rung that asked and the thread that answered.
