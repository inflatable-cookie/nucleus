use std::fmt::Write as _;

use nucleus_core::{
    Authority, Entry, Head, Identity, PullRequest, Task, WaitReason,
    profiles::{BriefPolicy, Complexity, UsageLevel},
};
use nucleus_forge::Branches;
use nucleus_store::{
    StoreError, TaskAdmissionFacts, TaskRow, TellSubmission,
    planning::{
        Decision, DecisionAnswerInput, DecisionInput, DecisionKind, Item, ItemKind, ItemSource,
        ItemState, PromotionCheck, USAGE_APPROVE, UsagePermission, WriteAt, valid_key,
    },
};
use serde::Deserialize;
use tokio::sync::RwLockReadGuard;

use crate::diagnostics::StateGuard;
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

enum AdmissionSource<'a> {
    Direct,
    Item {
        source: &'a ItemSource,
        item: &'a Item,
        /// The item version the caller saw, checked inside the admission transaction.
        version: Option<i64>,
        /// Save the task brief as the item's body with the promotion (a lead's new level).
        rewrite: bool,
    },
}

/// A board or planner promotion: the destination, a complexity, and the version seen.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ItemPromotion<'a> {
    pub repository: Option<&'a str>,
    pub complexity: Option<Complexity>,
    pub version: Option<i64>,
}

struct Admission<'a> {
    project: Option<&'a str>,
    repository: Option<&'a str>,
    route: PlanningRepository,
    identity: Identity,
    brief: String,
    review: Option<PullRequest>,
    planning_commit: Option<Head>,
    policy: BriefPolicy,
    lane: Option<String>,
    source: AdmissionSource<'a>,
    caller: &'a Authority,
    scope: &'a ControllerScope,
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
    ) -> Result<(StateGuard<'_>, String), ServiceError> {
        self.storage.database().verify()?;
        scope
            .with_enrollment(|| async {
                let mut state = self.state.lock().await;
                let project = if let Some(actor) = scope.actor() {
                    self.planning_planner_project(&mut state, actor, selector)?
                } else {
                    let selector = selector.ok_or(ServiceError::Project)?;
                    state
                        .settings
                        .resolve_planning_project(self.project.as_ref(), selector)?
                        .to_owned()
                };
                Ok((state, project))
            })
            .await
    }

    async fn admission_route(
        &self,
        scope: &ControllerScope,
        project: Option<&str>,
        repository: Option<&str>,
    ) -> Result<(RwLockReadGuard<'_, ()>, StateGuard<'_>, PlanningRepository), ServiceError> {
        scope
            .with_enrollment(|| async {
                let projects = self.project_writes.read().await;
                let mut state = self.state.lock().await;
                let route = self.planning_repository(&mut state, scope, project, repository)?;
                Ok((projects, state, route))
            })
            .await
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
        let (_projects, state, route) = self
            .admission_route(scope, project, input.repository.as_deref())
            .await?;
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
        let (_, row) = self
            .publish_admission(Admission {
                project,
                repository: input.repository.as_deref(),
                route,
                identity,
                brief: input.brief,
                review: input.review,
                planning_commit: input.planning_commit,
                policy,
                lane,
                source: AdmissionSource::Direct,
                caller,
                scope,
            })
            .await?;
        Ok(row)
    }

    pub(crate) async fn promote_planning_item(
        &self,
        project: Option<&str>,
        id: &str,
        request: ItemPromotion<'_>,
        caller: &Authority,
        scope: &ControllerScope,
    ) -> Result<(bool, TaskRow), ServiceError> {
        let ItemPromotion {
            repository,
            complexity,
            version,
        } = request;
        self.storage.database().verify()?;
        let (_projects, state, route) = self.admission_route(scope, project, repository).await?;
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
        // A lead's body is its brief: a different level is written into it, and the item keeps
        // that brief when (and only when) the task is admitted. A papercut's body stays as filed.
        let declared = (item.kind == ItemKind::Lead)
            .then(|| BriefPolicy::parse(&item.content.body).ok())
            .flatten()
            .and_then(|policy| policy.complexity);
        let rewrite = item.kind == ItemKind::Lead
            && complexity.is_some_and(|complexity| declared != Some(complexity));
        let brief = match complexity {
            Some(complexity) if item.kind == ItemKind::Papercut || rewrite => {
                BriefPolicy::with_complexity(&item.content.body, complexity)?
            }
            _ => item.content.body.clone(),
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
        self.publish_admission(Admission {
            project,
            repository,
            route,
            identity,
            brief,
            review: None,
            planning_commit: None,
            policy,
            lane,
            source: AdmissionSource::Item {
                source: &source,
                item: &item,
                version,
                rewrite,
            },
            caller,
            scope,
        })
        .await
    }

    async fn publish_admission(
        &self,
        admission: Admission<'_>,
    ) -> Result<(bool, TaskRow), ServiceError> {
        let Admission {
            project,
            repository,
            route,
            identity,
            brief,
            review,
            planning_commit,
            policy,
            lane,
            source,
            caller,
            scope,
        } = admission;
        let task = if let Some(lane) = &lane {
            let head = self
                .capture_report_base(&identity, planning_commit.as_ref())
                .await?;
            Task::new_report_only(
                identity,
                brief,
                route.project_id.clone(),
                lane.clone(),
                head,
            )
        } else {
            admitted_code_task(identity, brief, review, &policy, caller)?
        };
        let affected_tests = self.affected_tests(&task, route.checkout.clone()).await;
        let mut state = self.state.lock().await;
        if self.planning_repository(&mut state, scope, project, repository)? != route {
            return Err(ServiceError::Project);
        }
        let attached = match &source {
            AdmissionSource::Direct => &[][..],
            AdmissionSource::Item { source, item, .. } => {
                if let Some(row) = self.existing_promotion(&state, source, item)? {
                    return Ok((false, row));
                }
                &item.content.lanes
            }
        };
        if let Some(lane) = &lane {
            require_report_lanes(&state, &route, &policy, attached, lane)?;
        }
        let permission = usage_permission(&state, &route.project_id, &policy);
        let requested_permission = permission.is_some();
        let mut admitted = event("admitted");
        admitted.detail = match &source {
            AdmissionSource::Direct => stamp(caller).actor.into(),
            AdmissionSource::Item { source, .. } => {
                serde_json::to_string(source).map_err(StoreError::from)?
            }
        };
        let (prerequisites, blocked) =
            self.resolve_dependencies(&state, task.identity(), &policy.depends_on, scope)?;
        let facts = TaskAdmissionFacts {
            prerequisites: &prerequisites,
            usage_permission: permission,
            affected_tests,
        };
        let number = match source {
            AdmissionSource::Direct => state.store.create_with_facts(&task, &admitted, facts)?,
            AdmissionSource::Item {
                source,
                item,
                version,
                rewrite,
            } => {
                let check = PromotionCheck {
                    body: &item.content.body,
                    version,
                    source_body: rewrite.then_some(task.brief().text.as_str()),
                };
                state
                    .store
                    .promote_item_with_facts(source, check, &task, &admitted, stamp(caller), facts)?
                    .1
            }
        };
        let wait = admission_wait(blocked, requested_permission);
        state.apply_task_wait(&task, wait, true);
        if wait.is_none() && task.first_launch() {
            state.enqueue_capacity(&task)?;
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

    fn existing_promotion(
        &self,
        state: &State,
        source: &ItemSource,
        item: &Item,
    ) -> Result<Option<TaskRow>, ServiceError> {
        let current = state.store.item(&source.project_id, &source.item_id)?;
        if current.as_ref() == Some(item) {
            return Ok(None);
        }
        if let Some(Item {
            state: ItemState::Promoted { task_id },
            ..
        }) = current
            && state.store.task_source(&task_id)?.as_ref() == Some(source)
        {
            return Ok(Some(self.lookup(state, &task_id)?));
        }
        Err(StoreError::PlanningConflict.into())
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
        let stamp = stamp(caller);
        let prior = state.store.decision(project, id)?;
        if let Some(decision) = &prior
            && let Some(target) = decision.task.as_ref()
            && target.kind == DecisionKind::UsagePermission
        {
            let row = self.lookup(state, &target.task_id)?;
            if self
                .reconcile_usage_permission(state, &row.task, decision.clone())?
                .is_none()
            {
                return Err(StoreError::PlanningConflict.into());
            }
        }
        let notice = if let Some(decision) = &prior
            && let Some(thread) = self.decision_notice_target(state, decision)?
        {
            let text = decision_answer_text(decision, &input, stamp.at_ms);
            let key = new_id("decision")?;
            let tell_id = new_id("tell")?;
            let recorded_at = i64::try_from(stamp.at_ms).unwrap_or(i64::MAX);
            Some((thread, text, key, tell_id, recorded_at))
        } else {
            None
        };
        let (decision, queued) = {
            let from_project = prior
                .as_ref()
                .map_or(project, |decision| decision.project_id.as_str());
            let submission =
                notice
                    .as_ref()
                    .map(|(thread, text, key, _, recorded_at)| TellSubmission {
                        key,
                        sender: "Nucleus",
                        direct: Some(thread),
                        from_project,
                        text,
                        recorded_at: *recorded_at,
                        no_live_planners: &[],
                    });
            state.store.answer_decision_with_notice(
                project,
                id,
                input,
                stamp,
                submission.as_ref().zip(
                    notice
                        .as_ref()
                        .map(|(_, _, _, tell_id, _)| tell_id.as_str()),
                ),
            )?
        };
        if let Some(target) = &decision.task {
            state.schedule.wake(
                &target.task_id,
                tokio::time::Instant::now(),
                Priority::Decision,
            );
            self.wake.notify_one();
        }
        if queued {
            self.tell_wake.notify_one();
        }
        self.decision_changed();
        Ok(decision)
    }

    fn decision_notice_target(
        &self,
        state: &State,
        decision: &Decision,
    ) -> Result<Option<String>, ServiceError> {
        if decision.author == "Nucleus" {
            let Some(target) = &decision.task else {
                return Ok(None);
            };
            return Ok(self
                .lookup(state, &target.task_id)?
                .task
                .identity()
                .origin_thread
                .clone());
        }
        if decision.author == "operator"
            || decision.author == "fixture-operator"
            || decision.author.starts_with("operator via ")
        {
            return Ok(None);
        }
        Ok(Some(decision.author.clone()))
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

fn trimmed_note(note: Option<&str>) -> Option<&str> {
    note.map(str::trim).filter(|note| !note.is_empty())
}

fn truncate_chars(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let prefix: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn format_utc_minute(at_ms: u64) -> String {
    let total_minutes = i64::try_from(at_ms / 60_000).unwrap_or(i64::MAX);
    let days = total_minutes.div_euclid(1_440);
    let minute_of_day = total_minutes.rem_euclid(1_440);
    let (hour, minute) = (minute_of_day / 60, minute_of_day % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02} UTC")
}

fn decision_answer_text(
    decision: &Decision,
    input: &DecisionAnswerInput,
    answered_at_ms: u64,
) -> String {
    const MAX_QUESTION_CHARS: usize = 160;
    const MAX_NOTE_CHARS: usize = 2000;
    let option_id = &input.option_id;
    let label = decision
        .input
        .options
        .iter()
        .find(|option| option.id == *option_id)
        .map_or(option_id.as_str(), |option| option.label.trim());
    let collapsed: String = decision
        .input
        .question
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let question = truncate_chars(&collapsed, MAX_QUESTION_CHARS);
    let answered_at = format_utc_minute(answered_at_ms);
    let mut text = format!(
        "Decision {} answered at {answered_at}\n\nQuestion: {question}\nAnswer: {label} ({option_id})",
        decision.id
    );
    if let Some(note) = trimmed_note(input.note.as_deref()) {
        let note = truncate_chars(note, MAX_NOTE_CHARS);
        let _ = write!(text, "\nNote: {note}");
    }
    text
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
    let policy = BriefPolicy::submitted(brief)?;
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

fn admitted_code_task(
    identity: Identity,
    brief: String,
    review: Option<PullRequest>,
    policy: &BriefPolicy,
    caller: &Authority,
) -> Result<Task, ServiceError> {
    let mut task = Task::new(identity, brief, review);
    if let Some(reason) = policy.merge_hold_reason() {
        task.set_brief_merge_hold(Some(reason), caller, now_ms())?;
    }
    Ok(task)
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

#[cfg(test)]
mod tests {
    #[test]
    fn utc_minute_formatter_matches_calendar_timestamps() {
        assert_eq!(super::format_utc_minute(0), "1970-01-01 00:00 UTC");
        assert_eq!(
            super::format_utc_minute(1_795_693_620_000),
            "2026-11-26 11:47 UTC"
        );
    }
}
