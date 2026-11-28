Idle task rows now snooze again after a Nucleus send wakes them once no child
is running and the two-minute Waiting window passes, including rows waiting on a
planner hold, planner question, or prerequisite. Open questions and decisions
for a person keep the row visible, operator snoozes still restore to their own
horizon, and finished task rows archive directly during row reconciliation.
