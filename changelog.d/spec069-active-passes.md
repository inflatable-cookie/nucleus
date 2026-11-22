### Changed

- A reconciliation pass now costs what the active work costs, not the retained history (Spec 069 §4). Passes read indexed sets of live tasks per host, active tasks and owner stops, kept up to date on every task write, instead of copying every retained task. Task rows, thread titles and hidden-row checks cover only live tasks that have a thread, so 2,000 finished tasks no longer mean thousands of row reads and host calls every pass.
- Finished history is caught up on its own slow cursor: each host pass handles the tasks that finished since the last pass plus one page of older ones (finished-parent archive, finished-thread cleanup, row and title catch-up). The cursor's position survives a restart, and every finished task is revisited once it wraps.
- A host that is down or not yet read is no longer walked again by the retired-agent archive in the same pass.
