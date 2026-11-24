use rusqlite::{Connection, params};

use crate::{Store, StoreError};

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS task_board_state (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    label TEXT NOT NULL,
    since_ms INTEGER CHECK (since_ms >= 0)
) STRICT";

const READ: &str = "SELECT record.label,
    CASE
        WHEN record.label IS NOT NULL THEN record.since_ms
        WHEN blocked.sequence IS NOT NULL THEN blocked.at
        WHEN t.phase = 'done' THEN (
            SELECT at FROM events WHERE task_id = t.id AND kind = 'entered_done'
            ORDER BY sequence DESC LIMIT 1
        )
        WHEN t.phase = 'cancelled' THEN (
            SELECT at FROM events
            WHERE task_id = t.id AND EXISTS (
                SELECT 1 FROM json_each(CASE WHEN json_valid(detail) THEN detail END, '$.presentation') AS milestone
                WHERE CASE WHEN milestone.type = 'object' THEN milestone.value END ->> '$.kind' = 'finished'
                AND CASE WHEN milestone.type = 'object' THEN milestone.value END ->> '$.phase' = 'cancelled'
            )
            ORDER BY sequence DESC LIMIT 1
        )
        WHEN t.phase = 'queued' AND t.version = 1 AND t.hold IS NULL AND t.question IS NULL THEN (
            SELECT at FROM events WHERE task_id = t.id AND kind = 'admitted'
            ORDER BY sequence LIMIT 1
        )
    END,
    (SELECT at FROM events WHERE task_id = t.id ORDER BY sequence LIMIT 1),
    blocked.sequence IS NOT NULL
 FROM tasks AS t LEFT JOIN task_board_state AS record ON record.task_id = t.id
 LEFT JOIN events AS blocked ON blocked.sequence = (
    SELECT e.sequence FROM events AS e JOIN task_titles AS title ON title.task_id = e.task_id
    WHERE record.label IS NULL AND e.task_id = t.id AND e.kind = 'host_observation_blocked'
        AND t.phase NOT IN ('done', 'cancelled') AND t.hold IS NULL AND t.question IS NULL
        AND coalesce(json_extract(t.run, '$.revoked'), 0) = 0
        AND json_extract(CASE WHEN json_valid(e.detail) THEN e.detail END, '$.version') = t.version
        AND title.confirmed = title.desired
        AND (title.desired GLOB 'Blocked on T3: *'
             OR title.desired GLOB 'Couldn’t verify task thread: *')
        AND NOT EXISTS (
            SELECT 1 FROM events AS later
            WHERE later.task_id = t.id AND later.sequence > e.sequence
              AND later.kind IN ('native_turn_intent', 'native_turn_replay',
                                 'native_turn_failed', 'native_turn_not_sent')
        )
    ORDER BY e.sequence DESC LIMIT 1
 )
 WHERE t.id = ?1";

/// The stored display label, with times established by the projection or task audit.
pub struct BoardState {
    pub label: Option<String>,
    pub since_ms: Option<u64>,
    pub created_at_ms: Option<u64>,
    pub legacy_host_blocked: bool,
}

impl Store {
    /// Read the display state, using unambiguous audit transitions for older tasks.
    ///
    /// # Errors
    /// Returns an error if the display state or its audit cannot be read.
    pub fn board_state(&self, id: &str) -> Result<BoardState, StoreError> {
        let mut query = self.connection.prepare_cached(READ)?;
        Ok(query.query_row([id], |row| {
            let millis = |column| {
                row.get::<_, Option<i64>>(column)
                    .map(|time| time.and_then(|value| u64::try_from(value).ok()))
            };
            Ok(BoardState {
                label: row.get(0)?,
                since_ms: millis(1)?,
                created_at_ms: millis(2)?,
                legacy_host_blocked: row.get(3)?,
            })
        })?)
    }

    /// Record the scheduler's current display state without changing task version.
    ///
    /// # Errors
    /// Returns an error if the projection cannot be written.
    pub fn record_board_state(
        &self,
        id: &str,
        label: &str,
        at: Option<i64>,
    ) -> Result<(), StoreError> {
        record(&self.connection, id, label, at)
    }
}

pub(super) fn record(
    connection: &Connection,
    id: &str,
    label: &str,
    at: Option<i64>,
) -> Result<(), StoreError> {
    let mut query = connection.prepare_cached(
        "INSERT INTO task_board_state (task_id, label, since_ms)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(task_id) DO UPDATE SET label = excluded.label, since_ms = excluded.since_ms
         WHERE label <> excluded.label",
    )?;
    query.execute(params![id, label, at])?;
    Ok(())
}
