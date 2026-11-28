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
