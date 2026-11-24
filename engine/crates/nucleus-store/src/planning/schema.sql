CREATE TABLE planning_plans (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (project, id)
) STRICT;

CREATE TABLE planning_lanes (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (project, id)
) STRICT;

CREATE TABLE planning_items (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (project, id)
) STRICT;

CREATE TABLE planning_decisions (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (project, id)
) STRICT;

CREATE INDEX planning_pending_decisions ON planning_decisions (project, id)
  WHERE json_extract(snapshot, '$.answer') IS NULL
    AND json_extract(snapshot, '$.withdrawn') IS NULL;

CREATE TABLE planning_history (
  sequence INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  actor TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  snapshot TEXT NOT NULL
) STRICT;
CREATE INDEX planning_history_record ON planning_history (project, kind, id, sequence);

CREATE TABLE planning_task_sources (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  project TEXT NOT NULL,
  item_id TEXT NOT NULL,
  UNIQUE (project, item_id),
  FOREIGN KEY (project, item_id) REFERENCES planning_items(project, id)
) STRICT;
