use std::{num::NonZeroU64, time::SystemTime};

use nucleus_core::{Head, Review};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::{EventDraft, Store, StoreError, append};

const EVENT: &str = "review_publication";
pub(super) const SCHEMA: &str = "CREATE TABLE review_publications (
    task_id TEXT NOT NULL REFERENCES tasks(id), instance TEXT NOT NULL,
    at INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)),
    PRIMARY KEY (task_id, instance)
) STRICT";

/// The immutable GitHub write authorized by one authenticated reviewer run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewIntent {
    pub instance: String,
    pub pull_url: String,
    pub head: Head,
    pub decision: Review,
    pub author: NonZeroU64,
    pub pull_author: NonZeroU64,
    pub body_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPublicationOutcome {
    Pending,
    Resubmitted,
    FinalAttempt,
    FinalAttemptDeferred(SystemTime),
    Deferred(SystemTime),
    ResubmissionDeferred(SystemTime),
    Submitted(NonZeroU64),
    Verified(NonZeroU64),
    AccessRefused,
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewPublication {
    pub intent: ReviewIntent,
    pub outcome: ReviewPublicationOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
    #[serde(skip)]
    pub recorded_at: i64,
}

impl Store {
    /// Read the most recent publication record for an exact reviewer run.
    ///
    /// # Errors
    /// Returns an error if the journal is unreadable.
    pub fn review_publication(
        &self,
        task: &str,
        instance: &str,
    ) -> Result<Option<ReviewPublication>, StoreError> {
        read(&self.connection, task, instance)
    }

    /// Claim the next eligible write, preserving the attempt after a definite throttle.
    ///
    /// # Errors
    /// Returns an error if the claim cannot be committed.
    pub fn claim_review_publication(
        &mut self,
        task: &str,
        intent: &ReviewIntent,
        previous: Option<&ReviewPublication>,
        at: i64,
    ) -> Result<Option<ReviewPublicationOutcome>, StoreError> {
        use ReviewPublicationOutcome::{
            Deferred, FinalAttempt, FinalAttemptDeferred, Pending, ResubmissionDeferred,
            Resubmitted,
        };

        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if previous.is_some_and(|record| record.intent != *intent)
            || read(&tx, task, &intent.instance)?.as_ref() != previous
        {
            return Ok(None);
        }
        let outcome = match previous.map(|record| record.outcome) {
            None => Pending,
            Some(Pending) => Resubmitted,
            Some(Resubmitted) => FinalAttempt,
            Some(FinalAttemptDeferred(until)) if SystemTime::now() >= until => FinalAttempt,
            Some(Deferred(until)) if SystemTime::now() >= until => Pending,
            Some(ResubmissionDeferred(until)) if SystemTime::now() >= until => Resubmitted,
            _ => return Ok(None),
        };
        let pending = ReviewPublication {
            intent: intent.clone(),
            outcome,
            response: None,
            recorded_at: at,
        };
        save(&tx, task, &pending)?;
        tx.commit()?;
        Ok(Some(outcome))
    }

    /// Settle or record the receipt of the original write without replacing its intent.
    ///
    /// # Errors
    /// Returns an error if the journal changed or the outcome cannot be committed.
    pub fn record_review_publication(
        &mut self,
        task: &str,
        intent: &ReviewIntent,
        outcome: ReviewPublicationOutcome,
        response: Option<&str>,
        at: i64,
    ) -> Result<(), StoreError> {
        use ReviewPublicationOutcome::{
            AccessRefused, Deferred, FinalAttempt, FinalAttemptDeferred, Pending, Refused,
            ResubmissionDeferred, Resubmitted, Submitted, Verified,
        };

        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let recorded = read(&tx, task, &intent.instance)?
            .filter(|recorded| recorded.intent == *intent)
            .ok_or(StoreError::ReviewPublicationConflict)?;
        if recorded.outcome == outcome
            && (response.is_none() || recorded.response.as_deref() == response)
        {
            return Ok(());
        }
        match (recorded.outcome, outcome) {
            (prior, next)
                if prior == next && matches!(next, Pending | Resubmitted | FinalAttempt) => {}
            (
                Pending | Resubmitted | FinalAttempt,
                Submitted(_) | Verified(_) | AccessRefused | Refused,
            )
            | (Resubmitted, Pending | ResubmissionDeferred(_))
            | (FinalAttempt, FinalAttemptDeferred(_))
            | (Pending, Deferred(_))
            | (Deferred(_) | ResubmissionDeferred(_) | FinalAttemptDeferred(_), Verified(_)) => {}
            (Submitted(sent), Verified(verified)) if sent == verified => {}
            _ => return Err(StoreError::ReviewPublicationConflict),
        }
        save(
            &tx,
            task,
            &ReviewPublication {
                intent: intent.clone(),
                outcome,
                response: response.map(str::to_owned),
                recorded_at: at,
            },
        )?;
        tx.commit()?;
        Ok(())
    }
}

fn read(
    connection: &Connection,
    task: &str,
    instance: &str,
) -> Result<Option<ReviewPublication>, StoreError> {
    let mut query = connection.prepare_cached(
        "SELECT at, record FROM review_publications WHERE task_id = ?1 AND instance = ?2",
    )?;
    let row: Option<(i64, String)> = query
        .query_row(params![task, instance], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    row.map(|(at, detail)| {
        let mut record: ReviewPublication = serde_json::from_str(&detail)?;
        record.recorded_at = at;
        Ok(record)
    })
    .transpose()
}

fn save(
    tx: &Transaction<'_>,
    task: &str,
    publication: &ReviewPublication,
) -> Result<(), StoreError> {
    let audit = EventDraft {
        at: publication.recorded_at,
        kind: EVENT.into(),
        detail: serde_json::to_string(publication)?,
    };
    set_current(
        tx,
        task,
        &publication.intent.instance,
        audit.at,
        &audit.detail,
    )?;
    append(tx, task, &audit)?;
    Ok(())
}

fn set_current(
    tx: &Transaction<'_>,
    task: &str,
    instance: &str,
    at: i64,
    record: &str,
) -> rusqlite::Result<()> {
    tx.prepare_cached(
        "INSERT INTO review_publications(task_id,instance,at,record) VALUES (?1,?2,?3,?4)
        ON CONFLICT(task_id,instance) DO UPDATE SET at=excluded.at,record=excluded.record",
    )?
    .execute(params![task, instance, at, record])?;
    Ok(())
}

pub(super) fn migrate(tx: &Transaction<'_>) -> Result<(), StoreError> {
    tx.execute_batch(SCHEMA)?;
    let mut stmt = tx
        .prepare("SELECT sequence,task_id,at,detail FROM events WHERE kind=?1 ORDER BY sequence")?;
    let mut rows = stmt.query([EVENT])?;
    while let Some(row) = rows.next()? {
        let sequence = row.get(0)?;
        let task: String = row.get(1)?;
        let raw: String = row.get(3)?;
        let invalid = || StoreError::InvalidPublicationEvent {
            task: task.clone(),
            sequence,
        };
        let record: ReviewPublication = serde_json::from_str(&raw).map_err(|_| invalid())?;
        if record.intent.instance.is_empty()
            || record.intent.body_digest.len() != 64
            || !record
                .intent
                .body_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || read(tx, &task, &record.intent.instance)?
                .is_some_and(|last| last.intent != record.intent)
        {
            return Err(invalid());
        }
        set_current(tx, &task, &record.intent.instance, row.get(2)?, &raw)?;
    }
    Ok(())
}
