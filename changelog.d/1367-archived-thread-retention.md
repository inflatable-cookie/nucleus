Nucleus now prunes the archived threads it created. One service-scheduled pass,
run hourly by the sweep and bounded per pass, removes the threads of a task that
is now done or cancelled once they have stayed archived past the retention window
(three days by default, set in Settings → Dispatch limits → Advanced). Paseo is
the first host: its adapter lists its archived Nucleus threads, re-reads each
thread's archive stamp before removing it, and deletes it through `deleteAgent`.
`service.health` reports the window and each host's last pass — when it ran, how
many were removed, how many remain and any failure — and `nucleus t3 status`
prints the same line. A planner thread, a thread of an unfinished task, a decision
thread and one the operator unarchived are never touched; an unknown removal is
never re-sent until the host proves the thread still archived. T3 and BB follow as
their own slices.
