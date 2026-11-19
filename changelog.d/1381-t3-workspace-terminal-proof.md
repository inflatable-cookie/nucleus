A finished T3 task's worktree now archives. The T3 workspace inventory reads
finished runs, archived threads and removed threads as terminal, the same way the
single-thread read does, and a finished task's follow-up child threads leave
observation with their task. A live run, a pending request or an unrecognised
status still holds the archive, and an unrelated thread in the workspace is still
preserved.
