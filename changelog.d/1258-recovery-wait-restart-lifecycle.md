A recovery coordinator that finds a worker or reviewer live reports a settled
no-op instead of blocked, so Nucleus does not escalate or start another recovery
for the same cause while that participant stays active. A planner timed wait on a
recovery escalation resumes the task's ordinary next step when the wait ends,
even if the raising recovery run has already released. Owner restart keeps the
task's project slot so a restarted in-progress task never goes to the back of
the queue.
