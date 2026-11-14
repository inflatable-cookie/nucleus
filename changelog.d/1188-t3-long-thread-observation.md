A T3 thread long enough to page no longer becomes unobservable. Observation reads
T3's bounded snapshot, which keeps the thread record, the active, window-referenced
and presented runs, and the pending runtime requests, and windows only the timeline
(and its visible rows), so `restart`, `route` and the sweep can still see a long
worker thread. Reads that consume the transcript still refuse a paged projection
instead of returning partial history. When an owner verb cannot observe a retained
thread, its refusal names the host error's kind — class name plus its code or method
— and the first line of its message, for every host, instead of only "cannot be
observed".
