Parent task turns retry an unconfirmed send with the same T3 command ID after a
short delay. T3 reuses its original receipt, and a confirmed rejection schedules a
fresh command. Unconfirmed delivery no longer sends a planner notice or asks the
operator to recover the task thread.
