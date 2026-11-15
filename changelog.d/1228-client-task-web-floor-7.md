The Runs tab is now one owner per section: prerequisites and the run-bound cleanup, the runs and their delivery, the worker exclusions, and the closeout facts. The Overview's summary and pending question have their own module too. The terminal `done`/`cancelled` pair, the live-versus-released run split and the cleanup subject are typed shared facts now, and worker exclusion goes through one request.

A recorded event's kind, actor and bounded detail line come from one shared owner, with the actor still read from the recorded detail because the event contract carries no actor column.

The web board's live channel decodes each frame through the board contract the RPC path already parses, writes the board query through the poll's own key and merge rule, and shows a dropped stream's reason in the reader instead of failing silently.
