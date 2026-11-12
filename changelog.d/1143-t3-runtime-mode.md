T3 threads run in the profile's runtime mode. The T3 catalog now reports each
provider's runtime modes from `server.getConfig` (`approval-required`,
`auto-accept-edits`, `auto`, `full-access`, with the nightly's own labels), a
launch sends the profile's `modeId` as the thread's `runtimeMode` instead of a
fixed `approval-required`, and a profile with no mode gets `full-access`, the
mode an unattended worker runs in today. A profile naming a mode T3 or its
provider does not offer is ineligible for a T3 task's roles with the mode named
in its routing policy and its availability reason, rather than refused at
launch; a mode T3 does not have is never silently changed. The task's routing
policy now shows a profile that host cannot run, so the board names the reason
before dispatch. A pool-shape test checks every enabled profile shape of the
real pool against the installed nightly's catalog: each one either produces the
launch payload its profile records or is ineligible with a named reason.
