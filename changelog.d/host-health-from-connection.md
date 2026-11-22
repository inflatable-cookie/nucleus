### Fixed

- A connected host is no longer marked unavailable because a task still carries an old host wait or because one call timed out. Either case used to park every task on the host, rewrite each task's stop, and keep a healthy T3 host "unavailable" while submissions kept arriving. Only a lost connection, or a pass that can't reach the host, parks its tasks now.
