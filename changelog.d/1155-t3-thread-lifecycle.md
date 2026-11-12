T3 support threads now stay settled and bound while their task is open, so the
retained reviewer and recovery thread are continued instead of archived and
reopened. At closeout the worker thread is archived and every reviewer, recovery,
coordinator, decider and executor thread of the task is deleted. Paseo keeps its
existing archive behaviour.
