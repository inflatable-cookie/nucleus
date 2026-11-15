The blocker ladder is one module. A blocked task's reviewer consult, planner
escalation and operator classification now live in `core/questions/ladder/`
instead of being split across a pure half and a driver that repeated its rules.

The cause and run a recorded consult or escalation names are read from the typed
record the ladder writes next to it, rather than matched out of its summary line.

Delegated questions read subscription availability and a task-addressed answer
through typed owners. When Nucleus cannot issue a planner's answering ticket, or
cannot archive a spent decider, the failure is recorded on the delegation instead
of being dropped.
