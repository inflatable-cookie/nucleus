A task whose workspace creation was interrupted no longer cycles on "Workspace
creation is uncertain" until someone cancels and resubmits it. Nucleus now looks
the workspace up on the host: a workspace it finds is bound, and when the host
holds nothing for the task (no workspace, worktree, branch or remote ref) the
task is requeued and dispatched again. An empty, unpushed task branch left by the
interrupted attempt is removed first; a branch with commits or a pushed ref is
never touched. After three automatic requeues the task stops and names
`record.clear kind=workspace_intent`, a new explicit command that releases the
workspace intent after a `workspace_may_exist` warning; `next` lists it for any
uncertain workspace creation.
