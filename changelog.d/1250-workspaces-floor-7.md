The preserved external workspace's catalog archive, the task workspace lifecycle
and the retained/accepted-PR workspace policy now have one owner per mechanism;
what they do is unchanged, with four named exceptions.

A catalog archive that admission deferred records that fact as a typed field
instead of a phrase in its detail line. An entry recorded before that field
existed is no longer read as a deferral: an uncertain one now counts as an
unknown native answer and waits for an owner retry, and a held one waits out its
recorded backoff, up to an hour, before it is due again.

The one-folder registration check during workspace creation records on the
creation step trail that it was skipped when the workspace inventory cannot be
read; creation still proceeds. A task workspace recovery whose Git ancestry
cannot be read says so, instead of reporting two divergent lines. A parked
accepted PR on a host that cannot look up its workspace registration now raises
attention instead of creating a second registration for one folder.
