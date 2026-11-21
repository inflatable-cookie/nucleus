Finished T3 task parents now leave the Snoozed list on their own.

The parent archive used to run after the Inbox and decision-card reads inside the
title pass, which returned early on a fault and was skipped when an earlier step
timed out the pass. Done Nucleus tasks therefore kept a snoozed parent with no
recorded archive command. It is now its own host-pass step, settled from the
durable parent binding before any presentation read: at most four parents per
pass, oldest attempt first, released and then archived through the recorded
command, and settled only once the same thread reads archived. An unknown
delivery is read before any repeat, so a service roll settles it instead of
resending. A parent that cannot be archived is recorded on the task with a typed
reason. Operator snoozes on other threads, active task rows and the three-day
thread retention pass are unchanged.
