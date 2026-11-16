A task registered with `task.register` now keeps the calling thread's worktree as an **external**
workspace for its whole lifecycle. Registration proves no live task already writes there and records
`workspaceOwnership: external`, so preflight and worker continuations run in that directory with no
Queue-allocation refusal, its build output is never a Queue cleanup candidate, and no archive path
(closeout, cancellation retirement or operator removal) touches it: the folder, its files and the
branch stay in place. Registration also proves the directory is free once a
superseded or cancelled task preserved it, and the `task.register` response now carries the caller's
reporting binding (run ID, helper, ticket path, and the MCP binding path when the host uses one).
