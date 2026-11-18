T3Code tasks are now one thread on the Nucleus ACP provider, with the worker,
reviewer, recovery, closeout and executor threads as its native subagent children.
T3 draws those children inside the parent's card, so one row per task needs no hide
setting, and the parent holds its turn while a role runs and releases it when none
does. Nucleus answers a child's own questions and permission requests directly; the
parent is never consulted, so review stays independent.

Register the installed `nucleus-acp` command as an ACP provider named `nucleus` in
T3Code once. Nucleus checks for it and reports the result as `service.health`'s
`t3code.nativeParenting` line; without it the task keeps working on one top-level
thread per agent, exactly as before.
