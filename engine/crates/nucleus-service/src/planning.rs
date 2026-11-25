use nucleus_core::{
    Authority, Entry, Head, Identity, PullRequest, Task, WaitReason,
    profiles::{BriefPolicy, Complexity, UsageLevel},
};
use nucleus_forge::Branches;
use nucleus_store::{
    StoreError, TaskAdmissionFacts, TaskRow,
    planning::{
        Decision, DecisionAnswerInput, DecisionInput, DecisionKind, ItemKind, ItemSource,
        ItemState, USAGE_APPROVE, UsagePermission, WriteAt, valid_key,
    },
};
use serde::Deserialize;
use tokio::sync::MutexGuard;

use crate::enrollment::PlanningRepository;
use crate::{
    ControllerScope, Service, ServiceError, State, check_brief_size, event, now_ms,
    profiles::usage, schedule::Priority,
};

fn admission_wait(blocked: bool, permission: bool) -> Option<WaitReason> {
    if blocked {
        Some(WaitReason::Prerequisite)
    } else {
        permission.then_some(WaitReason::UsagePermission)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskAdmission {
    pub id: Option<String>,
    pub reference: Option<String>,
    pub repository: Option<String>,
    pub brief: String,
    pub review: Option<PullRequest>,
    #[serde(rename = "planningCommit")]
    pub planning_commit: Option<Head>,
}

impl State {
    pub(super) fn has_open_usage_decision(&self, task: &Task) -> Result<bool, ServiceError> {
        Ok(usage(self) == UsageLevel::Low
            && self
                .store
                .usage_permission(&task.identity().id)?
                .is_some_and(|decision| !decision.withdrawn && decision.answer.is_none()))
    }
}

impl Service {
    pub(crate) async fn planning_state_in_scope(
        &self,
        selector: Option<&str>,
        scope: &ControllerScope,
    ) -> Result<(MutexGuard<'_, State>, String), ServiceError> {
        self.storage.database().verify()?;
        let mut state = self.state.lock().await;
        let project = if let Some(actor) = scope.actor() {
            self.planning_planner_project(&mut state, actor, selector)?
        } else {
            let selector = selector.ok_or(ServiceError::Project)?;
            state
                .settings
                .resolve_planning_project(self.project.as_ref(), selector)
                .ok_or(ServiceError::Project)?
                .to_owned()
        };
        Ok((state, project))
    }

    pub(crate) async fn add_planned_task(
        &self,
        project: Option<&str>,
        input: TaskAdmission,
        caller: &Authority,
        scope: &ControllerScope,
    ) -> Result<TaskRow, ServiceError> {
        let policy = check_brief(&input.brief)?;
        self.storage.database().verify()?;
        let _projects = self.project_writes.read().await;
        let mut state = self.state.lock().await;
        let route =
            self.planning_repository(&mut state, scope, project, input.repository.as_deref())?;
        let id = match input.id {
            Some(id) => id,
            None => new_id("t")?,
        };
        let reference = input.reference.unwrap_or_else(|| id.clone());
        let identity = admission_identity(id, reference, input.review.as_ref(), caller, &route)?;
        let lane = delivery_lane(&policy, &[])?;
        if let Some(lane) = &lane {
            if input.review.is_some() {
                return Err(ServiceError::ReportInput(
                    "a report-only task cannot enter through a pull request".into(),
                ));
            }
            require_report_lanes(&state, &route, &policy, &[], lane)?;
        } else if input.planning_commit.is_some() {
            return Err(ServiceError::ReportInput(
                "planningCommit is supported for report-only tasks".into(),
            ));
        }
        drop(state);
        let task = if let Some(lane) = &lane {
            let head = self
                .capture_report_base(&identity, input.planning_commit.as_ref())
                .await?;
            Task::new_report_only(
                identity,
                input.brief,
                route.project_id.clone(),
                lane.clone(),
                head,
            )
        } else {
            Task::new(identity, input.brief, input.review)
        };
        let affected_tests = self.affected_tests(&task, route.checkout.clone()).await;
        let mut state = self.state.lock().await;
        if self.planning_repository(&mut state, scope, project, input.repository.as_deref())?
            != route
        {
            return Err(ServiceError::Project);
        }
        if let Some(lane) = &lane {
            require_report_lanes(&state, &route, &policy, &[], lane)?;
        }
        let permission = usage_permission(&state, &route.project_id, &policy);
        let requested_permission = permission.is_some();
        let mut admitted = event("admitted");
        admitted.detail = stamp(caller).actor.into();
        let (prerequisites, blocked) =
            self.resolve_dependencies(&state, task.identity(), &policy.depends_on, scope)?;
        let facts = TaskAdmissionFacts {
            prerequisites: &prerequisites,
            usage_permission: permission,
            affected_tests,
        };
        let number = state.store.create_with_facts(&task, &admitted, facts)?;
        let wait = admission_wait(blocked, requested_permission);
        state.apply_task_wait(&task, wait, true);
        if wait.is_none() && task.first_launch() {
            state.enqueue_capacity(&task.identity().id)?;
        }
        if requested_permission {
            self.decision_changed();
        }
        self.wake_task(&mut state, &task.identity().id, 1, Priority::Wake);
        Ok(TaskRow {
            task,
            version: 1,
            number: Some(number),
        })
    }

    pub(crate) async fn promote_planning_item(
        &self,
        project: Option<&str>,
        id: &str,
        complexity: Option<Complexity>,
        caller: &Authority,
        scope: &ControllerScope,
    ) -> Result<(bool, TaskRow), ServiceError> {
        self.storage.database().verify()?;
        let _projects = self.project_writes.read().await;
        let mut state = self.state.lock().await;
        let route = self.planning_repository(&mut state, scope, project, None)?;
        let item = state
            .store
            .item(&route.project_id, id)?
            .ok_or(StoreError::PlanningMissing)?;
        let source = ItemSource {
            project_id: route.project_id.clone(),
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
        let brief = match complexity {
            Some(_) if item.kind == ItemKind::Lead => return Err(ServiceError::LeadComplexity),
            Some(complexity) => BriefPolicy::with_complexity(&item.content.body, complexity)?,
            None => item.content.body.clone(),
        };
        let policy = check_brief(&brief)?;
        let task_id = new_id("t")?;
        let identity = admission_identity(task_id.clone(), task_id, None, caller, &route)?;
        let attached = &item.content.lanes;
        let lane = delivery_lane(&policy, attached)?;
        if let Some(lane) = &lane {
            require_report_lanes(&state, &route, &policy, attached, lane)?;
        }
        drop(state);
        let task = if let Some(lane) = &lane {
            let head = self.capture_report_base(&identity, None).await?;
            Task::new_report_only(
                identity,
                brief,
                route.project_id.clone(),
                lane.clone(),
                head,
            )
        } else {
            Task::new(identity, brief, None)
        };
        let affected_tests = self.affected_tests(&task, route.checkout.clone()).await;
        let mut state = self.state.lock().await;
        if self.planning_repository(&mut state, scope, project, None)? != route {
            return Err(ServiceError::Project);
        }
        if state.store.item(&route.project_id, id)?.as_ref() != Some(&item) {
            return Err(StoreError::PlanningConflict.into());
        }
        if let Some(lane) = &lane {
            require_report_lanes(&state, &route, &policy, attached, lane)?;
        }
        let permission = usage_permission(&state, &route.project_id, &policy);
        let requested_permission = permission.is_some();
        let mut admitted = event("admitted");
        admitted.detail = serde_json::to_string(&source).map_err(StoreError::from)?;
        let (prerequisites, blocked) =
            self.resolve_dependencies(&state, task.identity(), &policy.depends_on, scope)?;
        let facts = TaskAdmissionFacts {
            prerequisites: &prerequisites,
            usage_permission: permission,
            affected_tests,
        };
        let (_, number) = state.store.promote_item_with_facts(
            &source,
            &item.content.body,
            &task,
            &admitted,
            stamp(caller),
            facts,
        )?;
        let wait = admission_wait(blocked, requested_permission);
        state.apply_task_wait(&task, wait, true);
        if wait.is_none() && task.first_launch() {
            state.enqueue_capacity(&task.identity().id)?;
        }
        if requested_permission {
            self.decision_changed();
        }
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

    /// Read the same project decisions used by the operator Inbox.
    ///
    /// # Errors
    /// Returns an error if the project is unknown or its records cannot be read.
    pub async fn decisions(
        &self,
        project: &str,
        pending: bool,
    ) -> Result<Vec<Decision>, ServiceError> {
        let (state, project) = self
            .planning_state_in_scope(Some(project), &ControllerScope::default())
            .await?;
        Ok(state.store.decisions(&project, pending)?)
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
        self.add_decision_in_scope(Some(project), input, caller, &ControllerScope::default())
            .await
    }

    pub(crate) async fn add_decision_in_scope(
        &self,
        project: Option<&str>,
        input: DecisionInput,
        caller: &Authority,
        scope: &ControllerScope,
    ) -> Result<Decision, ServiceError> {
        let (mut state, project) = self.planning_state_in_scope(project, scope).await?;
        let decision = state
            .store
            .add_decision(&project, new_id("d")?, input, stamp(caller))?;
        self.decision_changed();
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
        let (mut state, project) = self
            .planning_state_in_scope(Some(project), &ControllerScope::default())
            .await?;
        self.record_decision_answer(&mut state, &project, id, input, caller)
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
        if let Some(decision) = state.store.decision(project, id)?
            && let Some(target) = decision.task.as_ref()
            && target.kind == DecisionKind::UsagePermission
        {
            let row = self.lookup(state, &target.task_id)?;
            if self
                .reconcile_usage_permission(state, &row.task, decision)?
                .is_none()
            {
                return Err(StoreError::PlanningConflict.into());
            }
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
        self.decision_changed();
        Ok(decision)
    }

    pub(super) fn usage_permission_wait(
        &self,
        state: &mut State,
        row: &TaskRow,
    ) -> Result<Option<WaitReason>, ServiceError> {
        let id = &row.task.identity().id;
        let Some(decision) = state
            .store
            .usage_permission(id)?
            .filter(|decision| !decision.withdrawn)
        else {
            return Ok(None);
        };
        if self.lookup(state, id)?.version != row.version {
            return Err(StoreError::StaleTask.into());
        }
        self.reconcile_usage_permission(state, &row.task, decision)
    }

    fn reconcile_usage_permission(
        &self,
        state: &mut State,
        task: &Task,
        decision: Decision,
    ) -> Result<Option<WaitReason>, ServiceError> {
        let Some(target) = decision.task.filter(|_| !decision.withdrawn) else {
            return Ok(None);
        };
        let level = usage(state);
        let needed = !task.phase().is_terminal()
            && level == UsageLevel::Low
            && gated_complexity(BriefPolicy::parse(&task.brief().text)?.complexity).is_some();
        if !needed {
            state.store.withdraw_task_decision(
                &decision.project_id,
                &target,
                WriteAt {
                    actor: "Nucleus",
                    at_ms: now_ms(),
                },
            )?;
            self.decision_changed();
            return Ok(None);
        }
        Ok(decision
            .answer
            .as_ref()
            .is_none_or(|answer| answer.input.option_id != USAGE_APPROVE)
            .then_some(WaitReason::UsagePermission))
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

fn check_brief(brief: &str) -> Result<BriefPolicy, ServiceError> {
    check_brief_size(brief.len())?;
    if brief.trim().is_empty() {
        return Err(ServiceError::Input);
    }
    let policy = BriefPolicy::parse(brief)?;
    if policy.complexity.is_none() {
        return Err(ServiceError::ComplexityRequired);
    }
    if policy.report_only == Some(true)
        && !brief
            .lines()
            .skip(1)
            .skip_while(|line| *line != "---")
            .skip(1)
            .any(|line| !line.trim().is_empty())
    {
        return Err(ServiceError::ReportInput(
            "report-only brief body is empty".into(),
        ));
    }
    Ok(policy)
}

fn admission_identity(
    id: String,
    reference: String,
    review: Option<&PullRequest>,
    caller: &Authority,
    route: &PlanningRepository,
) -> Result<Identity, ServiceError> {
    crate::project::check_task_id(&id)?;
    if reference.trim().is_empty() {
        return Err(ServiceError::Input);
    }
    if let Some(pr) = review {
        Branches::for_review_entry(&route.repository, &route.base)?
            .target(&pr.url)
            .map_err(|_| ServiceError::Input)?;
    }
    Ok(Identity {
        id,
        reference,
        repository: route.repository.clone(),
        base: route.base.clone(),
        entry: if review.is_some() {
            Entry::ReviewEntry
        } else {
            Entry::Brief
        },
        origin_thread: match caller {
            Authority::Planner { actor } => Some(actor.clone()),
            Authority::Operator { .. } => None,
        },
    })
}

fn delivery_lane(
    policy: &BriefPolicy,
    attached: &[String],
) -> Result<Option<String>, ServiceError> {
    if policy.report_only != Some(true) {
        return Ok(None);
    }
    if let Some(lane) = &policy.report_lane {
        return Ok(Some(lane.clone()));
    }
    let lanes: std::collections::BTreeSet<_> = policy.lanes().iter().chain(attached).collect();
    if lanes.is_empty() {
        return Err(ServiceError::ReportInput(
            "queue.reportOnly requires an attached lane".into(),
        ));
    }
    if lanes.len() > 1 {
        return Err(ServiceError::ReportInput("multiple lanes are attached; choose one with queue.reportLane and include it in queue.lanes".into()));
    }
    Ok(lanes.first().map(|lane| (*lane).clone()))
}

fn require_report_lanes(
    state: &State,
    route: &PlanningRepository,
    policy: &BriefPolicy,
    attached: &[String],
    delivery: &str,
) -> Result<(), ServiceError> {
    for lane in policy
        .lanes()
        .iter()
        .chain(attached)
        .map(String::as_str)
        .chain([delivery])
    {
        if !valid_key(lane) || state.store.lane(&route.project_id, lane)?.is_none() {
            return Err(ServiceError::ReportInput(format!(
                "report lane {lane} is not in the task's project"
            )));
        }
    }
    Ok(())
}

fn usage_permission<'a>(
    state: &State,
    project: &'a str,
    policy: &BriefPolicy,
) -> Option<UsagePermission<'a>> {
    if usage(state) != UsageLevel::Low {
        return None;
    }
    gated_complexity(policy.complexity).map(|complexity| UsagePermission {
        project,
        complexity,
        at_ms: now_ms(),
    })
}

fn gated_complexity(complexity: Option<Complexity>) -> Option<&'static str> {
    match complexity {
        Some(Complexity::High) => Some("high"),
        Some(Complexity::VeryHigh) => Some("very-high"),
        _ => None,
    }
}
