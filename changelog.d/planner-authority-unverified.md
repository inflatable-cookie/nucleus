### Fixed

- A registered planner keeps its authority to force a task move and to run explicit commands while its host is still unverified after a service or host restart. Host observation now only decides where messages are delivered.
- A refused force or explicit command names the reason: no authenticated caller, or a caller that is not the task's planner, the Nucleus planner, the operator, or (for force) the task's own run.
