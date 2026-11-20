Projects can opt in to automatic lead and papercut triage with `triage.set`. The
project planner then gets one bounded batch of its oldest open records at a time,
when records change, deferred records come due, or dispatch room opens. The
planner answers with `triage.apply`: promote a routine in-scope lead under its own
name, close a duplicate or fixed record with a canonical target, defer with a
revisit time, or raise an operator question. Records that changed since the batch
was made are superseded, and a replayed batch changes nothing. Off by default.

Planning shows the current and last completed batches, with a short digest,
outcome reasons, operator questions and links to recorded tasks.
