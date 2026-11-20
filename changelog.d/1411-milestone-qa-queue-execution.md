# Queue execution and settlement QA repairs

- A project planner that is missing or archived is cleared from the project again,
  and its delegated questions fall back to the Nucleus planner with one notice for
  that episode; a live project planner is asked first.
- A displaced host thread is archived through the `Host` façade, so no owner calls
  the adapter's archive directly.
- The audit-pass order pins now record the observation read before the store chores
  and name the adapter property that both the released-delivery probe and the
  terminal thread archive read.
- Test fixtures for cleanup concurrency, the responsible-thread planner routing,
  the capacity-waiter wakeup, and the host dispatch/outage waits follow the current
  contracts (a task row always carries `resolution`, the host lists its live
  threads, a capacity wait is a typed stop).
- Waiting notices, worker-creation restarts, and never-dispatched closeout refusals
  are asserted with their current wording; the slim-row size allowance covers the
  cross-host and restart fields.
