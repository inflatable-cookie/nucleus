CREATE TABLE tasks (
  id TEXT PRIMARY KEY, reference TEXT NOT NULL,
  repository TEXT NOT NULL, base TEXT NOT NULL,
  entry TEXT NOT NULL CHECK (entry IN ('brief','review_entry')),
  brief TEXT NOT NULL CHECK (json_valid(brief)),
  phase TEXT NOT NULL CHECK (phase IN
    ('queued','working','reviewing','merging','closing','done','cancelled')),
  threads TEXT NOT NULL CHECK (json_valid(threads)),
  run TEXT CHECK (json_valid(run)),
  pr TEXT CHECK (json_valid(pr)),
  verdict TEXT CHECK (json_valid(verdict)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  question TEXT CHECK (json_valid(question)),
  hold TEXT CHECK (json_valid(hold)),
  UNIQUE (repository, reference)
) STRICT;

CREATE INDEX active_tasks ON tasks (id)
  WHERE phase NOT IN ('done','cancelled') OR run IS NOT NULL;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL
) STRICT;

CREATE INDEX task_history ON events (task_id, sequence);
