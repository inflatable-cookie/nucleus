use nucleus_core::{Authority, PullRequest, profiles::BriefPolicy};
use nucleus_store::{
    StoreError, TaskRow,
    planning::{
        Decision, DecisionAnswerInput, DecisionInput, ItemSource, ItemState, MAX_TEXT_BYTES,
        WriteAt, valid_key,
    },
};
use serde::Deserialize;
use tokio::sync::MutexGuard;

use crate::{Service, ServiceError, State, event, now_ms, schedule::Priority};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskAdmission {
    pub id: Option<String>,
    pub reference: Option<String>,
    pub brief: String,
    pub review: Option<PullRequest>,
}

impl Service {
    pub(crate) async fn planning_state(
        &self,
        project: &str,
    ) -> Result<MutexGuard<'_, State>, ServiceError> {
        self.storage.database().verify()?;
        let state = self.state.lock().await;
        if !valid_key(project)
            || !state
                .settings
                .knows_planning_project(&self.project, project)
        {
            return Err(ServiceError::Project);
        }
        Ok(state)
    }

    pub(crate) async fn add_planned_task(
        &self,
        project: &str,
        input: TaskAdmission,
        caller: &Authority,
    ) -> Result<TaskRow, ServiceError> {
        let mut state = self.planning_state(project).await?;
        self.check_planning_admission(&state, project)?;
        let id = match input.id {
            Some(id) => id,
            None => new_id("t")?,
        };
        let reference = input.reference.unwrap_or_else(|| id.clone());
        check_brief(&input.brief)?;
        let task = self.admission_task(id, reference, input.brief, input.review, caller)?;
        let mut admitted = event("admitted");
        admitted.detail = stamp(caller).actor.into();
        let number = state.store.create(&task, &admitted)?;
        self.wake_task(&mut state, &task.identity().id, 1, Priority::Wake);
        Ok(TaskRow {
            task,
            version: 1,
            number: Some(number),
        })
    }

    pub(crate) async fn promote_planning_item(
        &self,
        project: &str,
        id: &str,
        caller: &Authority,
    ) -> Result<(bool, TaskRow), ServiceError> {
        let mut state = self.planning_state(project).await?;
        self.check_planning_admission(&state, project)?;
        let item = state
            .store
            .item(project, id)?
            .ok_or(StoreError::PlanningMissing)?;
        let source = ItemSource {
            project_id: project.into(),
            item_id: id.into(),
        };
        if let ItemState::Promoted { task_id } = &item.state
            && state.store.task_source(task_id)?.as_ref() == Some(&source)
        {
            return Ok((false, self.lookup(&state, task_id)?));
        }
        if !matches!(item.state, ItemState::Open | ItemState::Parked { .. }) {
            return Err(StoreError::PlanningConflict.into());
        }
        let brief = item.content.body;
        check_brief(&brief)?;
        let task_id = new_id("t")?;
        let task = self.admission_task(task_id.clone(), task_id, brief, None, caller)?;
        let mut admitted = event("admitted");
        admitted.detail = serde_json::to_string(&source).map_err(StoreError::from)?;
        let (_, number) = state
            .store
            .promote_item(&source, &task, &admitted, stamp(caller))?;
        self.wake_task(&mut state, &task.identity().id, 1, Priority::Wake);
        Ok((
            true,
            TaskRow {
                task,
                version: 1,
                number: Some(number),
            },
        ))
    }

    fn check_planning_admission(&self, state: &State, project: &str) -> Result<(), ServiceError> {
        if state.settings.planning_project_id(&self.project) != project
            || state.settings.fixture_slots(&self.project).is_none()
        {
            return Err(ServiceError::Project);
        }
        Ok(())
    }

    /// Read the same project decisions used by the operator Inbox.
    ///
    /// # Errors
    /// Returns an error if the project is unknown or its records cannot be read.
    pub async fn decisions(
        &self,
        project: &str,
        pending: bool,
    ) -> Result<Vec<Decision>, ServiceError> {
        Ok(self
            .planning_state(project)
            .await?
            .store
            .decisions(project, pending)?)
    }

    /// Record an operator question attributed to the caller's binding.
    ///
    /// # Errors
    /// Returns an error for invalid input, unknown project, or database failure.
    pub async fn add_decision(
        &self,
        project: &str,
        input: DecisionInput,
        caller: &Authority,
    ) -> Result<Decision, ServiceError> {
        let mut state = self.planning_state(project).await?;
        let decision = state
            .store
            .add_decision(project, new_id("d")?, input, stamp(caller))?;
        self.inbox_changed();
        Ok(decision)
    }

    /// Record an operator's answer for consumption on the ordinary answer path.
    ///
    /// # Errors
    /// Returns an error if the caller is not the operator, the decision is obsolete,
    /// the option is unknown, or the write fails.
    pub async fn answer_decision(
        &self,
        project: &str,
        id: &str,
        input: DecisionAnswerInput,
        caller: &Authority,
    ) -> Result<Decision, ServiceError> {
        let mut state = self.planning_state(project).await?;
        self.record_decision_answer(&mut state, project, id, input, caller)
    }

    pub(super) fn record_decision_answer(
        &self,
        state: &mut State,
        project: &str,
        id: &str,
        input: DecisionAnswerInput,
        caller: &Authority,
    ) -> Result<Decision, ServiceError> {
        if !matches!(caller, Authority::Operator { .. }) {
            return Err(ServiceError::DecisionOperator);
        }
        let decision = state
            .store
            .answer_decision(project, id, input, stamp(caller))?;
        if let Some(target) = &decision.task {
            state.schedule.wake(
                &target.task_id,
                tokio::time::Instant::now(),
                Priority::Decision,
            );
            self.wake.notify_one();
        }
        self.inbox_changed();
        Ok(decision)
    }
}

pub(crate) fn stamp(caller: &Authority) -> WriteAt<'_> {
    let (Authority::Operator { actor } | Authority::Planner { actor }) = caller;
    WriteAt {
        actor,
        at_ms: now_ms(),
    }
}

pub(crate) fn new_id(prefix: &str) -> Result<String, ServiceError> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| std::io::Error::other("could not allocate a planning ID"))?;
    Ok(format!("{prefix}-{}", hex::encode(bytes)))
}

fn check_brief(brief: &str) -> Result<(), ServiceError> {
    if brief.len() > MAX_TEXT_BYTES {
        return Err(ServiceError::Input);
    }
    BriefPolicy::parse(brief).map_err(|_| ServiceError::Input)?;
    Ok(())
}
