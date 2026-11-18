T3Code: a sweep stops reading threads whose task is over, and reads each live thread at most once per pass (nucleus#1328).

The adapter observes a thread only while its Nucleus task is live. When the task
goes done or cancelled, or T3's own thread list reports the thread archived or
removed, the thread leaves observation: its live record moves to the stored
`retiredAgents` index, which keeps just the launch identity so an exact settle, an
exact lookup and the terminal archive lane still answer. Nothing is deleted,
archived or edited in T3, and a documented intent, settle marker or command stays
exactly as recorded.

Within a pass, status, row step, presentation, settle and pending questions share
one thread list and one snapshot per thread. The pass skips a thread's snapshot
while the row T3 reports for it is unchanged, so a host with no live work serves no
`orchestration.subscribeThread` at all — the observed cause of T3's sustained CPU
on a server tracking only finished tasks.
