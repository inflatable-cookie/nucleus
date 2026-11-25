use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::Duration,
};

use nucleus_core::QuestionDelivery;
use nucleus_hosts::{
    HostError, NoticeAuthorization, NoticeHost, NoticeSend, NoticeState, NoticeWrite, T3,
};
use nucleus_store::{
    StoredTell, TellDelivery, TellDispatch, TellProject, TellRows, TellState, TellSubmission,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ControllerScope, Service, ServiceError, State, enrollment::EnrolledPlanner, now_ms,
    planning::new_id, project::linked_checkout, web::ProjectMatchError,
};

const MAX_TEXT_CHARS: usize = 4000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TellRequest {
    pub(crate) to: TellTarget,
    pub(crate) text: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum TellTarget {
    One(String),
    Projects(Vec<String>),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TellReceipt {
    message_id: String,
    from_project: String,
    to: String,
    recorded_at_ms: i64,
    #[serde(flatten)]
    outcome: TellOutcome,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TellResponse {
    deliveries: Vec<TellReceipt>,
    no_live_planners: Vec<TellProject>,
}

impl From<StoredTell> for TellResponse {
    fn from(stored: StoredTell) -> Self {
        Self {
            deliveries: stored
                .deliveries
                .into_iter()
                .map(TellReceipt::from)
                .collect(),
            no_live_planners: stored.no_live_planners,
        }
    }
}

struct PlannedTell {
    planner: EnrolledPlanner,
    ids: Vec<String>,
    text: String,
    prior: Option<TellState>,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum TellOutcome {
    Queued,
    Uncertain { detail: &'static str },
    Delivered { delivered_at_ms: i64 },
}

impl From<TellDelivery> for TellReceipt {
    fn from(row: TellDelivery) -> Self {
        Self {
            message_id: row.id,
            from_project: row.from_project,
            to: row.to_project,
            recorded_at_ms: row.recorded_at,
            outcome: match row.state {
                TellState::Pending | TellState::Accepted(_) => TellOutcome::Queued,
                TellState::InFlight(_) => TellOutcome::Uncertain {
                    detail: "Delivery is unconfirmed. Nucleus will check the recorded attempt without resending it.",
                },
                TellState::Delivered { at_ms, .. } => TellOutcome::Delivered {
                    delivered_at_ms: at_ms,
                },
            },
        }
    }
}

impl Service {
    /// Queue information for project planners and return the durable receipts.
    /// Both admission and receipt lookup use the cached caller binding.
    pub(crate) async fn tell(
        &self,
        caller: &ControllerScope,
        input: &TellRequest,
    ) -> Result<TellResponse, ServiceError> {
        let actor = caller.actor().ok_or(ServiceError::TellPlannerRequired)?;
        let text = input.text.trim();
        if text.is_empty() || text.encode_utf16().count() > MAX_TEXT_CHARS {
            return Err(ServiceError::TellInput);
        }
        let selectors = match &input.to {
            TellTarget::One(project) if project.trim() == "all" => None,
            TellTarget::One(project) => Some(BTreeSet::from([project.trim()])),
            TellTarget::Projects(projects) => {
                Some(projects.iter().map(|name| name.trim()).collect())
            }
        };
        if selectors
            .as_ref()
            .is_some_and(|names| names.is_empty() || names.contains(""))
        {
            return Err(ServiceError::TellInput);
        }
        self.storage.database().verify()?;
        let mut state = self.state.lock().await;
        let from = match state.live_planner_project(actor) {
            Some(project) => project.to_owned(),
            None if state.settings.planner_route(actor).is_some() => {
                return Err(self.request_enrollment(&mut state, actor));
            }
            None => return Err(ServiceError::TellPlannerRequired),
        };
        let key = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(actor, &from, &selectors, text))
                    .map_err(nucleus_store::StoreError::from)?
            )
        );
        let now = tell_clock();
        if let Some(replay) = state.store.tell_replay(&key, now)? {
            return Ok(replay.into());
        }
        let projects = tell_projects(&state, selectors)?;
        let (groups, unrouted) = group_by_thread(projects.into_iter().map(|project| {
            (
                project,
                tell_planner(&state, project, actor).map(|planner| planner.identity.id.as_str()),
            )
        }));
        // A stored route whose process-local proof expired is still a candidate.
        // Ask the enrollment worker before freezing the broadcast's recipient set.
        let candidates: BTreeSet<_> = unrouted
            .iter()
            .flat_map(|id| state.planner_candidates_for(id))
            .filter(|candidate| candidate != actor)
            .collect();
        if !candidates.is_empty() {
            let mut pending = ServiceError::PlannerEnrollmentPending;
            for candidate in candidates {
                pending = self.request_enrollment(&mut state, &candidate);
            }
            return Err(pending);
        }
        let recipients = groups
            .into_values()
            .flatten()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|project| Ok((project.to_owned(), new_id("tell")?)))
            .collect::<Result<Vec<_>, ServiceError>>()?;
        let no_live_planners: Vec<_> = unrouted
            .into_iter()
            .map(|id| TellProject {
                id: id.into(),
                name: project_name(&state, id).into(),
            })
            .collect();
        let rows = state.store.record_tell(
            &TellSubmission {
                key: &key,
                sender: actor,
                from_project: &from,
                text,
                recorded_at: now,
                no_live_planners: &no_live_planners,
            },
            &recipients,
        )?;
        if !rows.is_empty() {
            self.tell_wake.notify_one();
        }
        Ok(StoredTell {
            deliveries: rows,
            no_live_planners,
        }
        .into())
    }

    pub(super) async fn watch_tells(&self) {
        loop {
            match self.wait_tell().await {
                Ok(row) => {
                    if self.advance_tell(&row).await.is_err()
                        && let Err(error) =
                            self.save_tell(tell_rows(&row), TellDispatch::Defer).await
                    {
                        eprintln!("project tell {}: {error}", row.id);
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
                Err(error) => {
                    eprintln!("project tell queue: {error}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    }

    async fn wait_tell(&self) -> Result<TellDelivery, ServiceError> {
        loop {
            self.host.wait_for_requests().await;
            self.storage.database().verify()?;
            let next = self.state.lock().await.store.next_tell()?;
            if let Some(row) = next {
                let delay = row
                    .retry_at
                    .unwrap_or_default()
                    .saturating_sub(tell_clock());
                let delay = u64::try_from(delay).unwrap_or_default();
                if delay == 0 {
                    return Ok(row);
                }
                tokio::select! {
                    () = self.tell_wake.notified() => {},
                    () = tokio::time::sleep(Duration::from_millis(delay)) => {},
                }
            } else {
                self.tell_wake.notified().await;
            }
        }
    }

    pub(super) async fn advance_tell(&self, row: &TellDelivery) -> Result<(), ServiceError> {
        match &row.state {
            TellState::Pending => self.send_tell(row).await,
            TellState::InFlight(attempt) | TellState::Accepted(attempt) => {
                let transition = self.reconcile_tell(row, attempt).await?;
                self.save_tell(tell_rows(row), transition).await
            }
            TellState::Delivered { .. } => Err(ServiceError::Input),
        }
    }

    async fn send_tell(&self, row: &TellDelivery) -> Result<(), ServiceError> {
        let candidates = self
            .state
            .lock()
            .await
            .planner_candidates_for(&row.to_project);
        for actor in candidates.into_iter().filter(|actor| actor != &row.sender) {
            if self.check_registered_planner(&actor).await? {
                break;
            }
        }
        let route = {
            let state = self.state.lock().await;
            tell_planner(&state, &row.to_project, &row.sender)
                .map(|proof| Self::plan_tell(&state, row, proof))
                .transpose()?
        };
        let Some(PlannedTell {
            planner,
            ids,
            text,
            prior,
        }) = route
        else {
            return self.save_tell(tell_rows(row), TellDispatch::Defer).await;
        };
        let ids: Vec<_> = ids.iter().map(String::as_str).collect();
        let rows = TellRows::Receipts(&ids);
        if let Some(prior) = prior {
            return self.save_tell(rows, TellDispatch::Advance(prior)).await;
        }

        let EnrolledPlanner {
            identity,
            verified_at,
            ..
        } = planner;
        let mut attempt = T3::prepare_notice(identity.id.clone(), new_id("tell-notice")?, &text)?;
        let observed = self.host.observe_notice(&attempt).await?;
        if observed.state == NoticeState::Gone
            || observed
                .authorization
                .as_ref()
                .is_some_and(|permit| !permit.matches_planner(&identity))
        {
            let mut state = self.state.lock().await;
            if state
                .enrolled_planners
                .get(&identity.id)
                .is_some_and(|proof| proof.verified_at == verified_at)
            {
                state.enrolled_planners.remove(&identity.id);
                self.planner_routes_changed(&mut state);
            }
            drop(state);
            return self.save_tell(rows, TellDispatch::Defer).await;
        }
        let Some(authorization) = observed.authorization else {
            return self.save_tell(rows, TellDispatch::Defer).await;
        };
        let _projects = self.project_writes.read().await;
        if !self.tell_notice_allowed(row, &authorization).await? {
            return self.save_tell(rows, TellDispatch::Defer).await;
        }
        if authorization.needs_unsettle() {
            self.host
                .deliver_notice(NoticeWrite::Prepare(&authorization))
                .await?;
            return self.save_tell(rows, TellDispatch::Defer).await;
        }
        let dispatch = authorization.record(&mut attempt)?;
        self.save_tell(
            rows,
            TellDispatch::Advance(TellState::InFlight(attempt.clone())),
        )
        .await?;
        let result = self.host.deliver_notice(NoticeWrite::Queue(dispatch)).await;
        if matches!(result, Err(HostError::Deferred { .. })) {
            return self
                .save_tell(rows, TellDispatch::Advance(TellState::Pending))
                .await;
        }
        let next = match result? {
            NoticeSend::Accepted => TellState::Accepted(attempt),
            NoticeSend::Rejected => TellState::Pending,
            NoticeSend::Prepared => return Err(HostError::Protocol.into()),
        };
        self.save_tell(rows, TellDispatch::Advance(next)).await
    }

    fn plan_tell(
        state: &State,
        row: &TellDelivery,
        planner: &EnrolledPlanner,
    ) -> Result<PlannedTell, ServiceError> {
        let batch = state.store.tell_batch(&row.request_key)?;
        let (groups, _) = group_by_thread(
            batch
                .iter()
                .filter(|target| {
                    matches!(target.state, TellState::Pending)
                        && target.request_key == row.request_key
                })
                .map(|target| {
                    (
                        target,
                        tell_planner(state, &target.to_project, &row.sender)
                            .map(|proof| proof.identity.id.as_str()),
                    )
                }),
        );
        let members = groups
            .get(planner.identity.id.as_str())
            .ok_or(ServiceError::Input)?;
        let names = members
            .iter()
            .map(|target| project_name(state, &target.to_project))
            .collect::<Vec<_>>();
        let ids = members.iter().map(|target| target.id.clone()).collect();
        let prior = batch
            .iter()
            .find(|target| target.state.thread() == Some(planner.identity.id.as_str()))
            .map(|target| target.state.clone());
        let text = notice_text(&row.from_project, &names, &row.text);
        Ok(PlannedTell {
            planner: planner.clone(),
            ids,
            text,
            prior,
        })
    }

    async fn reconcile_tell(
        &self,
        row: &TellDelivery,
        attempt: &QuestionDelivery,
    ) -> Result<TellDispatch, ServiceError> {
        let observed = self.host.observe_notice(attempt).await?;
        let next = match observed.state {
            NoticeState::Started => TellState::Delivered {
                at_ms: tell_clock(),
                thread: attempt.thread.clone(),
            },
            NoticeState::Undelivered => TellState::Pending,
            NoticeState::Queued => {
                if let Some(permit) = observed.authorization {
                    let _projects = self.project_writes.read().await;
                    if self.tell_notice_allowed(row, &permit).await? {
                        self.host
                            .deliver_notice(NoticeWrite::Prepare(&permit))
                            .await?;
                    }
                }
                if matches!(row.state, TellState::Accepted(_)) {
                    return Ok(TellDispatch::Defer);
                }
                TellState::Accepted(attempt.clone())
            }
            NoticeState::Gone if matches!(row.state, TellState::Accepted(_)) => {
                TellState::InFlight(attempt.clone())
            }
            NoticeState::Absent | NoticeState::Gone => {
                // Absence, including after restart, cannot disprove a recorded send.
                return Ok(TellDispatch::Defer);
            }
        };
        Ok(TellDispatch::Advance(next))
    }

    async fn tell_notice_allowed(
        &self,
        row: &TellDelivery,
        authorization: &NoticeAuthorization,
    ) -> Result<bool, ServiceError> {
        let target = authorization.target();
        let root = {
            let state = self.state.lock().await;
            let Some((project, repo)) = state.live_planner_route(&target.thread) else {
                return Ok(false);
            };
            if target.thread == row.sender
                || project != row.to_project
                || repo.host_project.as_deref() != Some(target.project_id.as_str())
                || !state
                    .enrolled_planners
                    .get(&target.thread)
                    .is_some_and(|proof| authorization.matches_planner(&proof.identity))
                || !self
                    .host
                    .cached_project(&target.project_id)
                    .is_ok_and(|native| Path::new(&native.root) == repo.path)
            {
                return Ok(false);
            }
            repo.path.clone()
        };
        if let Some(path) = &target.worktree_path {
            return Ok(linked_checkout(&root, Path::new(path), &self.git)?);
        }
        Ok(true)
    }

    async fn save_tell(
        &self,
        rows: TellRows<'_>,
        transition: TellDispatch,
    ) -> Result<(), ServiceError> {
        self.storage.database().verify()?;
        self.state
            .lock()
            .await
            .store
            .settle_tells(rows, transition, tell_clock())?;
        Ok(())
    }
}

fn tell_rows(row: &TellDelivery) -> TellRows<'_> {
    row.state
        .attempt()
        .map_or(TellRows::Receipt(&row.id), |attempt| {
            TellRows::Attempt(&attempt.command)
        })
}

fn tell_planner<'a>(state: &'a State, project: &str, sender: &str) -> Option<&'a EnrolledPlanner> {
    state
        .enrolled_planners
        .values()
        .filter(|proof| {
            proof.identity.id != sender
                && state.live_planner_project(&proof.identity.id) == Some(project)
        })
        .max_by_key(|proof| (proof.verified_at, proof.identity.id.as_str()))
}

fn group_by_thread<'a, Project>(
    routes: impl IntoIterator<Item = (Project, Option<&'a str>)>,
) -> (BTreeMap<&'a str, Vec<Project>>, Vec<Project>) {
    let mut grouped = BTreeMap::<_, Vec<_>>::new();
    let mut unrouted = Vec::new();
    for (project, thread) in routes {
        if let Some(thread) = thread {
            grouped.entry(thread).or_default().push(project);
        } else {
            unrouted.push(project);
        }
    }
    (grouped, unrouted)
}

fn project_name<'a>(state: &'a State, id: &'a str) -> &'a str {
    state
        .settings
        .projects
        .as_ref()
        .and_then(|projects| projects.projects.get(id))
        .map_or(id, |project| project.name.as_str())
}

fn notice_text(from: &str, project_names: &[&str], text: &str) -> String {
    let recipients = if project_names.len() > 1 {
        format!(" for {}", project_names.join(", "))
    } else {
        String::new()
    };
    format!(
        "Nucleus message from project {from}{recipients}\n\n{text}\n\nReply with a tell to project {from}. This message carries information only."
    )
}

fn tell_projects<'a>(
    state: &'a State,
    selectors: Option<BTreeSet<&str>>,
) -> Result<BTreeSet<&'a str>, ServiceError> {
    let registry = state
        .settings
        .projects
        .as_ref()
        .ok_or(ServiceError::TellPlannerRequired)?;
    let Some(selectors) = selectors else {
        return Ok(registry
            .projects
            .iter()
            .filter(|(_, project)| !project.archived)
            .map(|(id, _)| id.as_str())
            .collect());
    };
    selectors
        .into_iter()
        .map(|name| {
            let project = state
                .settings
                .match_planning_project(None, name)
                .map_err(|error| match error {
                    ProjectMatchError::Unknown => ServiceError::TellUnknownProject(name.into()),
                    ProjectMatchError::Ambiguous => ServiceError::TellAmbiguousProject(name.into()),
                })?;
            if registry
                .projects
                .get(project)
                .is_some_and(|project| project.archived)
            {
                return Err(ServiceError::TellArchivedProject(project.into()));
            }
            Ok(project)
        })
        .collect()
}

fn tell_clock() -> i64 {
    i64::try_from(now_ms()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::{group_by_thread, notice_text};

    #[test]
    fn project_tell_groups_several_projects_by_exact_recipient_thread() {
        let (groups, unrouted) = group_by_thread([
            ("Sample Alpha", Some("same-thread")),
            ("Sample Beta", Some("same-thread")),
            ("Sample Gamma", Some("same-thread")),
            ("Other", Some("other-thread")),
            ("Unbound", None),
        ]);
        assert_eq!(unrouted, ["Unbound"]);
        assert_eq!(groups.len(), 2);
        let notices: Vec<_> = groups
            .into_iter()
            .map(|(thread, names)| (thread, notice_text("sender", &names, "One update")))
            .collect();
        assert_eq!(notices[1].0, "same-thread");
        assert!(
            notices[1]
                .1
                .contains("for Sample Alpha, Sample Beta, Sample Gamma")
        );
        assert_eq!(notices[1].1.matches("One update").count(), 1);
    }
}
