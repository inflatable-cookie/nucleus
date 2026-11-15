The blocker ladder is one module. A blocked task's reviewer consult, planner
escalation and operator classification now live in `core/questions/ladder/`
instead of being split across a pure half and a driver that repeated its rules.

Each recorded consult or escalation keeps its readback identity: the cause is
read from the record's own line, which is what the episode id derives from, while
the run, question and refusal class come from the typed payload written beside it.

Delegated questions read subscription availability and a task-addressed answer
through typed owners. When Nucleus cannot issue a planner's answering ticket, or
cannot archive a spent decider, the failure is recorded on the delegation instead
of being dropped.
