-- A synthetic database written by the schema 14 store (c53a3791f) and exported
-- with `sqlite3 .dump`. The last parent delivery row is the shape left by the
-- schema 12 history conversion: no frozen wire, only the recorded prompt.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
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
  merge_hold TEXT CHECK (json_valid(merge_hold)),
  UNIQUE (repository, reference)
) STRICT;
INSERT INTO tasks VALUES('live','fixture#1','example/fixture','main','brief','{"digest":[28,3,248,189,193,35,215,33,173,25,191,40,26,93,199,196,85,101,127,189,151,229,185,39,117,134,1,220,76,38,160,160],"text":"---\nqueue:\n  complexity: low\n---\nAdd a greeting","version":1}','queued','{"launch_sequence":0,"reviewer":null,"worker":null}',NULL,NULL,NULL,0,NULL,NULL,1,'thread:synthetic-planner',NULL,NULL,'normal','{"actor":"operator","by":"operator","reason":"Verify the candidate","since_ms":123}');
INSERT INTO tasks VALUES('done','fixture#2','example/fixture','main','brief','{"digest":[28,3,248,189,193,35,215,33,173,25,191,40,26,93,199,196,85,101,127,189,151,229,185,39,117,134,1,220,76,38,160,160],"text":"---\nqueue:\n  complexity: low\n---\nAdd a greeting","version":1}','cancelled','{"launch_sequence":0,"reviewer":null,"worker":null}',NULL,NULL,NULL,0,NULL,NULL,2,'thread:synthetic-planner',NULL,NULL,'normal',NULL);
INSERT INTO tasks VALUES('unframed','fixture#3','example/fixture','main','brief','{"digest":[28,3,248,189,193,35,215,33,173,25,191,40,26,93,199,196,85,101,127,189,151,229,185,39,117,134,1,220,76,38,160,160],"text":"---\nqueue:\n  complexity: low\n---\nAdd a greeting","version":1}','queued','{"launch_sequence":0,"reviewer":null,"worker":null}',NULL,NULL,NULL,0,NULL,NULL,1,'thread:synthetic-planner',NULL,NULL,'normal',NULL);
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL
) STRICT;
INSERT INTO events VALUES(1,'live',1,'admitted','admitted');
INSERT INTO events VALUES(2,'done',1,'admitted','admitted');
INSERT INTO events VALUES(3,'done',1,'owner_cancel','owner_cancel');
INSERT INTO events VALUES(4,'done',1,'phase_transition','{"from":"queued","to":"cancelled"}');
INSERT INTO events VALUES(5,'unframed',1,'admitted','admitted');
CREATE TABLE acp_sessions (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  reader BLOB NOT NULL CHECK (length(reader) = 32),
  writer BLOB CHECK (length(writer) = 32),
  controller BLOB NOT NULL CHECK (length(controller) = 32)
) STRICT;
INSERT INTO acp_sessions VALUES('live',x'0101010101010101010101010101010101010101010101010101010101010101',x'0202020202020202020202020202020202020202020202020202020202020202',x'0303030303030303030303030303030303030303030303030303030303030303');
CREATE TABLE profile_assignments (
  sequence INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('worker', 'reviewer')),
  profile_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  instance TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL
) STRICT;
CREATE TABLE profile_assignment_totals (
  role TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (role, profile_id, group_id)
) STRICT;
CREATE TABLE inbox_bindings (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  task_version INTEGER NOT NULL CHECK (task_version > 0),
  decision_id TEXT NOT NULL UNIQUE,
  head TEXT NOT NULL
) STRICT;
CREATE TABLE task_titles (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  thread TEXT NOT NULL UNIQUE,
  desired TEXT NOT NULL,
  confirmed TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  retry_at INTEGER NOT NULL DEFAULT 0,
  delay_ms INTEGER NOT NULL DEFAULT 5000 CHECK (delay_ms BETWEEN 5000 AND 300000)
) STRICT;
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
INSERT INTO planning_lanes VALUES('synthetic','delivery','{"key":"delivery","version":1,"title":"Delivery","aim":"Ship it","document":"Notes","status":"open"}');
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
INSERT INTO planning_history VALUES(1,'synthetic','lane','delivery','planner',10,'put','{"key":"delivery","version":1,"title":"Delivery","aim":"Ship it","document":"Notes","status":"open"}');
CREATE TABLE planning_task_sources (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  project TEXT NOT NULL,
  item_id TEXT NOT NULL,
  UNIQUE (project, item_id),
  FOREIGN KEY (project, item_id) REFERENCES planning_items(project, id)
) STRICT;
CREATE TABLE task_number_counters (
  repository TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL CHECK (next_number > 0),
  legacy_next INTEGER NOT NULL CHECK (legacy_next BETWEEN 1 AND next_number)
) STRICT;
INSERT INTO task_number_counters VALUES('example/fixture',4,1);
CREATE TABLE task_numbers (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  repository TEXT NOT NULL REFERENCES task_number_counters(repository),
  number INTEGER NOT NULL CHECK (number > 0),
  UNIQUE (repository, number)
) STRICT;
INSERT INTO task_numbers VALUES('live','example/fixture',1);
INSERT INTO task_numbers VALUES('done','example/fixture',2);
INSERT INTO task_numbers VALUES('unframed','example/fixture',3);
CREATE TABLE parent_deliveries (
    ordinal INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    version INTEGER NOT NULL,
    command TEXT NOT NULL,
    refresh INTEGER NOT NULL CHECK (refresh IN (0, 1)),
    runtime TEXT,
    wire TEXT CHECK (json_valid(wire)),
    legacy_prompt TEXT,
    due_ms INTEGER NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('pending', 'accepted', 'refused', 'failed', 'held')),
    UNIQUE(task_id, version, command)
) STRICT;
INSERT INTO parent_deliveries VALUES(1,'live',1,'older-hold',0,'synthetic-runtime','{"binding":{"projectId":"synthetic-project","worktreePath":"/synthetic/checkout","branch":"ns-live"},"method":"continue","payload":{"type":"message.dispatch","commandId":"older-hold","threadId":"thread:nucleus-synthetic","messageId":"older-hold-message","text":"Starting worker","attachments":[],"createdBy":"user","creationSource":"server","modelSelection":{"instanceId":"nucleus","model":"nucleus"},"dispatchMode":{"type":"queue_after_active"}},"provider":"nucleus"}',NULL,100,'accepted');
INSERT INTO parent_deliveries VALUES(2,'live',1,'current-hold',0,'synthetic-runtime','{"binding":{"projectId":"synthetic-project","worktreePath":"/synthetic/checkout","branch":"ns-live"},"method":"continue","payload":{"type":"message.dispatch","commandId":"current-hold","threadId":"thread:nucleus-synthetic","messageId":"current-hold-message","text":"Starting reviewer","attachments":[],"createdBy":"user","creationSource":"server","modelSelection":{"instanceId":"nucleus","model":"nucleus"},"dispatchMode":{"type":"queue_after_active"}},"provider":"nucleus"}',NULL,200,'pending');
INSERT INTO parent_deliveries VALUES(3,'live',1,'current-refresh',1,'synthetic-runtime','{"binding":{"projectId":"synthetic-project","worktreePath":"/synthetic/checkout","branch":"ns-live"},"method":"continue","payload":{"type":"message.dispatch","commandId":"current-refresh","threadId":"thread:nucleus-synthetic","messageId":"current-refresh-message","text":"Nucleus refreshes the current task row.","attachments":[],"createdBy":"user","creationSource":"server","modelSelection":{"instanceId":"nucleus","model":"nucleus"},"dispatchMode":{"type":"queue_after_active"}},"provider":"nucleus"}',NULL,300,'accepted');
CREATE TABLE provider_pauses (
            group_id TEXT PRIMARY KEY, until_ms INTEGER NOT NULL CHECK (until_ms > 0),
            fallback_until_ms INTEGER
        ) STRICT;
CREATE TABLE legacy_project_import (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  pending TEXT CHECK (json_valid(pending))
) STRICT;
CREATE TABLE inbox_titles (
  thread TEXT PRIMARY KEY,
  desired TEXT NOT NULL,
  confirmed TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  retry_at INTEGER NOT NULL DEFAULT 0,
  delay_ms INTEGER NOT NULL DEFAULT 5000 CHECK (delay_ms BETWEEN 5000 AND 300000)
) STRICT;
CREATE TABLE task_row_snoozes (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    thread TEXT NOT NULL,
    receipt TEXT NOT NULL
) STRICT;
CREATE TABLE inbox_command_receipts (
  message_id TEXT PRIMARY KEY,
  attempted_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE allowance_clock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    elapsed_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE task_allowances (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
) STRICT;
CREATE TABLE project_tell_deliveries (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL,
  sender TEXT NOT NULL,
  from_project TEXT NOT NULL,
  to_project TEXT NOT NULL,
  text TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (json_valid(state)),
  command TEXT,
  retry_at INTEGER,
  delay_ms INTEGER NOT NULL DEFAULT 5000
) STRICT;
CREATE TABLE tell_reply_handles (
  handle TEXT PRIMARY KEY, delivery TEXT NOT NULL, recipient TEXT NOT NULL, issued_at INTEGER NOT NULL
) STRICT;
CREATE TABLE tell_direct_targets (
  delivery TEXT PRIMARY KEY, thread TEXT NOT NULL, gone INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE project_tell_requests (
  key TEXT PRIMARY KEY,
  recorded_at INTEGER NOT NULL,
  deliveries TEXT NOT NULL CHECK (json_valid(deliveries)),
  no_live_planners TEXT NOT NULL CHECK (json_valid(no_live_planners))
) STRICT;
CREATE TABLE task_prerequisite_waits (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    reason TEXT NOT NULL,
    released_at_ms INTEGER
) STRICT;
CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    prerequisite_id TEXT NOT NULL REFERENCES tasks(id),
    after_dispatch INTEGER NOT NULL CHECK (after_dispatch IN (0, 1)),
    PRIMARY KEY (task_id, after_dispatch, prerequisite_id),
    CHECK (task_id != prerequisite_id)
) STRICT;
CREATE TABLE task_prerequisite_notices (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    release_version INTEGER NOT NULL,
    detail TEXT NOT NULL,
    attempted_at_ms INTEGER,
    PRIMARY KEY (task_id, release_version)
) STRICT;
CREATE TABLE completion_notices (
            task_id TEXT PRIMARY KEY REFERENCES tasks(id), retry INTEGER CHECK (retry IN (0,1))
        ) STRICT;
INSERT INTO completion_notices VALUES('done',0);
CREATE TABLE housekeeping_runs (
            name TEXT PRIMARY KEY, started_ms INTEGER NOT NULL, next_batch_ms INTEGER
        ) STRICT;
CREATE TABLE thread_prune_attempts (
            thread TEXT PRIMARY KEY, archived_ms INTEGER NOT NULL, attempts INTEGER NOT NULL
        ) STRICT;
CREATE TABLE planning_record_clocks (
    project TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL UNIQUE,
    PRIMARY KEY(project,kind,id)
) STRICT;
INSERT INTO planning_record_clocks VALUES('synthetic','lane','delivery',10,10,1);
CREATE TABLE task_board_state (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    since_ms INTEGER NOT NULL CHECK (since_ms >= 0)
) STRICT;
INSERT INTO task_board_state VALUES('live',1);
INSERT INTO task_board_state VALUES('done',1);
INSERT INTO task_board_state VALUES('unframed',1);
CREATE TRIGGER planning_clock_write AFTER INSERT ON planning_history BEGIN
    INSERT INTO planning_record_clocks VALUES
        (new.project,new.kind,new.id,new.at_ms,new.at_ms,new.sequence)
    ON CONFLICT(project,kind,id) DO UPDATE SET
        updated_at=excluded.updated_at, version=excluded.version;
END;
CREATE INDEX active_tasks ON tasks (id)
  WHERE phase NOT IN ('done','cancelled') OR run IS NOT NULL;
CREATE INDEX task_history ON events (task_id, sequence);
CREATE INDEX occupied_launch_slots ON tasks (id)
  WHERE json_extract(run, '$.last_send_at_ms') IS NOT NULL;
CREATE INDEX profile_assignment_role ON profile_assignments (role, sequence);
CREATE INDEX profile_assignment_group ON profile_assignment_totals (group_id);
CREATE INDEX planning_pending_decisions ON planning_decisions (project, id)
  WHERE json_extract(snapshot, '$.answer') IS NULL
    AND json_extract(snapshot, '$.withdrawn') IS NULL;
CREATE INDEX planning_history_record ON planning_history (project, kind, id, sequence);
CREATE UNIQUE INDEX planning_usage_permission
    ON planning_decisions(id) WHERE json_extract(snapshot, '$.task.kind') = 'usage_permission';
CREATE INDEX project_tells_recipient ON project_tell_deliveries (to_project, recorded_at);
CREATE INDEX project_tells_due ON project_tell_deliveries (retry_at, id)
  WHERE retry_at IS NOT NULL;
CREATE INDEX project_tells_command ON project_tell_deliveries (command)
  WHERE command IS NOT NULL;
CREATE INDEX tell_reply_recipient ON tell_reply_handles (recipient, issued_at);
CREATE INDEX task_dependency_dependents
    ON task_dependencies (prerequisite_id, task_id);
CREATE INDEX pending_prerequisite_notices
    ON task_prerequisite_notices (task_id, release_version)
    WHERE attempted_at_ms IS NULL;
CREATE INDEX pending_completion_notices ON completion_notices(task_id) WHERE retry IS NOT NULL;
INSERT INTO parent_deliveries VALUES(4,'unframed',1,'thread:nucleus-synthetic-hold-acp-0:nucleus',0,'synthetic-runtime',NULL,'Starting worker',400,'pending');
COMMIT;
PRAGMA application_id=1311782704;
PRAGMA user_version=14;
