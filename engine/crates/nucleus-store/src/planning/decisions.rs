use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use super::{
    Decision, DecisionAnswer, DecisionAnswerInput, DecisionInput, DecisionKind, DecisionOption,
    DecisionRecord, DecisionTarget, WriteAt, decode, insert, list, read, required, save, valid_key,
};
use crate::{Store, StoreError, TellSubmission, load};

pub(crate) const USAGE_PERMISSION_INDEX: &str =
    "CREATE UNIQUE INDEX IF NOT EXISTS planning_usage_permission
    ON planning_decisions(id) WHERE json_extract(snapshot, '$.task.kind') = 'usage_permission'";

pub const USAGE_APPROVE: &str = "approve";
const PROCESS_DECISION: &str = "closeout-process-";

impl Decision {
    /// A decision an older engine raised about a process holding a checkout.
    #[must_use]
    pub fn is_process_custody(&self) -> bool {
        self.author == "Nucleus" && self.task.is_none() && self.id.starts_with(PROCESS_DECISION)
    }
}

/// Data needed to bind a Low usage decision in the task admission transaction.
pub struct UsagePermission<'a> {
    pub project: &'a str,
    pub complexity: &'static str,
    pub at_ms: u64,
}

impl DecisionInput {
    /// Validate a new decision, including the identity and labels of its choices.
    ///
    /// # Errors
    /// Returns an error for invalid fields or repeated option labels after trimming.
    pub fn validate(&self) -> Result<(), StoreError> {
        let mut ids = BTreeSet::new();
        if self.question.trim().is_empty()
            || self.options.len() < 2
            || !self.options.iter().all(|option| {
                valid_key(&option.id) && !option.label.trim().is_empty() && ids.insert(&option.id)
            })
        {
            return Err(StoreError::PlanningInput);
        }
        let mut labels = BTreeSet::new();
        if !self
            .options
            .iter()
            .all(|option| labels.insert(option.label.trim()))
        {
            return Err(StoreError::DuplicateDecisionOptionLabel);
        }
        Ok(())
    }
}

impl Store {
    /// Read the project's decisions, optionally limited to those awaiting answers.
    ///
    /// # Errors
    /// Returns an error if the decisions cannot be read.
    pub fn decisions(&self, project: &str, pending: bool) -> Result<Vec<Decision>, StoreError> {
        if !pending {
            return list(&self.connection, DecisionRecord, project);
        }
        let mut query = self.connection.prepare_cached(
            "SELECT snapshot FROM planning_decisions WHERE project = ?1
             AND json_extract(snapshot, '$.answer') IS NULL
             AND json_extract(snapshot, '$.withdrawn') IS NULL
             AND (json_extract(snapshot, '$.task') IS NULL OR EXISTS (
                 SELECT 1 FROM tasks WHERE tasks.id = json_extract(snapshot, '$.task.taskId')
                 AND CASE WHEN json_extract(snapshot, '$.task.kind') = 'usage_permission'
                     THEN tasks.phase NOT IN ('done', 'cancelled')
                     ELSE tasks.version = json_extract(snapshot, '$.task.taskVersion') END
             )) ORDER BY id",
        )?;
        let rows = query.query_map([project], |row| decode(row, 0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Read one decision, including an answered or withdrawn decision.
    ///
    /// # Errors
    /// Returns an error if the database cannot read the decision.
    pub fn decision(&self, project: &str, id: &str) -> Result<Option<Decision>, StoreError> {
        read(&self.connection, DecisionRecord, project, id)
    }

    /// Read one task version's decision, whether or not it has been answered.
    ///
    /// # Errors
    /// Returns an error if the database cannot read the decision.
    pub fn task_decision(
        &self,
        project: &str,
        target: &DecisionTarget,
    ) -> Result<Option<Decision>, StoreError> {
        let id = target.record_id();
        let decision = self.decision(project, &id)?;
        if decision
            .as_ref()
            .is_some_and(|record| record.task.as_ref() != Some(target))
        {
            return Err(StoreError::PlanningConflict);
        }
        Ok(decision)
    }

    /// Read the Low usage decision attached to the original admission, even after task edits.
    ///
    /// # Errors
    /// Returns an error if the database cannot read the decision.
    pub fn usage_permission(&self, task: &str) -> Result<Option<Decision>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT snapshot FROM planning_decisions WHERE id = ?1
             AND json_extract(snapshot, '$.task.kind') = 'usage_permission'",
                [format!("usage-permission-{task}")],
                |row| decode(row, 0),
            )
            .optional()?)
    }

    /// Record an operator question in the same store the Inbox reads.
    ///
    /// # Errors
    /// Returns an error for invalid input, a duplicate ID, or a database failure.
    pub fn add_decision(
        &mut self,
        project: &str,
        id: String,
        input: DecisionInput,
        stamp: WriteAt<'_>,
    ) -> Result<Decision, StoreError> {
        let decision = new_decision(project, id, input, stamp, None)?;
        let tx = self.planning_write()?;
        insert(
            &tx,
            DecisionRecord,
            project,
            &decision.id,
            "add",
            &decision,
            stamp,
        )?;
        tx.commit()?;
        Ok(decision)
    }

    /// Close an open process decision from an older engine and record why.
    ///
    /// # Errors
    /// Returns an error if the decision or its history cannot be saved.
    pub fn supersede_process_decision(
        &mut self,
        project: &str,
        id: &str,
        stamp: WriteAt<'_>,
    ) -> Result<bool, StoreError> {
        let tx = self.planning_write()?;
        let Some(mut decision) = read::<Decision>(&tx, DecisionRecord, project, id)? else {
            return Ok(false);
        };
        if !decision.is_process_custody() || decision.withdrawn || decision.answer.is_some() {
            return Ok(false);
        }
        decision.withdrawn = true;
        save(
            &tx,
            DecisionRecord,
            project,
            id,
            "supersede",
            &decision,
            stamp,
        )?;
        tx.execute(
            "UPDATE planning_history SET snapshot = json_set(snapshot, '$.note', ?1)
             WHERE sequence = ?2",
            params![
                "Checkout retirement now follows Dispatch, T3, and Git.",
                tx.last_insert_rowid()
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Record the answer. Task-linked decisions require the exact question row to remain current.
    ///
    /// # Errors
    /// Returns an error for a missing, obsolete, or withdrawn decision, unknown option, or database failure.
    pub fn answer_decision(
        &mut self,
        project: &str,
        id: &str,
        input: DecisionAnswerInput,
        stamp: WriteAt<'_>,
    ) -> Result<Decision, StoreError> {
        Ok(self
            .answer_decision_with_notice(project, id, input, stamp, None, None)?
            .0)
    }

    /// Record the answer and optionally queue one direct tell notice in the same transaction.
    ///
    /// # Errors
    /// Returns an error for a missing, obsolete, or withdrawn decision, unknown option, or database failure.
    pub fn answer_decision_with_notice(
        &mut self,
        project: &str,
        id: &str,
        input: DecisionAnswerInput,
        stamp: WriteAt<'_>,
        relayed: Option<String>,
        notice: Option<(&TellSubmission<'_>, &str)>,
    ) -> Result<(Decision, bool), StoreError> {
        let tx = self.planning_write()?;
        let mut decision: Decision = required(&tx, DecisionRecord, project, id)?;
        if decision.withdrawn
            || (decision.answer.is_some() && (decision.task.is_some() || relayed.is_some()))
        {
            return Err(StoreError::PlanningConflict);
        }
        let valid_option = |id: &str| decision.input.options.iter().any(|option| option.id == id);
        let free_text = input.answer.as_deref().map(str::trim);
        let valid = match free_text {
            Some(text) => {
                !text.is_empty()
                    && text.encode_utf16().count() <= 48_000
                    && input.option_id.is_empty()
                    && decision.task.is_none()
                    && input.based_on_option_id.as_deref().is_none_or(valid_option)
            }
            None => valid_option(&input.option_id) && input.based_on_option_id.is_none(),
        };
        if !valid
            || relayed.as_ref().is_some_and(|quote| {
                quote.trim().is_empty() || quote.encode_utf16().count() > 48_000
            })
        {
            return Err(StoreError::PlanningInput);
        }
        if let Some(target) = &decision.task {
            require_task_question(&tx, target)?;
        }
        let same_answer = decision.answer.as_ref().is_some_and(|existing| {
            existing.input.option_id == input.option_id
                && existing.input.answer == input.answer
                && existing.input.based_on_option_id == input.based_on_option_id
                && trimmed_note(existing.input.note.as_deref())
                    == trimmed_note(input.note.as_deref())
        });
        decision.answer = Some(DecisionAnswer {
            input,
            author: stamp.actor.into(),
            answered_at_ms: stamp.at_ms,
            relayed,
        });
        save(&tx, DecisionRecord, project, id, "answer", &decision, stamp)?;
        let queued = if !same_answer && let Some((tell, tell_id)) = notice {
            insert_decision_tell(&tx, project, tell, tell_id)?;
            true
        } else {
            false
        };
        tx.commit()?;
        Ok((decision, queued))
    }

    /// Reuse the Inbox decision for this task question, or create it once.
    ///
    /// # Errors
    /// Returns an error if the originating question changed, the input is invalid, or the write fails.
    pub fn ensure_task_decision(
        &mut self,
        project: &str,
        target: DecisionTarget,
        input: DecisionInput,
        stamp: WriteAt<'_>,
    ) -> Result<Decision, StoreError> {
        let id = target.record_id();
        let tx = self.planning_write()?;
        require_task_question(&tx, &target)?;
        if let Some(decision) = read::<Decision>(&tx, DecisionRecord, project, &id)? {
            if decision.task.as_ref() != Some(&target) || decision.withdrawn {
                return Err(StoreError::PlanningConflict);
            }
            return Ok(decision);
        }
        let decision = new_decision(project, id, input, stamp, Some(target))?;
        insert(
            &tx,
            DecisionRecord,
            project,
            &decision.id,
            "add",
            &decision,
            stamp,
        )?;
        tx.commit()?;
        Ok(decision)
    }

    /// Withdraw a task question from the Inbox while retaining its history.
    ///
    /// # Errors
    /// Returns an error if its state cannot be read or written.
    pub fn withdraw_task_decision(
        &mut self,
        project: &str,
        target: &DecisionTarget,
        stamp: WriteAt<'_>,
    ) -> Result<(), StoreError> {
        let id = target.record_id();
        let tx = self.planning_write()?;
        if let Some(mut decision) = read::<Decision>(&tx, DecisionRecord, project, &id)? {
            if decision.task.as_ref() != Some(target) {
                return Err(StoreError::PlanningConflict);
            }
            if !decision.withdrawn
                && (decision.answer.is_none() || target.kind == DecisionKind::UsagePermission)
            {
                decision.withdrawn = true;
                save(
                    &tx,
                    DecisionRecord,
                    project,
                    &id,
                    "withdraw",
                    &decision,
                    stamp,
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

pub(crate) fn insert_usage_permission(
    tx: &Transaction<'_>,
    task_id: &str,
    reference: &str,
    permission: &UsagePermission<'_>,
) -> Result<(), StoreError> {
    let stamp = WriteAt {
        actor: "Nucleus",
        at_ms: permission.at_ms,
    };
    let target = DecisionTarget {
        task_id: task_id.into(),
        task_version: 1,
        kind: DecisionKind::UsagePermission,
    };
    let decision = new_decision(
        permission.project,
        target.record_id(),
        DecisionInput {
            question: format!(
                "Run {reference} at Low usage with {} complexity?",
                permission.complexity
            ),
            options: vec![
                DecisionOption {
                    id: USAGE_APPROVE.into(),
                    label: "Approve at Low usage".into(),
                },
                DecisionOption {
                    id: "decline".into(),
                    label: "Decline and keep held".into(),
                },
            ],
        },
        stamp,
        Some(target),
    )?;
    insert(
        tx,
        DecisionRecord,
        permission.project,
        &decision.id,
        "add",
        &decision,
        stamp,
    )
}

fn trimmed_note(note: Option<&str>) -> Option<&str> {
    note.map(str::trim).filter(|note| !note.is_empty())
}

fn insert_decision_tell(
    tx: &Transaction<'_>,
    project: &str,
    tell: &TellSubmission<'_>,
    tell_id: &str,
) -> Result<(), StoreError> {
    // Decision answer notices bypass the hourly recipient cap like claim notices so operator answers always commit.
    tell.direct.ok_or(StoreError::PlanningInput)?;
    crate::tells::insert_tell_in_tx(tx, project, tell, tell_id)
}

fn new_decision(
    project: &str,
    id: String,
    input: DecisionInput,
    stamp: WriteAt<'_>,
    task: Option<DecisionTarget>,
) -> Result<Decision, StoreError> {
    input.validate()?;
    Ok(Decision {
        id,
        project_id: project.into(),
        input,
        author: stamp.actor.into(),
        created_at_ms: stamp.at_ms,
        answer: None,
        task,
        withdrawn: false,
    })
}

fn require_task_question(
    connection: &Connection,
    target: &DecisionTarget,
) -> Result<(), StoreError> {
    if load(connection, &target.task_id)?.is_some_and(|row| match target.kind {
        DecisionKind::Question => {
            row.version == target.task_version
                && row.task.operator_question().is_some()
                && row.task.operator_decline().is_none()
        }
        DecisionKind::UsagePermission => !row.task.phase().is_terminal(),
    }) {
        Ok(())
    } else {
        Err(StoreError::PlanningConflict)
    }
}
