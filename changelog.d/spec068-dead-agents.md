Dead agents and uncertain launches now recover without a planner (Spec 068
batch A). A run whose recorded process is provably gone, or whose thread its
host no longer has on a complete read, is released and relaunched: a fresh
reviewer at the same head, or a revision on a fresh worker when the retained
worker's thread is gone. An uncertain creation is looked up by its labels for
every role: one match binds it, a complete absent read after the grace releases
it for one relaunch, and a partial read waits with its reason named, up to three
automatic relaunches before a typed stop. A `run_stalled` stop admits its
coordinator, a stop naming a replaced run clears, `next` offers
`run.start worker fresh` when the retained worker is gone, `run.start` warns
`discard_reported_verdict` before replacing a reviewer whose verdict is not yet
applied, and a reviewer whose turn keeps running after its report has that turn
stopped so its verdict applies. Process-death release is ported from
nucleus#1552.
