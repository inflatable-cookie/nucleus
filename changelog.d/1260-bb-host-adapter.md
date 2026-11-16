BB (getbb.app) joins Paseo and T3Code as a designed Nucleus host. The new design
note puts one BB workspace per task, with the worker, reviewer, coordinator and
proof executor threads sharing the task's worktree and the whole group nested
under the task's planner thread — the Paseo plugin cannot do that nesting, which
is the reason BB is worth hosting.

It settles the seven open decisions: host operations run through the BB plugin's
own typed SDK over the existing authenticated service socket, Nucleus keeps the
worktree and attaches it as an unmanaged path, threads report through the
packaged Nucleus helper with a run ticket, presentation keeps the planner's group
and BB's own list instead of inventing a settle state, the board and Settings
live in BB's plugin slots with composer pills for decisions and questions, usage
and observation come from bounded chunked thread reads plus the thread's own
context, and a planner gets its terminal as a native tab.

BB stays opt-in per repository and Paseo stays the primary host. The plan starts
with a spike that proves the transport and the create → spawn → observe → archive
lifecycle before any host registration is wired.
