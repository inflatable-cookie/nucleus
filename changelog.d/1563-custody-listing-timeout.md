When the host is busy, a macOS process read that overruns its deadline now says so.
The refusal names the timeout ("the open-file listing timed out after 5000 ms",
or the same wording for the process table or zombie-state read) instead of
"the host process listing has incomplete working-directory coverage". A timed-out
read is unknown, never missing coverage, so the planner sees the real cause.
