use nucleus_core::QuestionDelivery;
use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS project_tell_deliveries (
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
CREATE INDEX IF NOT EXISTS project_tells_recipient ON project_tell_deliveries (to_project, recorded_at);
CREATE INDEX IF NOT EXISTS project_tells_due ON project_tell_deliveries (retry_at, id)
  WHERE retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_tells_command ON project_tell_deliveries (command)
  WHERE command IS NOT NULL;
CREATE TABLE IF NOT EXISTS tell_reply_handles (
  handle TEXT PRIMARY KEY, delivery TEXT NOT NULL, recipient TEXT NOT NULL, issued_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS tell_reply_recipient ON tell_reply_handles (recipient, issued_at);
CREATE TABLE IF NOT EXISTS tell_direct_targets (
  delivery TEXT PRIMARY KEY, thread TEXT NOT NULL, gone INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS project_tell_requests (
  key TEXT PRIMARY KEY,
  recorded_at INTEGER NOT NULL,
  deliveries TEXT NOT NULL CHECK (json_valid(deliveries)),
  no_live_planners TEXT NOT NULL CHECK (json_valid(no_live_planners))
) STRICT;";

const WINDOW_MS: i64 = 3_600_000;
const RECIPIENT_LIMIT: u32 = 20;
const SELECT_DELIVERY: &str =
    "SELECT id, request_key, sender, from_project, to_project, text, recorded_at, state, retry_at,
    CASE WHEN gone = 0 THEN thread END, CASE WHEN gone = 1 THEN thread END
    FROM project_tell_deliveries LEFT JOIN tell_direct_targets ON delivery = id";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TellState {
    Pending,
    Refused,
    InFlight(QuestionDelivery),
    Accepted(QuestionDelivery),
    Delivered { at_ms: i64, thread: String },
}

impl TellState {
    #[must_use]
    pub const fn attempt(&self) -> Option<&QuestionDelivery> {
        match self {
            Self::InFlight(notice) | Self::Accepted(notice) => Some(notice),
            Self::Refused | Self::Pending | Self::Delivered { .. } => None,
        }
    }

    #[must_use]
    pub fn thread(&self) -> Option<&str> {
        match self {
            Self::Delivered { thread, .. } => Some(thread),
            _ => self.attempt().map(|notice| notice.thread.as_str()),
        }
    }
}

#[derive(Debug)]
pub struct TellDelivery {
    pub id: String,
    pub request_key: String,
    pub direct: Option<String>,
    pub gone_sender: Option<String>,
    pub sender: String,
    pub from_project: String,
    pub to_project: String,
    pub text: String,
    pub recorded_at: i64,
    pub state: TellState,
    pub retry_at: Option<i64>,
}

pub struct TellSubmission<'a> {
    pub key: &'a str,
    pub sender: &'a str,
    pub direct: Option<&'a str>,
    pub from_project: &'a str,
    pub text: &'a str,
    pub recorded_at: i64,
    pub no_live_planners: &'a [TellProject],
}

#[derive(Serialize, Deserialize)]
pub struct TellProject {
    pub id: String,
    pub name: String,
}

pub struct StoredTell {
    pub deliveries: Vec<TellDelivery>,
    pub no_live_planners: Vec<TellProject>,
}

pub enum TellDispatch {
    Send {
        notice: QuestionDelivery,
        handle: String,
    },
    /// Defer a read or retry using the existing deadline's backoff.
    Defer,
    /// A meaningful transition starts a new backoff.
    Advance(TellState),
}

#[derive(Clone, Copy)]
pub enum TellRows<'a> {
    Receipt(&'a str),
    Receipts(&'a [&'a str]),
    Attempt(&'a str),
}

impl Store {
    /// Whether another planner launch is already in progress for this project.
    ///
    /// # Errors
    /// Returns a storage error if the delivery queue cannot be queried.
    pub fn has_pending_planner_launch(
        &self,
        project: &str,
        exclude_id: &str,
    ) -> Result<bool, StoreError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM project_tell_deliveries
                WHERE to_project = ?1 AND id <> ?2 AND command LIKE 'assess-launch-%' AND retry_at IS NOT NULL
            )",
            params![project, exclude_id],
            |row| row.get(0),
        )?)
    }

    /// Did a durable claim replacement already enqueue its notice?
    ///
    /// # Errors
    /// Returns a storage error if the request index cannot be read.
    pub fn has_tell_request(&self, key: &str) -> Result<bool, StoreError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM project_tell_requests WHERE key = ?1)",
            [key],
            |row| row.get(0),
        )?)
    }

    /// Resolve an unexpired handle only for its addressed thread.
    ///
    /// # Errors
    /// Returns a storage error if the recorded route cannot be read.
    pub fn tell_reply_route(
        &self,
        handle: &str,
        actor: &str,
        now: i64,
    ) -> Result<Option<(String, String)>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT d.from_project, d.sender FROM tell_reply_handles h
             JOIN project_tell_deliveries d ON d.id = h.delivery
             WHERE h.handle = ?1 AND h.recipient = ?2 AND h.issued_at > ?3",
                params![handle, actor, now.saturating_sub(7 * 24 * WINDOW_MS)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    /// Is this handle already issued? The primary key spans expired handles too,
    /// so a new handle must avoid every issued one, not only the unexpired ones.
    ///
    /// # Errors
    /// Returns a storage error if the handle index cannot be read.
    pub fn tell_reply_handle_issued(&self, handle: &str) -> Result<bool, StoreError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM tell_reply_handles WHERE handle = ?1)",
            [handle],
            |row| row.get(0),
        )?)
    }

    /// Recover an identical request's original recipient set and current receipts.
    ///
    /// # Errors
    /// Returns an error if the stored request or receipts cannot be read.
    pub fn tell_replay(&self, key: &str, now: i64) -> Result<Option<StoredTell>, StoreError> {
        let Some((recorded, ids, no_live_planners)) = self
            .connection
            .query_row(
                "SELECT recorded_at, deliveries, no_live_planners FROM project_tell_requests WHERE key = ?1 AND json_array_length(deliveries) > 0",
                [key],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            )
            .optional()?
        else {
            return Ok(None);
        };
        let deliveries = self.tell_deliveries(&ids)?;
        if recorded > now.saturating_sub(WINDOW_MS)
            || deliveries.iter().any(|row| row.retry_at.is_some())
        {
            Ok(Some(StoredTell {
                deliveries,
                no_live_planners: serde_json::from_str(&no_live_planners)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Read the original recipients together for routing and grouping.
    ///
    /// # Errors
    /// Returns an error if the request or receipts cannot be read.
    pub fn tell_batch(&self, key: &str) -> Result<Vec<TellDelivery>, StoreError> {
        let ids: String = self.connection.query_row(
            "SELECT deliveries FROM project_tell_requests WHERE key = ?1",
            [key],
            |row| row.get(0),
        )?;
        self.tell_deliveries(&ids)
    }

    fn tell_deliveries(&self, encoded_ids: &str) -> Result<Vec<TellDelivery>, StoreError> {
        let ids: Vec<String> = serde_json::from_str(encoded_ids)?;
        let mut query = self
            .connection
            .prepare_cached(&format!("{SELECT_DELIVERY} WHERE id = ?1"))?;
        Ok(ids
            .iter()
            .map(|id| query.query_row([id], delivery))
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Record the entire recipient set atomically, reusing recent or unresolved
    /// copies of the same text from the same project.
    ///
    /// # Errors
    /// Returns an error if a recipient is over its rate limit or the batch cannot be stored.
    pub fn record_tell(
        &mut self,
        tell: &TellSubmission<'_>,
        recipients: &[(String, String)],
    ) -> Result<Vec<TellDelivery>, StoreError> {
        let cutoff = tell.recorded_at.saturating_sub(WINDOW_MS);
        let tx = self.connection.transaction()?;
        let mut output = Vec::with_capacity(recipients.len());
        for (project, id) in recipients {
            let prior = tx
                .query_row(
                    &format!(
                        "{SELECT_DELIVERY}
                    WHERE to_project = ?1 AND from_project = ?2 AND text = ?3
                    AND (?6 IS NULL OR request_key = ?7) AND sender = ?5
                    AND thread IS ?6
                    AND (recorded_at > ?4 OR retry_at IS NOT NULL)
                    ORDER BY retry_at IS NOT NULL DESC, recorded_at DESC, id LIMIT 1"
                    ),
                    params![
                        project,
                        tell.from_project,
                        tell.text,
                        cutoff,
                        tell.sender,
                        tell.direct,
                        tell.key
                    ],
                    delivery,
                )
                .optional()?;
            if let Some(prior) = prior {
                output.push(prior);
                continue;
            }
            // Direct replies have a thread recipient. Project broadcasts keep the project admission cap.
            // Replacement notices are durable internal requests and obey the delivery cap below.
            if !tell.key.starts_with("claim-") {
                let count: u32 = if let Some(thread) = tell.direct {
                    tx.query_row(
                        "SELECT count(*) FROM tell_direct_targets t JOIN project_tell_deliveries d ON d.id=t.delivery
                         WHERE t.thread=?1 AND d.recorded_at>?2", params![thread, cutoff], |row| row.get(0)
                    )?
                } else {
                    tx.query_row(
                        "SELECT count(*) FROM project_tell_deliveries WHERE to_project = ?1 AND recorded_at > ?2",
                        params![project, cutoff], |row| row.get(0)
                    )?
                };
                if count >= RECIPIENT_LIMIT {
                    return Err(StoreError::TellRateLimit(project.clone()));
                }
            }
            let row = TellDelivery {
                id: id.clone(),
                direct: tell.direct.map(str::to_owned),
                gone_sender: None,
                request_key: tell.key.into(),
                sender: tell.sender.into(),
                from_project: tell.from_project.into(),
                to_project: project.clone(),
                text: tell.text.into(),
                recorded_at: tell.recorded_at,
                state: TellState::Pending,
                retry_at: Some(tell.recorded_at),
            };
            tx.execute(
                "INSERT INTO project_tell_deliveries
                    (id, sender, from_project, to_project, text, recorded_at, state, retry_at, request_key)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?8)",
                params![
                    row.id,
                    row.sender,
                    row.from_project,
                    row.to_project,
                    row.text,
                    row.recorded_at,
                    serde_json::to_string(&row.state)?,
                    tell.key
                ],
            )?;
            if let Some(thread) = tell.direct {
                tx.execute(
                    "INSERT INTO tell_direct_targets (delivery, thread) VALUES (?1, ?2)",
                    params![id, thread],
                )?;
            }
            output.push(row);
        }
        let ids: Vec<_> = output.iter().map(|row| &row.id).collect();
        tx.execute(
            "INSERT INTO project_tell_requests (key, recorded_at, deliveries, no_live_planners)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(key) DO UPDATE SET recorded_at = excluded.recorded_at,
                deliveries = excluded.deliveries, no_live_planners = excluded.no_live_planners",
            params![
                tell.key,
                tell.recorded_at,
                serde_json::to_string(&ids)?,
                serde_json::to_string(tell.no_live_planners)?
            ],
        )?;
        tx.commit()?;
        Ok(output)
    }

    /// Route a pending reply through its saved destination project after the exact sender is gone.
    ///
    /// # Errors
    /// Returns a storage error if the route cannot be updated.
    pub fn fallback_reply(&self, id: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE tell_direct_targets SET gone = 1 WHERE delivery = ?1 AND EXISTS (
                SELECT 1 FROM project_tell_deliveries WHERE id = ?1 AND state = ?2)",
            params![id, serde_json::to_string(&TellState::Pending)?],
        )?;
        Ok(())
    }

    /// Read the next scheduled delivery and its durable due time.
    ///
    /// # Errors
    /// Returns an error if the delivery cannot be read.
    pub fn next_tell(&self) -> Result<Option<TellDelivery>, StoreError> {
        Ok(self
            .connection
            .query_row(
                &format!(
                    "{SELECT_DELIVERY}
                WHERE retry_at IS NOT NULL ORDER BY retry_at, id LIMIT 1"
                ),
                [],
                delivery,
            )
            .optional()?)
    }

    /// Record one scheduler transition or back off without changing the saved intent.
    ///
    /// # Errors
    /// Returns an error if the transition cannot be recorded.
    pub fn settle_tells(
        &mut self,
        rows: TellRows<'_>,
        transition: TellDispatch,
        now: i64,
    ) -> Result<(), StoreError> {
        let (column, ids) = match &rows {
            TellRows::Receipt(id) => ("id", std::slice::from_ref(id)),
            TellRows::Receipts(ids) => ("id", *ids),
            TellRows::Attempt(command) => ("command", std::slice::from_ref(command)),
        };
        let tx = self.connection.transaction()?;
        let next_state = match transition {
            TellDispatch::Send { notice, handle } => {
                let id = ids.first().ok_or(StoreError::PlanningInput)?;
                let oldest: Option<i64> = tx.query_row(
                    "SELECT max(first_at) FROM (
                       SELECT min(issued_at) AS first_at FROM tell_reply_handles
                       WHERE recipient = ?1 AND issued_at > ?2 AND delivery <> ?3
                       GROUP BY delivery ORDER BY first_at DESC LIMIT 1 OFFSET ?4)",
                    params![
                        notice.thread,
                        now.saturating_sub(WINDOW_MS),
                        id,
                        RECIPIENT_LIMIT - 1
                    ],
                    |row| row.get(0),
                )?;
                if let Some(oldest) = oldest {
                    for id in ids {
                        tx.execute(
                            "UPDATE project_tell_deliveries SET retry_at = ?2 WHERE id = ?1",
                            params![id, oldest.saturating_add(WINDOW_MS)],
                        )?;
                    }
                    tx.commit()?;
                    return Err(StoreError::TellRateLimit(notice.thread));
                }
                tx.execute(
                    "INSERT INTO tell_reply_handles (handle, delivery, recipient, issued_at) VALUES (?1, ?2, ?3, ?4)",
                    params![handle, id, notice.thread, now],
                )?;
                Some(TellState::InFlight(notice))
            }
            TellDispatch::Advance(state) => Some(state),
            TellDispatch::Defer => None,
        };
        if let Some(state) = next_state {
            let due = (!matches!(state, TellState::Delivered { .. } | TellState::Refused))
                .then_some(now.saturating_add(5_000));
            let encoded = serde_json::to_string(&state)?;
            let command = state.attempt().map(|notice| &notice.command);
            let mut update = tx.prepare(&format!(
                "UPDATE project_tell_deliveries SET state = ?2, retry_at = ?3,
                     delay_ms = 5000, command = ?4 WHERE {column} = ?1"
            ))?;
            for id in ids {
                update.execute(params![id, encoded, due, command])?;
            }
        } else {
            let mut update = tx.prepare(&format!(
                "UPDATE project_tell_deliveries SET retry_at = ?2 + delay_ms,
                        delay_ms = min(delay_ms * 2, 300000) WHERE {column} = ?1"
            ))?;
            for id in ids {
                update.execute(params![id, now])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

pub(crate) fn insert_tell_in_tx(
    tx: &Transaction<'_>,
    project: &str,
    tell: &TellSubmission<'_>,
    tell_id: &str,
) -> Result<(), StoreError> {
    let state = serde_json::to_string(&TellState::Pending)?;
    tx.execute(
        "INSERT INTO project_tell_deliveries
            (id, sender, from_project, to_project, text, recorded_at, state, retry_at, request_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?8)",
        params![
            tell_id,
            tell.sender,
            tell.from_project,
            project,
            tell.text,
            tell.recorded_at,
            state,
            tell.key,
        ],
    )?;
    if let Some(thread) = tell.direct {
        tx.execute(
            "INSERT INTO tell_direct_targets (delivery, thread) VALUES (?1, ?2)",
            params![tell_id, thread],
        )?;
    }
    tx.execute(
        "INSERT INTO project_tell_requests (key, recorded_at, deliveries, no_live_planners)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            tell.key,
            tell.recorded_at,
            serde_json::to_string(&[tell_id])?,
            serde_json::to_string(tell.no_live_planners)?,
        ],
    )?;
    Ok(())
}

fn delivery(row: &Row<'_>) -> rusqlite::Result<TellDelivery> {
    let encoded: String = row.get(7)?;
    let state = serde_json::from_str(&encoded).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(TellDelivery {
        direct: row.get(9)?,
        gone_sender: row.get(10)?,
        id: row.get(0)?,
        request_key: row.get(1)?,
        sender: row.get(2)?,
        from_project: row.get(3)?,
        to_project: row.get(4)?,
        text: row.get(5)?,
        recorded_at: row.get(6)?,
        state,
        retry_at: row.get(8)?,
    })
}
