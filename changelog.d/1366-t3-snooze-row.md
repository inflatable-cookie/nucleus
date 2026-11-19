- T3Code: the task parent row is now snoozed while a task waits and shown again
  when a person must act, driven by one attention projection the board and
  `task.next` also read; an owner hold with a release condition and a
  prerequisite wait count as waiting, not needs-attention. Nucleus never issues
  `thread.settle` for a task thread any more, and a row an operator settled by
  hand is left alone.
- T3Code: the top-level role-thread fallback is retired. A role that cannot be
  created as the task parent's native child (provider missing or not ready, an
  archived or deleted parent, a different checkout, a parent T3 will not run)
  refuses before the send and the task waits visibly with the reason and the fix
  (`nucleus t3 install`) instead of launching a thread nothing would own.
- T3Code: support-thread tags and `thread_created` cards are gone, and a row
  title gets its own command identity per title (with its own failure label), so
  a changed title is never refused as a changed payload under a spent command.
