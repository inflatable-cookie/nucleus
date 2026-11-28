-- A row without a frozen wire is never read. `legacy_prompt` is no longer used
-- (Spec 070 ruling 59). It stays so every schema 16 database has one shape.
CREATE TABLE parent_deliveries (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    version INTEGER NOT NULL,
    command TEXT NOT NULL CHECK (command <> ''),
    wire TEXT CHECK (json_valid(wire)),
    legacy_prompt TEXT,
    due_ms INTEGER NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('pending', 'accepted'))
) STRICT;

CREATE TABLE parent_refresh_deliveries (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    version INTEGER NOT NULL,
    command TEXT NOT NULL CHECK (command <> ''),
    wire TEXT CHECK (json_valid(wire)),
    legacy_prompt TEXT,
    due_ms INTEGER NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('pending', 'accepted'))
) STRICT;
