use rusqlite::{Connection, params};

use crate::{Store, StoreError};

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS task_board_state (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    since_ms INTEGER NOT NULL CHECK (since_ms >= 0)
) STRICT";

impl Store {
    /// Read state entry, admission and latest work event times for the board.
    ///
    /// # Errors
    /// Returns an error if the timestamps cannot be read.
    pub fn board_times(&self, id: &str) -> Result<BoardTimes, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT (SELECT since_ms FROM task_board_state WHERE task_id = ?1),
                    (SELECT at FROM events WHERE task_id = ?1 ORDER BY sequence LIMIT 1),
                    (SELECT at FROM events WHERE task_id = ?1
                       AND kind NOT IN (
                         'question_delivery', 'operator_decline_notified', 'provider_limit',
                         'delegated_parent_ended', 'paused_reservation_released',
                         'host_send_not_sent', 'report_ready_planner_unavailable',
                         'role_threads_archived', 'role_archive_progress', 'project_removed'
                       )
                       AND kind NOT GLOB 'closed_checkout_*'
                       AND kind NOT GLOB 'host_observation_*'
                       AND kind NOT GLOB 'native_row_*'
                       AND kind NOT GLOB 'native_turn_*'
                       AND kind NOT GLOB '*_observed'
                       AND kind NOT GLOB '*_notice_*'
                       AND kind NOT GLOB 'acp_row_refresh_*'
                       AND kind NOT GLOB '*wait_*'
                       AND kind NOT GLOB '*prune*'
                       AND kind NOT GLOB '*title_*'
                       AND kind NOT GLOB '*snooze*'
                       AND kind NOT GLOB 'telemetry_*'
                     ORDER BY sequence DESC LIMIT 1)",
        )?;
        Ok(query.query_row([id], |row| {
            let time = |column| {
                row.get::<_, Option<i64>>(column)
                    .map(|value| value.and_then(|value| u64::try_from(value).ok()))
            };
            Ok(BoardTimes {
                since: time(0)?,
                admitted: time(1)?,
                latest_event: time(2)?,
            })
        })?)
    }

    /// Record the time of a scheduler transition without changing task version.
    ///
    /// # Errors
    /// Returns an error if the timestamp cannot be written.
    pub fn record_board_entry(&self, id: &str, at: i64) -> Result<(), StoreError> {
        record(&self.connection, id, at)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct BoardTimes {
    pub since: Option<u64>,
    pub admitted: Option<u64>,
    pub latest_event: Option<u64>,
}

pub(super) fn record(connection: &Connection, id: &str, at: i64) -> Result<(), StoreError> {
    connection
        .prepare_cached(
            "INSERT INTO task_board_state (task_id, since_ms) VALUES (?1, ?2)
         ON CONFLICT(task_id) DO UPDATE SET since_ms = excluded.since_ms",
        )?
        .execute(params![id, at])?;
    Ok(())
}
