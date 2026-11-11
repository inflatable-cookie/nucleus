A base-identical, unpublished orphan branch or worktree left by a failed creation
is now cleared and the creation replayed by recovery itself, from the parked stop
the failed dispatch left, with the same proofs as before (base identity,
unpublished, no live owner, one automatic attempt). The orphan stop names the
owner verb and fields that exit it — `retry_effect effect=workspace_creation
discard=true` — instead of an internal parameter, and `next` offers that verb. A
checkpoint-continuation wait is derived only from a current, unreleased reviewer
run: when the named run is superseded or released, the wait no longer stands and
the task proceeds to dispatch a reviewer, or shows why it cannot.
