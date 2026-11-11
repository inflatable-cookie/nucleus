T3Code trial step 2. Threads on a host without per-thread MCP report through
the packaged nucleus helper with the run ticket named in the prompt; a report
for another run is refused. Paseo keeps its MCP reporting route. Nucleus-raised
questions on a host that cannot take a native question land on the web board
and the project planner's agent channel. A repository setting selects the host
(`paseo` default, `t3code` opt-in); live tasks keep the host they started on.
Settings and `repository.set` switch the project for new tasks.

Trial: start T3Code, issue a session bearer with `t3 auth session issue`, store
it owner-only in local settings as `t3code: {endpoint, bearer, probeThreadId?}`,
opt a project in via Settings → Host or `repository.set`, and switch back the
same way.
