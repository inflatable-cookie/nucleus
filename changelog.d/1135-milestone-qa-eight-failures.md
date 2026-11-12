Milestone QA run 88c941de found eight red tests on main after a day of
single-file runs. Five were tests nobody updated after deliberate changes:
the ladder prompt names the ask verb's reviewer recipient with `to:` since
#1108, the reviewed handoff-prompt snapshot lacked #1126's malformed-report
refusal paragraph, the Pipeline visual test lacked #1113's Usage destination,
and the old publication-continuation and planner-target ask tests still
pinned pre-#1106 and pre-#1108 routing. One was a real regression: #1126's
hoist computed the launch environment even for hosts that take no per-thread
environment (T3), so #1105's empty-environment contract failed on a recorded
run temp directory it no longer discards. One was a board-load race: the
hostRunReady test re-proved socket acceptance with a 200 ms budgeted probe
that measures scheduler starvation instead of the bind; it now asserts the
endpoint's own serving state and one budget-free acceptance. Spec 058's ask
bullet records the task 1108 named-recipient routing, and the legacy `target`
field docstring matches it.
