Recovery now has one owner per stage: the coordinator route that decides a task
needs recovery, the pass that observes its run, the episode that records its
result, the pure report rules and the owner-verb settlement. Worker failover sits
in dispatch where the next round is chosen, the retired-worker observation
cadence and the archive of retired errored agents have their own modules, and the
owner's no-automatic-retry intent is read once. A refused or unreadable archive
is recorded instead of dropped, availability is read as the store's typed rows,
and a provably empty Git commit count no longer spawns a process on the callback
path. Behaviour is unchanged.
