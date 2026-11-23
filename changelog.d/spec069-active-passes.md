### Changed

- A reconciliation pass now costs what the active work costs, not the retained history (Spec 069 §4). Passes read indexed sets of live tasks per host, active tasks and owner stops, kept up to date on every task write, instead of copying every retained task. Task rows, thread titles and hidden-row checks cover only live tasks that have a thread, so 2,000 finished tasks no longer mean thousands of row reads and host calls every pass.
- Finished history is caught up on its own slow cursor: each host pass handles the tasks that finished recently plus one page of older ones (finished-thread cleanup, row and title catch-up). The cursor's position survives a restart. A failed cleanup on an older finished task is retried when the cursor comes round again, which can take several minutes on a large history.
- A finished task's T3 parent thread is archived from the host's own open parent bindings, so every finish is archived over the following passes, including ones from before a restart.
- A host that is down or not yet read is no longer walked again by the retired-agent archive in the same pass.
