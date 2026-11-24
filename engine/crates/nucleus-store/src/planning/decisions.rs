use std::collections::BTreeSet;

use rusqlite::Connection;

use super::{
    Decision, DecisionAnswer, DecisionAnswerInput, DecisionInput, DecisionRecord, DecisionTarget,
    WriteAt, decode, insert, list, read, required, save, task_decision_id, valid_key,
};
use crate::{Store, StoreError, load};

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
                 AND tasks.version = json_extract(snapshot, '$.task.taskVersion')
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
        insert(&tx, DecisionRecord, project, &decision.id, &decision, stamp)?;
        tx.commit()?;
        Ok(decision)
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
        let tx = self.planning_write()?;
        let mut decision: Decision = required(&tx, DecisionRecord, project, id)?;
        if decision.withdrawn || (decision.task.is_some() && decision.answer.is_some()) {
            return Err(StoreError::PlanningConflict);
        }
        if !decision
            .input
            .options
            .iter()
            .any(|option| option.id == input.option_id)
        {
            return Err(StoreError::PlanningInput);
        }
        if let Some(target) = &decision.task {
            require_task_question(&tx, target)?;
        }
        decision.answer = Some(DecisionAnswer {
            input,
            author: stamp.actor.into(),
            answered_at_ms: stamp.at_ms,
        });
        save(&tx, DecisionRecord, project, id, "answer", &decision, stamp)?;
        tx.commit()?;
        Ok(decision)
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
        let id = task_decision_id(&target.task_id, target.task_version);
        let tx = self.planning_write()?;
        require_task_question(&tx, &target)?;
        if let Some(decision) = read::<Decision>(&tx, DecisionRecord, project, &id)? {
            if decision.task.as_ref() != Some(&target) || decision.withdrawn {
                return Err(StoreError::PlanningConflict);
            }
            return Ok(decision);
        }
        let decision = new_decision(project, id, input, stamp, Some(target))?;
        insert(&tx, DecisionRecord, project, &decision.id, &decision, stamp)?;
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
        let id = task_decision_id(&target.task_id, target.task_version);
        let tx = self.planning_write()?;
        if let Some(mut decision) = read::<Decision>(&tx, DecisionRecord, project, &id)? {
            if decision.task.as_ref() != Some(target) {
                return Err(StoreError::PlanningConflict);
            }
            if !decision.withdrawn && decision.answer.is_none() {
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

fn new_decision(
    project: &str,
    id: String,
    input: DecisionInput,
    stamp: WriteAt<'_>,
    task: Option<DecisionTarget>,
) -> Result<Decision, StoreError> {
    let mut ids = BTreeSet::new();
    if input.question.trim().is_empty()
        || input.options.len() < 2
        || !input.options.iter().all(|option| {
            valid_key(&option.id) && !option.label.trim().is_empty() && ids.insert(&option.id)
        })
    {
        return Err(StoreError::PlanningInput);
    }
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
    if load(connection, &target.task_id)?.is_some_and(|row| {
        row.version == target.task_version
            && row.task.operator_question().is_some()
            && row.task.operator_decline().is_none()
    }) {
        Ok(())
    } else {
        Err(StoreError::PlanningConflict)
    }
}
