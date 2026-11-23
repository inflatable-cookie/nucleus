A busy macOS host no longer makes custody proofs refuse with "the host process
listing has incomplete working-directory coverage". A plain process listing now
reads working directories only, a small read, and the host-wide open-file read
runs only where a custody decision needs open files. A read that overruns its
deadline reports that deadline as its reason ("the working-directory listing
timed out", "the open-file listing timed out", or the same wording for the
process table or zombie-state read), so the planner sees the real cause.
