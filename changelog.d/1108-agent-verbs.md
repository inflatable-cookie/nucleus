Agents now have two verbs for talking to Nucleus's roles, on every host. `ask` puts a question that waits for an answer and escalates; `tell` sends information only and never waits or escalates. Both name a recipient, never an agent or thread ID: the reviewer, the planner, a worker, a task's worker, reviewer or planner, a project's planner, or a named project agent. Nucleus resolves each recipient from the caller's own run, so the same call works on a Paseo session through MCP and on a T3 run through `nucleus ask` and `nucleus tell`.

Before any message is sent, Nucleus observes the recipient thread. An archived or gone thread is never sent to: an `ask` moves on to the next rung (the project planner, a decider, then the board), and a `tell` to a planner with no live planner waits in that project's inbox and reaches the next live planner. A named agent that is archived or gone is refused with its state.

A message labels its sender by role and project ("the effigy planner", "effigy#590 (worker, project Effigy)") rather than by thread. Planners and named agents can tell a task's role or a project through their own ticket.

`nucleus_ask` and `nucleus_message` remain as documented aliases for this release, so retained sessions keep working. Their prompts and the Nucleus skill now use `ask` and `tell`.
