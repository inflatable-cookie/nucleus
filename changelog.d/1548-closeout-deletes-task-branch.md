Closeout now deletes the branch Nucleus created for a task once its worktree is
gone: the task branch in the registered checkout and on GitHub, and a retained
reviewer's local view branch. The deletion is a recorded closeout effect, so an
unknown answer is observed before any retry and a failure is shown in the task's
closeout facts and retried later, never blocking the task's completion. A branch
is kept when another open PR uses it, when it is the default or integration
branch, when the merged commit does not contain its head, or when another task
owns it; cancelled tasks keep their branches because their work may be the only
copy. Branch lists on the board's repositories therefore stay clean without a
manual sweep.
