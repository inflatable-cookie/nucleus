use std::{num::NonZeroU64, time::SystemTime};

use nucleus_core::{Head, Review};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::{EventDraft, Store, StoreError, append};

const EVENT: &str = "review_publication";

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
        use ReviewPublicationOutcome::{Deferred, Pending, ResubmissionDeferred, Resubmitted};

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
            Some(Deferred(until)) if SystemTime::now() >= until => Pending,
            Some(ResubmissionDeferred(until)) if SystemTime::now() >= until => Resubmitted,
            _ => return Ok(None),
        };
        let pending = ReviewPublication {
            intent: intent.clone(),
            outcome,
            recorded_at: at,
        };
        append(&tx, task, &audit(&pending, at)?)?;
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
        at: i64,
    ) -> Result<(), StoreError> {
        use ReviewPublicationOutcome::{
            AccessRefused, Deferred, Pending, Refused, ResubmissionDeferred, Resubmitted,
            Submitted, Verified,
        };

        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let recorded = read(&tx, task, &intent.instance)?
            .filter(|recorded| recorded.intent == *intent)
            .ok_or(StoreError::ReviewPublicationConflict)?;
        if recorded.outcome == outcome {
            return Ok(());
        }
        match (recorded.outcome, outcome) {
            (Pending | Resubmitted, Submitted(_) | Verified(_) | AccessRefused | Refused)
            | (Resubmitted, Pending | ResubmissionDeferred(_))
            | (Pending, Deferred(_))
            | (ResubmissionDeferred(_), Verified(_)) => {}
            (Submitted(sent), Verified(verified)) if sent == verified => {}
            _ => return Err(StoreError::ReviewPublicationConflict),
        }
        append(
            &tx,
            task,
            &audit(
                &ReviewPublication {
                    intent: intent.clone(),
                    outcome,
                    recorded_at: at,
                },
                at,
            )?,
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
        "SELECT at, detail FROM events WHERE task_id = ?1 AND kind = ?2
         AND json_extract(detail, '$.intent.instance') = ?3 ORDER BY sequence DESC LIMIT 1",
    )?;
    let row: Option<(i64, String)> = query
        .query_row(params![task, EVENT, instance], |row| {
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

fn audit(publication: &ReviewPublication, at: i64) -> Result<EventDraft, StoreError> {
    Ok(EventDraft {
        at,
        kind: EVENT.into(),
        detail: serde_json::to_string(publication)?,
    })
}
