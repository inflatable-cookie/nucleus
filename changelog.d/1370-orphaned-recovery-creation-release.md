A recovery creation whose episode was replaced before it settled no longer
holds the task forever. The recovery sweep now finds each unreleased, agentless
recovery creation from the task's own creation-attempt records, not only from
the run the current episode names, so a creation whose producer threw, whose
exact lookup is empty and whose attempt has settled is released once — its
credential revoked and the run superseded with `absentProvenAt` — even when an
answered escalation, an operator return or a superseded episode dropped the
binding to it. An attempt that never settled, a non-empty lookup or an offline
host still keeps the creation owned, and an ordinary `restart` then applies.
