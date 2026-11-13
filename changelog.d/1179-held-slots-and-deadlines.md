A stuck host call or a long removal no longer starves the service's reads, and
each held slot is now named with an owner and an age.

- A Paseo call past its deadline is abandoned as unknown: the caller hears that
  the outcome is unknown and that it was not resent, the class and total slots
  are freed, and recovery reads the recorded state. Workspace archives and
  creation keep their slot for as long as they legitimately take.
- `service.health.admission` names every call held past five seconds with its
  class, holder, age and deadline, and the last abandoned call;
  `service.health.requestTimings.held` names the request holding the executor
  thread, with its age and how many requests are queued behind it. Both are
  read on the request loop, so they answer while the executor is blocked, and a
  wait for a slot is logged with the oldest holder and its age.
- Recursive directory removal runs on libuv's pool instead of synchronously on
  the thread that serves reads.
