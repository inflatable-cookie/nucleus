Settled-run cleanup no longer blocks the service's event loop on `ps`, and a
run's `mcp-report.mjs` bridge no longer outlives its session. A sweep answers
every liveness and identity check from the one process table it already reads,
so it spawns no synchronous child at all; a stop still proves the recorded birth
identity first, from one bounded spawned read. The report bridge exits when its
agent's session ends, and a bridge a crash leaves behind is stopped by the run's
own cleanup under the PID and start identity the run recorded — never a command
pattern, and never one belonging to a session that is still live.
