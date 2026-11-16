Queue's own code is reorganized along the seams the efficiency review named, with
no change to dispatch, archive, retirement or drain behaviour. The lane drain
pass now lives with planning (`core/planning/lane-drains.ts`) and reads each fact
it needs through the owner of that row, so lane storage no longer holds planner
routing, idle-plan re-versioning or notice policy; a drain episode decided for a
lane that no longer exists now fails the pass instead of being dropped silently.

The projections that run outside the delivery lanes each have one owner: the
workspace-title intent and its drain, the workspace-cleanup lane and its retry
timers, runtime-retirement scheduling, and the occurrence ledger a wake waits on.
A title sync reads only the tasks its title names rather than every task, and a
task whose row is gone is treated as nothing to title instead of a caught throw.
