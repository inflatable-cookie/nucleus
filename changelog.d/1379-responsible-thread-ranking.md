Project messages reach the right thread. Responsible-thread resolution now ranks a
live registered planner first, then a thread that dispatched or owns project tasks,
then a named agent, and only then a thread that merely works in the checkout. A
task-labelled thread that is registered stays a candidate, matching a registration
by the host its own identity proves, so a Paseo, T3Code or BB planner is no longer
passed over for a more recently active design thread in the same repository. A
`tell` from the resolved thread to its own project skips the sender and reaches the
next candidate, or records that the sender handles it, instead of echoing back.
`project.get` and the project settings row show the ranking reasons (registered
planner, dispatcher, named agent, repository worker) beside the host, last
interaction and cache age, so a routing choice can be checked.
