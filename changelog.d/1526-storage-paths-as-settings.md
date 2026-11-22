Nucleus's work-volume paths are settings now, and a separate Settings → Storage
page edits and validates them: task worktrees (`localWorkspaceRoot`, already
settable), database backups, legacy milestone QA history, run scratch and Barge
custodian records, each with a portable default and an environment override. A
fresh install writes `<workRoot>/worktrees/nucleus/`, `<workRoot>/archives/nucleus-backups/`,
`<workRoot>/archives/nucleus-project-qa/`, `<workRoot>/scratch/nucleus/` and
`<workRoot>/scratch/nucleus/barge-custodians/`, so nothing new lands in a `queue/`
folder on the work volume. Every path gets the task-worktree guard (canonical,
absolute, inside the work root, on the pinned volume, no symlinks) and a save
applies on the next service start. An existing install keeps working without a
migration: the backup resolver, retention, listing and restore read the retired
`queue/backups` snapshots, and legacy QA custody and retention read
`queue/project-qa`, until those files are moved by hand. `backup.list` and the
new `queue.work-storage` read answer with the resolved paths; the read-only work
root text moved off the Backups page.
