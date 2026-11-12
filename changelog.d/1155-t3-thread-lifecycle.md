T3 support threads now stay settled and bound while their task is open, so the
retained reviewer, recovery coordinator and decider threads are continued instead
of archived and reopened. At closeout — a merge, a completed proof or a completed
cancellation — the worker thread is archived and every reviewer, recovery,
coordinator, decider and executor thread of the task is deleted. A removed or
routed-away coordinator thread is replaced rather than waited for. Paseo keeps its
existing archive behaviour.
