Wake task recovery when a turn ends, its process dies, its thread disappears,
or its authenticated report arrives. Schedule the late-report grace directly
and keep the stall threshold for running tools whose output the host cannot see.
Arm recovery at worker launch and collect tool evidence when the configured
quiet limit expires, even on a young turn.
