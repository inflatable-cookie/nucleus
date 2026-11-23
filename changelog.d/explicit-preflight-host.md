The explicit commands (`merge.now`, `closeout.now`, `run.start` and the rest)
now run their preflight, plan, apply and finish steps on the task's own host.
`merge.now` on a task bound to a non-default host no longer refuses with
"GitHub merge observation is unavailable" when the PR is open and approved at
the exact head.
