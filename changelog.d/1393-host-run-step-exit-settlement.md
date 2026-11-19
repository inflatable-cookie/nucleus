A milestone QA run whose step process group ends now settles from the step's own
exit instead of an unexplained `lost`. The supervisor records the direct child's
exit code or terminating signal and the time beside the run as soon as the kernel
reports it, before its step log or result. When the step's group is empty and the
supervisor has not settled inside a short bound, the service stops it under the
same proof as the stale-heartbeat rule and settles the run `failed` with that exit
code or signal, the step named as the interrupted step, and the live output log's
path, byte offset and last lines. A stage ended by a signal is now a failed step
rather than a hold.

The stale-heartbeat stop reads that recorded exit too, so a hung supervisor never
discards an outcome its child had already reported: the run settles `failed` from
the exit instead of `lost`. A takeover stops the supervisor first and alone, then
only the step group the supervision record still names, re-reading that record
before each decision and requiring the answer to be positive: a record that
advanced or cannot be read holds the run. `lost` is reserved for a supervisor that
died or an outcome that is genuinely unobservable — which still names the step and
where its output ended.
