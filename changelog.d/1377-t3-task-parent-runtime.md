On T3Code, a task's parent `nucleus-acp` process and its native role sessions are
now recognised as the participant's own runtime rather than an owned tool, so an
idle task no longer holds review or closeout with `owned_tool_hold`. The process
proof identifies the connected T3 server from its own runtime descriptor, the ACP
parent from that ancestry plus the task's ACP binding, and role sessions from the
same server and their own `T3CODE_THREAD_ID`; a command a session's tools start
still holds, as does an unreadable or unbound parent. Run cleanup preserves these
processes too.
