Task wall-time budgets now start at the lifecycle's first recorded run instead of at a
task's conversion time, so a task that has never run reads no used wall time. Every
gate and every view measures the budget through one function with the same inputs, so
`queue.detail`, `task.next`, the board and the dispatcher report the same used, limit
and exhaustion. A recorded budget pause is cleared — with the question it raised —
once that figure no longer shows it, so a task the views read as under its limit is not
fenced out of dispatch or asked about a pause that is gone. `task.next`'s reason and stop follow
the current stop, so a cleared budget pause no longer keeps reading "Budget reached" or
turns into an operator wait — a queued task reads that it waits for dispatch, and any
other phase reads that it is progressing — and wall-clock pauses the durable clock
folded but its events did not place are no longer charged to the task.
