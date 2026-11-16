### BB host phase 0: the reverse host-operation channel

BB can become a third Nucleus host (Spec 062). Phase 0 proves its transport before
any later phase depends on it, against an isolated BB server: a BB plugin connects
out to the Nucleus service on the existing owner-only socket, declares the
`host-executor` role, and answers bounded host operations through `bb.sdk`, so the
service never hand-decodes BB's undocumented HTTP routes.

The service gains one additive connection role (`service.host-executor`) and a
bounded reverse `host.op` request, with the fault rules a host operation needs: one
operation's fault settles that operation, a malformed or late answer is unknown
delivery, and an unknown write is never resent. It registers no host, adds no host
kind and cannot dispatch a task; BB stays opt-in and unimplemented.

`effigy proof:bb` runs the spike end to end in its own scratch root and refuses the
operator's live BB data directory. It proves the channel reconnects after
`bb plugin reload` and a BB restart, the identity is re-derived each time, a
workspace handle is minted with zero spawns, a Nucleus-created worktree attaches as
an unmanaged environment shared by a task's roles, and the thread observes and
archives after its cascade read. It also answers the terminal-scope question: a
thread-scoped terminal belongs to its thread's panel, while a `host_path` terminal
at a task worktree appears only in the host's list, so phase 5 drops that
convenience.
