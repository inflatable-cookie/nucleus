First worker dispatch now waits for the operator's default host kind, as it
already did for a repository's explicit host kind. A queued task whose default
host is offline, reconnecting, unregistered or without a read catalog keeps a
visible wait with no workspace, profile charge or slot, and other projects keep
dispatching. A selected profile that only another online host can launch still
routes there while the target host is ready, and its selection reason says the
target's catalog lacks it. Selection reasons no longer call a profile host-only
when a host could not be read.
