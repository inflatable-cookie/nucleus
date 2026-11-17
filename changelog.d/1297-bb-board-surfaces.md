Nucleus's operator surfaces now run in BB. The shared board renders as a Nucleus
destination in BB's left rail with an attention badge (tasks that need the
operator, draining as they settle), and per project at
`/plugins/nucleus/board/project/<project-key>` and in a fixed Board tab on the
project's planner and named-agent threads — a multi-repository project shows every
repository. A task's role threads get a fixed Task tab with the board's task detail.
Settings render as a BB settings section and from the board header; decision and
native-question pills appear in the thread composer; a Nucleus-raised blocking
question has its own pending-interaction renderer; and the forked sidebar's project
rows and planner rows link to the project board. BB thread events reach the service
as the existing lifecycle hints, and `bb nucleus terminal [task]` opens one terminal
tab in the calling thread. BB Settings writes reach the service through the plugin's
own host-executor connection as the `bb` Settings surface. Usage in BB stays BB's own
card plus the operator's Usage Pace plugin; the board keeps its own Usage view.
`effigy bb:board-build` bundles the shared board into the plugin package.
