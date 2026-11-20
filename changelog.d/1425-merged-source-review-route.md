The fresh review route now works for a PR that merged outside Queue. A task stopped
by an unreviewed external merge keeps the exact merged source and merge commit, so
`move to=review` reviews that merged head and only its `ready_to_merge` verdict
reconciles the merge. A negative, missing or different-head verdict keeps the stop
and sends no revision. A reobserved unchanged merge honors the planner's recorded
stop or wait instead of asking again, and the escalation names the independent review
and the operator-only source acceptance as separate routes.
