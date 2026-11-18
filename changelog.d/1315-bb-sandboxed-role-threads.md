A BB role thread can deliver its report, run Effigy and read its sibling
`../<sibling>` again. A run ticket now names its host; a `bb:` ticket's report
helper posts the same payload to the BB plugin's loopback relay, which forwards
it to the run's own callback socket from the BB server process (a relay that is
not there falls back to the socket). The service also creates a BB run's
owner-only scratch leaf before its thread exists, and keeps one shared sibling
checkout per repository beside the task checkout — the same shape a Paseo
worktree root has — so every task on that repository resolves relative sibling
paths. BB role threads now run in Full Access (planner ruling, 2026-11-18, recorded in the task's held brief v2):
Claude Code's sandbox refuses the boot-session sysctl Effigy's foreground
identity reads, so a sandboxed thread cannot validate at all; Paseo role threads
already run full-access / bypassPermissions.
