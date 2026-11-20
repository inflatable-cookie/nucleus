- T3Code: Nucleus leaves an operator's snooze alone on any thread that is not a
  task row. A task row's snooze is renewed, reported as hidden and unsnoozed only
  when a verified same-task parent binding and a fresh read show exactly the
  horizon this host wrote, so a replaced horizon, an ambiguous legacy record or a
  stale binding is never overwritten or cleared, and a read-back that is not the
  horizon the command asked for is never adopted. No snooze or unsnooze command
  addresses a planner, the Inbox or an unrelated thread.
- T3Code: a Nucleus message no longer wakes a thread the operator snoozed. T3
  clears a thread's snooze on an ordinary delivery, so the adapter refuses that
  send before it leaves and the durable notice waits for the thread to wake
  instead; a thread Nucleus settled by hand keeps its distinct unsettle-and-
  deliver rule.
