A busy macOS host no longer makes completion or release wait on the host-wide
open-file read. A plain process listing reads working directories only, and open
files are read only under the directories a completion, archive or release check
guards. A working directory that already shows a live process is reported as live
even when the open-file read overruns, so a release still warns about it. A read
that overruns its deadline reports that deadline as its reason ("the
working-directory listing timed out", "the open-file listing timed out", or the
same wording for the process table or zombie-state read), so the planner sees the
real cause.
