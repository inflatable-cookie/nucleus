Settled-run process cleanup now finishes instead of looping. The task quantum's
sweep reads the process table on the task's own host, so it no longer defers
every run as "process table observation is unavailable". A read-only folder a
tool left in a run's scratch no longer blocks retiring that scratch. A cleanup
that keeps failing the same way writes one timeline event rather than one per
sweep, and records that stay pending cost about one sweep per host pass.
