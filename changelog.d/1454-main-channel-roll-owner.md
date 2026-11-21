The local main channel now rolls without the Paseo plugin. A roll owner, a separate
detached process, runs the existing main-channel roll: it watches the configured
main commit, builds and proves the staged version, replaces the running service and
converges activation. A local T3Code launch starts it, so a T3-only install rolls its
main channel with no manual command and no open Inbox. A Paseo bridge that is also
present joins the same owner and reads the same roll record, so there is one loop per
data home. The owner stays while a service serves or a roll is unfinished, resumes an
interrupted roll after a restart, and exits on its own when neither holds, so the
service's host idle grace is unchanged. A failed build still leaves the running service
serving.
