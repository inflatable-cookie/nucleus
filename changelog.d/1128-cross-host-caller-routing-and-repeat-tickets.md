A host call that names an agent goes to that agent's own host. With two hosts
registered (Paseo and T3Code), a lead check or promotion for a T3 repository no
longer refuses its Paseo-origin author with "Caller identity belongs to a
different or unknown host": the host facade and the transport boundary route the
identity to its own host's adapter and unwrap it only there, refusing only when
that host is unknown or offline and naming it. A proven caller that already
holds a participant ticket (project planner, named agent or task planner) now
gets that same ticket's path back on every `caller.resolve` and `nucleus tell`,
so the ticket handed out once is never lost to the thread; a credential file
that is gone is revoked and reissued on the caller's own next call.
