CREATE TABLE tasks (
  id TEXT PRIMARY KEY, reference TEXT NOT NULL,
  repository TEXT NOT NULL, base TEXT NOT NULL,
  entry TEXT NOT NULL CHECK (entry IN ('brief','review_entry')),
  brief TEXT NOT NULL CHECK (json_valid(brief)),
  phase TEXT NOT NULL CHECK (phase IN
    ('queued','working','report_ready','blocked','error','reviewing','merging','closing','done','cancelled')),
  threads TEXT NOT NULL CHECK (json_valid(threads)),
  run TEXT CHECK (json_valid(run)),
  pr TEXT CHECK (json_valid(pr)),
  verdict TEXT CHECK (json_valid(verdict)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  question TEXT CHECK (json_valid(question)),
  hold TEXT CHECK (json_valid(hold)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  origin_thread TEXT,
  report_task TEXT CHECK (json_valid(report_task)),
  work_continuation TEXT CHECK (json_valid(work_continuation)),
  queue_priority TEXT NOT NULL DEFAULT 'normal' CHECK (queue_priority IN ('normal','promoted')),
  UNIQUE (repository, reference)
) STRICT;
