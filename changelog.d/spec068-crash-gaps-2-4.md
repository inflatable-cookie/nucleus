A spent task budget now holds every worker start, not only run launches: a dead
initial worker's redispatch, a resumed dispatch or a failover extends a first
spend once and stops on a second, with the budget command, instead of starting a
fresh worker. Stall windows on the coordinator route no longer count the time the
service or the task's host was down, so a restart does not launch a coordinator
for an ordinary wait such as pending checks.
