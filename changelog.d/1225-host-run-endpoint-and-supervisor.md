Host runs answer contract-010 refusals from typed codes instead of message text,
and a durable record that cannot be read is no longer mistaken for a missing
one: a corrupt submission is refused and left in place instead of being
overwritten by a resubmit, and an unreadable cancel request stops the run and is
recorded beside it. The detached host-run supervisor now runs its command through
the shared process owner, so settle-on-empty-group, output capture and the
escaped-descendant rule have one implementation, and retained output is capped
per stream with the truncation recorded in the stream it truncated.
