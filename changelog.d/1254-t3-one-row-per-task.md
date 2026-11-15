A task on T3Code reads as one row. The worker thread is the task's row: its title
names the step the task is on (`Reviewing: … · reviewing`, `Working: … · reviewer
needs input`, `· blocked: reviewer`), and it stays in T3's main list while any of
the task's agents is still working instead of settling at handover.

Every reviewer, recovery and other support thread is tagged `nucleus-support` and
linked from the worker's conversation as a card that opens it, so a blocked task
is one row to scan and its support threads are one click away. A side-effect-free
retry makes neither the tag nor the card duplicate when a reply is lost.

T3's own setting that hides tagged threads is optional and off by default:
`hideTaggedThreads: true` plus `nucleus-support` in `hiddenThreadTags` in T3's
server settings. Nucleus reads it at connect, never writes it, and
`service.health`'s `t3code.supportThreads` reports whether support threads are
hidden, with the README section that turns it on.
