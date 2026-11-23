The Rust engine can keep a task in one T3 row, with worker and reviewer runs
under its ACP session. A completed task archives its idle children first, then
the session. The ACP process presents the task from scratch outside the checkout.
