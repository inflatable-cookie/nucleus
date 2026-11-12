T3 task threads now stay settled while the task is open, retaining the reviewer
and recovery threads for later rounds and faults. At closeout, worker threads are
archived and reviewer, recovery, coordinator and executor threads are deleted
through the existing durable cleanup lane. The sweep also catches up tasks that
finished before this rule existed, once per task. Displaced support threads wait
until closeout; decider threads and Paseo's archive behaviour are unchanged.
Later sweeps respect confirmed cleanup and leave deleted threads alone.
Unknown settlement, wake and title updates become moot after Nucleus confirms
its own deletion, so later sweeps stop reading the removed thread.
