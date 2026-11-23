Nucleus puts far less load on a T3 host. It keeps one live shell subscription per
host instead of re-reading the whole shell, reads a thread's snapshot only when its
row changed, never reads a follow-up thread T3 did not create, caps thread reads at
four at a time, and answers live lists and the catalog from cache while T3 is slow.
Steady passes read no archived threads; the archived-thread prune now runs on its
own interval, every 12 hours by default (Settings → Dispatch limits → Archived
thread pruning).
