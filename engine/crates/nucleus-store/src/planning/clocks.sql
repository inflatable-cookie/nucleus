-- Planning writes have a revision independent of the retained history payloads.
CREATE TABLE planning_record_clocks (
    project TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL UNIQUE,
    PRIMARY KEY(project,kind,id)
) STRICT;
INSERT INTO planning_record_clocks
SELECT k.project,k.kind,k.id,first.at_ms,last.at_ms,k.last_seq
FROM (SELECT project,kind,id,min(sequence) first_seq,max(sequence) last_seq
      FROM planning_history GROUP BY project,kind,id) k
JOIN planning_history first ON first.sequence=k.first_seq
JOIN planning_history last ON last.sequence=k.last_seq;
CREATE TRIGGER planning_clock_write AFTER INSERT ON planning_history BEGIN
    INSERT INTO planning_record_clocks VALUES
        (new.project,new.kind,new.id,new.at_ms,new.at_ms,new.sequence)
    ON CONFLICT(project,kind,id) DO UPDATE SET
        updated_at=excluded.updated_at, version=excluded.version;
END;
