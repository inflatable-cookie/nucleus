use nucleus_core::QuestionDelivery;
use rusqlite::{OptionalExtension, Row, params};
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
CREATE TABLE IF NOT EXISTS project_tell_requests (
  key TEXT PRIMARY KEY,
  recorded_at INTEGER NOT NULL,
  deliveries TEXT NOT NULL CHECK (json_valid(deliveries)),
  no_live_planners TEXT NOT NULL CHECK (json_valid(no_live_planners))
) STRICT;";

const WINDOW_MS: i64 = 3_600_000;
const RECIPIENT_LIMIT: u32 = 20;
const DELIVERY_COLUMNS: &str =
    "id, request_key, sender, from_project, to_project, text, recorded_at, state, retry_at";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TellState {
    Pending,
    InFlight(QuestionDelivery),
    Accepted(QuestionDelivery),
    Delivered { at_ms: i64, thread: String },
}

impl TellState {
    #[must_use]
    pub const fn attempt(&self) -> Option<&QuestionDelivery> {
        match self {
            Self::InFlight(notice) | Self::Accepted(notice) => Some(notice),
            Self::Pending | Self::Delivered { .. } => None,
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
    /// Recover an identical request's original recipient set and current receipts.
    ///
    /// # Errors
    /// Returns an error if the stored request or receipts cannot be read.
    pub fn tell_replay(&self, key: &str, now: i64) -> Result<Option<StoredTell>, StoreError> {
        let Some((recorded, ids, no_live_planners)) = self
            .connection
            .query_row(
                "SELECT recorded_at, deliveries, no_live_planners FROM project_tell_requests WHERE key = ?1",
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
        let mut query = self.connection.prepare_cached(&format!(
            "SELECT {DELIVERY_COLUMNS} FROM project_tell_deliveries WHERE id = ?1"
        ))?;
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
                        "SELECT {DELIVERY_COLUMNS} FROM project_tell_deliveries
                    WHERE to_project = ?1 AND from_project = ?2 AND text = ?3
                    AND (recorded_at > ?4 OR retry_at IS NOT NULL)
                    ORDER BY retry_at IS NOT NULL DESC, recorded_at DESC, id LIMIT 1"
                    ),
                    params![project, tell.from_project, tell.text, cutoff],
                    delivery,
                )
                .optional()?;
            if let Some(prior) = prior {
                output.push(prior);
                continue;
            }
            let count: u32 = tx.query_row(
                "SELECT count(*) FROM project_tell_deliveries WHERE to_project = ?1 AND recorded_at > ?2",
                params![project, cutoff],
                |row| row.get(0),
            )?;
            if count >= RECIPIENT_LIMIT {
                return Err(StoreError::TellRateLimit(project.clone()));
            }
            let row = TellDelivery {
                id: id.clone(),
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

    /// Read the next scheduled delivery and its durable due time.
    ///
    /// # Errors
    /// Returns an error if the delivery cannot be read.
    pub fn next_tell(&self) -> Result<Option<TellDelivery>, StoreError> {
        Ok(self
            .connection
            .query_row(
                &format!(
                    "SELECT {DELIVERY_COLUMNS} FROM project_tell_deliveries
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
        match transition {
            TellDispatch::Advance(state) => {
                let due = (!matches!(state, TellState::Delivered { .. }))
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
            }
            TellDispatch::Defer => {
                let mut update = tx.prepare(&format!(
                    "UPDATE project_tell_deliveries SET retry_at = ?2 + delay_ms,
                        delay_ms = min(delay_ms * 2, 300000) WHERE {column} = ?1"
                ))?;
                for id in ids {
                    update.execute(params![id, now])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }
}

fn delivery(row: &Row<'_>) -> rusqlite::Result<TellDelivery> {
    let encoded: String = row.get(7)?;
    let state = serde_json::from_str(&encoded).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(TellDelivery {
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
