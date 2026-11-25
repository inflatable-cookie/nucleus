use std::num::NonZeroU64;

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
    pub body_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPublicationOutcome {
    Pending,
    Submitted(NonZeroU64),
    Verified(NonZeroU64),
    AccessRefused,
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewPublication {
    pub intent: ReviewIntent,
    pub outcome: ReviewPublicationOutcome,
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

    /// Claim the one GitHub write for the run before sending its request.
    ///
    /// # Errors
    /// Returns an error if the claim cannot be committed.
    pub fn claim_review_publication(
        &mut self,
        task: &str,
        intent: &ReviewIntent,
        at: i64,
    ) -> Result<bool, StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if read(&tx, task, &intent.instance)?.is_some() {
            return Ok(false);
        }
        let pending = ReviewPublication {
            intent: intent.clone(),
            outcome: ReviewPublicationOutcome::Pending,
        };
        append(&tx, task, &audit(&pending, at)?)?;
        tx.commit()?;
        Ok(true)
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
        use ReviewPublicationOutcome::{AccessRefused, Pending, Refused, Submitted, Verified};

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
            (Pending, Submitted(_) | Verified(_) | AccessRefused | Refused) => {}
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
        "SELECT detail FROM events WHERE task_id = ?1 AND kind = ?2
         AND json_extract(detail, '$.intent.instance') = ?3 ORDER BY sequence DESC LIMIT 1",
    )?;
    let detail: Option<String> = query
        .query_row(params![task, EVENT, instance], |row| row.get(0))
        .optional()?;
    detail
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(StoreError::from)
}

fn audit(publication: &ReviewPublication, at: i64) -> Result<EventDraft, StoreError> {
    Ok(EventDraft {
        at,
        kind: EVENT.into(),
        detail: serde_json::to_string(publication)?,
    })
}
