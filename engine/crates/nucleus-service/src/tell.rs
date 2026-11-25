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
#[serde(untagged, deny_unknown_fields)]
pub(crate) enum TellTarget {
    One(String),
    Projects(Vec<String>),
    Reply { reply: String },
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
    handle: String,
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
    Refused,
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
                TellState::Refused => TellOutcome::Refused,
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
            TellTarget::Reply { .. } => None,
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
        let now = tell_clock();
        let direct_route = if let TellTarget::Reply { reply } = &input.to {
            let (project, thread) = state
                .store
                .tell_reply_route(reply, actor, now)?
                .ok_or(ServiceError::TellReply)?;
            Some((project, thread))
        } else {
            None
        };
        let key = format!(
            "{:x}",
            Sha256::digest(
                match &input.to {
                    TellTarget::Reply { reply } => serde_json::to_vec(&(actor, reply, text)),
                    _ => serde_json::to_vec(&(actor, &from, &selectors, text)),
                }
                .map_err(nucleus_store::StoreError::from)?
            )
        );

        if let Some(replay) = state.store.tell_replay(&key, now)? {
            return Ok(replay.into());
        }
        let (routed, unrouted, direct) = if let Some((project, thread)) = direct_route {
            (vec![project], Vec::new(), Some(thread))
        } else {
            let (routed, unrouted) = self.project_recipients(&mut state, selectors, actor)?;
            (routed, unrouted, None)
        };
        let recipients = routed
            .into_iter()
            .map(|project| Ok((project, new_id("tell")?)))
            .collect::<Result<Vec<_>, ServiceError>>()?;
        let no_live_planners: Vec<_> = unrouted
            .into_iter()
            .map(|id| TellProject {
                name: project_name(&state, &id).into(),
                id,
            })
            .collect();
        let rows = state.store.record_tell(
            &TellSubmission {
                key: &key,
                sender: actor,
                direct: direct.as_deref(),
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

    fn project_recipients(
        &self,
        state: &mut State,
        selectors: Option<BTreeSet<&str>>,
        actor: &str,
    ) -> Result<(Vec<String>, Vec<String>), ServiceError> {
        let (routed, unrouted): (Vec<_>, Vec<_>) = tell_projects(state, selectors)?
            .into_iter()
            .map(str::to_owned)
            .partition(|project| tell_planner(state, project, actor, None).is_some());
        // A stored route whose process-local proof expired is still a candidate.
        // Ask the enrollment worker before freezing the broadcast's recipient set.
        let candidates: BTreeSet<_> = unrouted
            .iter()
            .flat_map(|id| state.planner_candidates_for(id))
            .filter(|candidate| candidate != actor)
            .collect();
        let mut pending = None;
        for candidate in candidates {
            if let Some(wait) = self.request_tell_enrollment(state, &candidate) {
                pending = Some(wait);
            }
        }
        if let Some(wait) = pending {
            return Err(wait);
        }
        Ok((routed, unrouted))
    }

    pub(crate) async fn claim_planner(&self, scope: &ControllerScope) -> Result<(), ServiceError> {
        let actor = scope.actor().ok_or(ServiceError::TellPlannerRequired)?;
        let _write = self.project_writes.write().await;
        let mut state = self.state.lock().await;
        let project = self.planning_planner_project(&mut state, actor, None)?;
        self.record_claim_notice(&mut state, &project)?;
        let file = self.settings.clone();
        let claimed = actor.to_owned();
        let id = project.clone();
        let occurrence = new_id("claim")?;
        let saved = tokio::task::spawn_blocking(move || {
            let before = file.read::<nucleus_store::Projects>()?;
            file.edit(
                &before.revision,
                |projects: &mut nucleus_store::Projects| {
                    let entry = projects
                        .projects
                        .get_mut(&id)
                        .filter(|p| {
                            !p.archived
                                && p.repositories
                                    .iter()
                                    .any(|repo| repo.planner_threads.contains(&claimed))
                        })
                        .ok_or(nucleus_store::StorageError::SettingsConflict)?;
                    if entry
                        .planner_claim
                        .as_ref()
                        .is_none_or(|claim| claim.thread != claimed)
                    {
                        entry.planner_claim = Some(nucleus_store::PlannerClaim {
                            thread: claimed,
                            occurrence,
                            replaced: entry.planner_claim.take().map(|claim| claim.thread),
                        });
                    }
                    Ok(())
                },
            )
        })
        .await
        .map_err(|_| ServiceError::Input)??;
        state.settings.projects = Some(saved.0.value);
        if saved.1 {
            self.settings_changes.send_replace(());
            self.tell_wake.notify_one();
        }
        self.record_claim_notice(&mut state, &project)
    }

    fn record_claim_notice(&self, state: &mut State, project: &str) -> Result<(), ServiceError> {
        let Some(claim) = state
            .settings
            .projects
            .as_ref()
            .and_then(|s| s.projects.get(project))
            .and_then(|p| p.planner_claim.as_ref())
        else {
            return Ok(());
        };
        let Some(previous) = &claim.replaced else {
            return Ok(());
        };
        if !state.store.has_tell_request(&claim.occurrence)? {
            let submission = TellSubmission {
                key: &claim.occurrence,
                sender: &claim.thread,
                direct: Some(previous),
                from_project: project,
                text: "Another thread claimed this project. New project messages go to that planner.",
                recorded_at: tell_clock(),
                no_live_planners: &[],
            };
            state
                .store
                .record_tell(&submission, &[(project.to_owned(), new_id("tell")?)])?;
            self.tell_wake.notify_one();
        }
        Ok(())
    }

    pub(crate) fn recover_claim_notices(&self, state: &mut State) -> Result<(), ServiceError> {
        let projects: Vec<_> = state
            .settings
            .projects
            .iter()
            .flat_map(|all| all.projects.iter())
            .filter(|(_, p)| {
                p.planner_claim
                    .as_ref()
                    .is_some_and(|claim| claim.replaced.is_some())
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in projects {
            self.record_claim_notice(state, &id)?;
        }
        Ok(())
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
            let next = {
                let mut state = self.state.lock().await;
                self.recover_claim_notices(&mut state)?;
                state.store.next_tell()?
            };
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
            TellState::Refused | TellState::Delivered { .. } => Err(ServiceError::Input),
        }
    }

    async fn resolve_tell(&self, row: &TellDelivery) -> Result<Option<PlannedTell>, ServiceError> {
        let candidates = if let Some(target) = &row.direct {
            let state = self.state.lock().await;
            if state
                .settings
                .planner_route(target)
                .is_none_or(|(project, _)| project != row.to_project)
            {
                return Ok(None);
            }
            vec![target.clone()]
        } else {
            let state = self.state.lock().await;
            let mut choices = state.planner_candidates_for(&row.to_project);
            choices.sort_by_key(|thread| {
                Some(thread.as_str()) != claimed_thread(&state, &row.to_project)
            });
            choices
        };
        for actor in candidates
            .into_iter()
            .filter(|actor| actor != &row.sender && Some(actor) != row.gone_sender.as_ref())
        {
            if self.check_registered_planner(&actor).await? {
                break;
            }
        }
        let state = self.state.lock().await;
        // Losing the in-memory proof while a binding still exists requires another observation.
        if let Some(thread) = &row.direct
            && state
                .settings
                .planner_route(thread)
                .is_some_and(|(id, _)| id == row.to_project)
            && target_planner(&state, row).is_none()
        {
            return Err(HostError::Uncertain.into());
        }
        target_planner(&state, row)
            .map(|proof| Self::plan_tell(&state, row, proof))
            .transpose()
    }

    async fn send_tell(&self, row: &TellDelivery) -> Result<(), ServiceError> {
        let Some(PlannedTell {
            planner,
            ids,
            text,
            handle,
            prior,
        }) = self.resolve_tell(row).await?
        else {
            return self.unavailable_tell(row).await;
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
            return self.unavailable_tell(row).await;
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
        let saved = self
            .save_tell(
                rows,
                TellDispatch::Send {
                    notice: attempt.clone(),
                    handle,
                },
            )
            .await;
        if matches!(
            saved,
            Err(ServiceError::Store(
                nucleus_store::StoreError::TellRateLimit(_)
            ))
        ) {
            return Ok(());
        }
        saved?;
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

    async fn unavailable_tell(&self, row: &TellDelivery) -> Result<(), ServiceError> {
        if row.direct.is_some() && !row.request_key.starts_with("claim-") {
            self.storage.database().verify()?;
            self.state.lock().await.store.fallback_reply(&row.id)?;
            return Ok(());
        }
        let outcome = if row.direct.is_some() {
            TellDispatch::Advance(TellState::Refused)
        } else {
            TellDispatch::Defer
        };
        self.save_tell(tell_rows(row), outcome).await
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
                        target_planner(state, target).map(|proof| proof.identity.id.as_str()),
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
        let handle = new_id("nreply")?.replacen('-', "_", 1);
        let fallback = members.iter().any(|member| {
            member.direct.is_none()
                && claimed_thread(state, &member.to_project) != Some(&planner.identity.id)
        });
        let text = notice_text(
            &row.from_project,
            &names,
            &row.text,
            &handle,
            fallback,
            row.gone_sender.as_deref(),
        );
        Ok(PlannedTell {
            handle,
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
            if (matches!(row.state, TellState::Pending)
                && target_planner(&state, row)
                    .is_none_or(|planner| planner.identity.id != target.thread))
                || target.thread == row.sender
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

fn target_planner<'a>(state: &'a State, row: &TellDelivery) -> Option<&'a EnrolledPlanner> {
    if let Some(thread) = &row.direct {
        return state
            .enrolled_planners
            .get(thread)
            .filter(|_| state.live_planner_project(thread) == Some(&row.to_project));
    }
    tell_planner(
        state,
        &row.to_project,
        &row.sender,
        row.gone_sender.as_deref(),
    )
}

fn claimed_thread<'a>(state: &'a State, project: &str) -> Option<&'a str> {
    state
        .settings
        .projects
        .as_ref()?
        .projects
        .get(project)?
        .planner_claim
        .as_ref()
        .map(|claim| claim.thread.as_str())
}

fn tell_planner<'a>(
    state: &'a State,
    project: &str,
    sender: &str,
    gone: Option<&str>,
) -> Option<&'a EnrolledPlanner> {
    state
        .enrolled_planners
        .values()
        .filter(|proof| {
            proof.identity.id != sender
                && Some(proof.identity.id.as_str()) != gone
                && state.live_planner_project(&proof.identity.id) == Some(project)
        })
        .max_by_key(|proof| {
            (
                claimed_thread(state, project) == Some(&proof.identity.id),
                proof.verified_at,
                proof.identity.id.as_str(),
            )
        })
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

fn notice_text(
    from: &str,
    project_names: &[&str],
    text: &str,
    handle: &str,
    fallback: bool,
    gone: Option<&str>,
) -> String {
    let routing = if let Some(sender) = gone {
        format!(
            "\nFallback delivery. The original sender ({sender}) is gone from this project. This reply goes to its project planner.\n"
        )
    } else if fallback {
        "\nFallback delivery. Use nucleus planner.claim to receive project messages, or pass this on.\n".into()
    } else {
        String::new()
    };
    let recipients = if project_names.len() > 1 {
        format!(" for {}", project_names.join(", "))
    } else {
        String::new()
    };
    format!(
        "Nucleus message from project {from}{recipients}\n\n{text}\n{routing}\nInformation only. Only this thread can use the reply route for seven days. It reaches the sender, or their project planner if the sender is gone.\nReply: nucleus tell '{{\"to\":{{\"reply\":\"{handle}\"}}}}' 'YOUR MESSAGE'"
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
            .map(|(thread, names)| {
                (
                    thread,
                    notice_text(
                        "sender",
                        &names,
                        "One update",
                        "nreply_fixture",
                        false,
                        None,
                    ),
                )
            })
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
