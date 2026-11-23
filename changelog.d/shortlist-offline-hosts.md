A project's registered planner and a task's own recorded or origin planner now
pass explicit-command and force authority from their stored registration and
the caller's identity, with no live host read. Other planners are judged by
their own host's inventory, so an offline or unread host elsewhere no longer
refuses them, and a planner whose host was not read in a call falls back to
that host's last read within 10 minutes. The sweep no longer reads project
shortlists without a host whose pass failed, which had invalidated every other
caller's read in flight and left planners refused.
