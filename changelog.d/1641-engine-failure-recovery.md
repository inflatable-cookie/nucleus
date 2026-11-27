The engine now logs the cause and exits if its scheduler stops, so clients can
restart it. Prerequisite edits reject cycles and name the tasks involved.
Checkout trash pruning reports failed entries and continues, and checkout
setup distinguishes missing prerequisite commits from Git failures. Removed
the rejected `serve --planner` and `serve --fixture-origin-thread` flags.
