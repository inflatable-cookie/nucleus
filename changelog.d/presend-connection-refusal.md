A task control whose host call is refused by the adapter's own connection
precondition (no authenticated T3 connection, a changed durable host identity,
or an offline BB executor) now settles as a definite refusal with a reconciled
effect. It no longer leaves an uncertain operation that blocks the task.
