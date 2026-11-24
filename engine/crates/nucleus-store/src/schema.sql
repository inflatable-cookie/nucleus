CREATE INDEX active_tasks ON tasks (id)
  WHERE phase NOT IN ('done','cancelled') OR run IS NOT NULL;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL
) STRICT;

CREATE INDEX task_history ON events (task_id, sequence);
