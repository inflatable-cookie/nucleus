Repositories can now opt into `workspaceProvider: "barge"` via `repository.set`
to lease, hold via detached `barge worktree run` custodians, move or replace,
and return task worktrees through Barge's worktree pool CLI across Paseo,
T3Code, and BB hosts while preserving local git worktree behavior for all other
repositories and existing tasks.
