A message to a working T3 participant now steers into its running turn instead of
waiting for the turn to end. Planner and operator `tell`s to a task's worker or
reviewer, `tell`s to a planner or named agent, and relayed answers to a
question the agent asked all steer. Nucleus's own reminders, notices and
recovery prompts still queue behind the current step. An idle thread takes the
ordinary queued send, and a steer the adapter proves was not sent falls back to
one queued send. Paseo tells still wait for the agent to go idle until its steer
behaviour is verified.
