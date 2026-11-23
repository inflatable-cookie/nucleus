Work on T3 and BB hosts is no longer skipped where Nucleus checked the host
outside the task's own host context. Stop active threads and bulk disposition
work on an install without Paseo: stop active threads cancels T3 and BB turns
and names any task whose host it cannot reach, and a bulk cancel finishes each
task without waiting for a sweep. The ordinary pass now finds a T3 or BB
worker's pushed branch PR and delivers a brief amendment that missed its host,
and retention removes a purged task's run tickets whether or not its host is
connected.
