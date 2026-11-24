A busy macOS host no longer refuses custody with "the host process listing has
incomplete working-directory coverage". A process listing that overruns its
deadline now names the deadline ("the process listing timed out", or "the
open-file listing timed out") and is unknown, not missing coverage. A truncated
listing names its cause: "the process listing is truncated", or the one process
whose working directory or open files could not be read. A live process the listing
shows in the workspace or run tree holds custody whether or not coverage is
complete. A release whose custody is unknown names the live turn instead of
releasing the worker as not live.
