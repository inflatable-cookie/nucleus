A busy macOS host no longer refuses custody with "the host process listing has
incomplete working-directory coverage". A process listing that overruns its
deadline now names the deadline ("the process listing timed out", or "the
open-file listing timed out") and is unknown, not missing coverage. A truncated
listing names its truncation ("the working-directory listing is truncated", or
"the open-file listing is truncated") and keeps the rows it read, so a live process
in the workspace or run tree still holds custody. A release whose custody is unknown
names the live turn instead of releasing the worker as not live.
