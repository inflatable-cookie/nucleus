The BB plugin now owns BB's sidebar: the thread list is a pinned fork of BB's own
list (with upstream's MIT notice and a recorded patch set), and each Nucleus task
group renders the task's number, title, shared state label, recorded wait and pull
request, collapsed by default with the operator's expand persisted. Every other
group behaves exactly as upstream. The task-group state comes from one bounded
read, `bb.sidebar-groups`, which draws no forge, Git or thread-timeline fact, and
refetches on the board signal. `effigy bb:sidebar-drift` reports upstream drift at
the pin, and `effigy proof:bb:sidebar` builds and installs the plugin into the
isolated BB server.
