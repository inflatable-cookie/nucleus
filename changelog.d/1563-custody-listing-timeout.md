A busy macOS host no longer refuses custody with "the host process listing has
incomplete working-directory coverage". A process listing that overruns its
deadline now names the deadline ("the process listing timed out", or "the
open-file listing timed out") and is unknown, not missing coverage. A live process
the listing shows in the workspace or run tree still holds custody. A release whose
custody is unknown names the live turn instead of releasing the worker as not live.
