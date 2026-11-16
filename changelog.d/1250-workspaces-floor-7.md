The preserved external workspace's catalog archive, the task workspace lifecycle
and the retained/accepted-PR workspace policy now have one owner per mechanism.
Most of what they do is unchanged; the behaviour changes are named below.

A catalog archive that admission deferred records that fact as a typed field
instead of a phrase in its detail line. An entry recorded before that field
existed is no longer read as a deferral: an uncertain one now counts as an
unknown native answer and waits for an owner retry, and a held one waits out its
recorded backoff, up to an hour, before it is due again.

A task workspace recovery whose Git ancestry cannot be read says so, instead of
reporting two divergent lines, and a parked accepted PR on a host that cannot
look up its workspace registration raises attention instead of creating a second
registration for one folder.

Two further changes, both on paths that used to act differently:

- A workspace creation whose data home cannot be observed no longer refuses on
  that alone: the live-data-home check falls back to comparing paths, so volume
  admission is skipped where it used to fail.
- The catalog archive's intent writer now also refuses an intent written after
  the task was removed mid-call.

The one-folder registration check during workspace creation answers a new
"unreadable" result and logs a skipped progress line when the workspace inventory
cannot be read. Nothing reads that line yet, and creation still proceeds, so an
unreadable inventory is still treated as no duplicate; the check itself is
unchanged.
