Queued tasks no longer cost anything until they are admitted (Spec 069 batch 1).
A submission writes its row and nothing else: it runs no dispatch pass, task
pass or host read, and signals admission only when the task could start and its
project has a free slot.
Admission runs when a slot frees, a prerequisite finishes, a hold or pause is
released, or a host comes back, and it skips heads that cannot start instead of
widening to the whole queue; a review whose origin host is away no longer holds
up its project. Admission stores no stop or wait on a never-started task; its
card and `next` still show "waiting for a project slot", prerequisites or its
host, worked out when they are read. The sweep no longer walks queued tasks to
settle host waits, and since batch 2 no host failure writes a wait on a queued task.
