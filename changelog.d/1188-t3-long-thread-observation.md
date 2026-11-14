A T3 thread long enough to page no longer becomes unobservable. Observation reads
T3's bounded snapshot, which keeps the thread, its runs and its runtime requests
complete and windows only the timeline, so `restart`, `route` and the sweep can
still see a long worker thread. Reads that consume the transcript still refuse a
paged projection instead of returning partial history. When an owner verb cannot
observe a retained thread, its refusal now names the host's error and kind (for
example a `subscribeThread` timeout) instead of only "cannot be observed".
