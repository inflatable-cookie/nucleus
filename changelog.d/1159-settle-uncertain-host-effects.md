Uncertain host-effect operations now settle themselves once the task's own
later evidence answers them, and a review blocked on an uncertain side effect
becomes attention instead of a quiet wait.

- A `project.create`, workspace or thread creation whose delivery was unknown is
  settled as delivered, with the evidence recorded, when the task recorded a
  workspace binding after the control was accepted and a run used that
  workspace since. Review dispatches without a human step, and `retry_effect`
  settles the same operation without `force`.
- Only a blocking uncertainty gates a phase: an operation later evidence has
  answered no longer fences review or merge or reviewer continuation.
- A phase blocked on an uncertain effect past a short bound raises attention
  naming the blocking effect with `retry_effect` suggested, and the task's owner
  gets the ordinary attention notice. The phase is kept, so the answer resumes
  the same review.

Unknown delivery is still never resent.
