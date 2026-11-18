A task waiting on a lost daemon transport clears that wait on the first sweep that
observes its host answer, and the ready task is visited in that same pass
(nucleus#1318, #1321; Spec 066 C2).

The wait a transport drop records is now the host-scoped wait a host outage
records — a `host_unavailable` stop beside one durable `transport_deferred` cause
for the reading — instead of a sentence plus a reason prefix the sweep had to
recognise again. The pass that sees the host answer settles the wait and the
independent `resolution.hostWait` together, records one `host_wait_cleared` event,
and decides the task's next step afresh; a host that did not answer settles
nothing, a repeated pass adds no event, send or notice, and an owner stop recorded
on the same task keeps its question.

A host that fails at the transport boundary during its own pass now holds only its
own tasks: the sweep reads the failure rather than the registry's connected claim,
so other hosts' tasks are still visited and dispatched, and the failover pass and a
host read made during a task visit answer for one host instead of the fleet.
