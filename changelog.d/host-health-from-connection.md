### Fixed

- A connected host is no longer marked unavailable just because a dispatched task still carries an old host wait. Every submission's dispatch pass used to re-open the outage that way, park every task on the host and rewrite each task's stop, which kept a healthy T3 host "unavailable" while submissions kept arriving. Only a lost connection, a transport error or a pass that can't reach the host parks its tasks now.
