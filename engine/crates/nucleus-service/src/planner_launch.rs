//! Starting a planner for an assessment with no planner to receive it (Spec 071, decision 7).

use std::path::Path;

use nucleus_hosts::{NoticeOutcome, PlannerIdentity, RegisteredProject, RepositoryProject, T3};
use nucleus_store::{
    ProjectSettings, Projects, TellDelivery, TellDispatch, TellState, planning::WriteAt,
};
use serde_json::Value;

use crate::{
    Service, ServiceError, State, enrollment::host_project_title, now_ms, planning::new_id,
    tell::tell_rows,
};

/// Why no planner can start yet.
enum Blocked {
    /// The cause can clear on its own, so the send is retried.
    Waiting(String),
    /// Only a change by the operator helps. Send again retries it.
    Stopped(String),
}

fn unsynchronized() -> Blocked {
    Blocked::Waiting("T3's project list hasn't arrived yet".into())
}

struct Target {
    host_project: String,
    root: String,
    title: String,
    model_selection: Value,
}

impl Service {
    pub(super) async fn launch_assess_planner(
        &self,
        row: &TellDelivery,
    ) -> Result<(), ServiceError> {
        let target = {
            let state = self.state.lock().await;
            if state
                .store
                .has_pending_planner_launch(&row.to_project, &row.id)?
            {
                Err(Blocked::Waiting(
                    "another message is already starting one".into(),
                ))
            } else {
                self.launch_target(&state, &row.to_project)
            }
        };
        let Target {
            host_project,
            root,
            title,
            model_selection,
        } = match target {
            Ok(target) => target,
            Err(Blocked::Waiting(cause)) => {
                self.record_launch_block(row, &cause).await?;
                return self.save_tell(tell_rows(row), TellDispatch::Defer).await;
            }
            Err(Blocked::Stopped(cause)) => {
                self.record_launch_block(row, &cause).await?;
                let stopped = TellDispatch::Advance(TellState::Refused);
                return self.save_tell(tell_rows(row), stopped).await;
            }
        };
        let thread = new_id("planner")?;
        let command = new_id("assess-launch")?;
        let attempt = T3::prepare_planner_launch(
            thread,
            &host_project,
            &title,
            &model_selection,
            command,
            &row.text,
        )?;
        self.save_tell(
            tell_rows(row),
            TellDispatch::Advance(TellState::InFlight(attempt.clone())),
        )
        .await?;
        let outcome = self
            .host
            .launch_planner_thread(&attempt, &host_project, &root)
            .await;
        let next = match outcome {
            Ok(NoticeOutcome::Accepted) => {
                let provider = model_selection["instanceId"].as_str().map(str::to_owned);
                if let Err(error) = self
                    .claim_launched_planner(
                        &row.to_project,
                        &host_project,
                        &attempt.thread,
                        provider,
                    )
                    .await
                {
                    self.record_launch_block(
                        row,
                        "T3 started the thread, but Nucleus couldn't claim it yet",
                    )
                    .await?;
                    return Err(error);
                }
                self.record_assess_outcome(row, None).await?;
                TellState::Accepted(attempt)
            }
            Ok(outcome) => {
                let cause = if matches!(outcome, NoticeOutcome::Rejected) {
                    "T3 rejected the new thread"
                } else {
                    "the new thread couldn't be sent to T3"
                };
                self.record_launch_block(row, cause).await?;
                TellState::Pending
            }
            Err(error) => {
                self.record_launch_block(row, "T3 hasn't confirmed the new thread")
                    .await?;
                return Err(error.into());
            }
        };
        self.save_tell(tell_rows(row), TellDispatch::Advance(next))
            .await
    }

    /// The T3 project and model for a new planner, from cached host state only.
    fn launch_target(&self, state: &State, project_id: &str) -> Result<Target, Blocked> {
        let (registry, project) = state
            .settings
            .projects
            .as_ref()
            .and_then(|all| Some((all, all.projects.get(project_id)?)))
            .filter(|(_, project)| !project.archived)
            .ok_or_else(|| Blocked::Stopped("the project is archived or gone".into()))?;
        if !self.host.projects_synchronized() {
            return Err(unsynchronized());
        }
        let bound: Vec<_> = project
            .repositories
            .iter()
            .filter_map(|repo| {
                let id = repo.host_project.as_deref()?;
                let native = self.host.cached_project(id).ok()?;
                (Path::new(&native.root) == repo.path).then(|| (id.to_owned(), native))
            })
            .collect();
        let with_default = bound
            .iter()
            .position(|(_, native)| native.default_model_selection.is_some());
        let (host_project, native) = bound
            .into_iter()
            .nth(with_default.unwrap_or(0))
            .map_or_else(|| self.unbound_target(registry, project), Ok)?;
        let model_selection = match native.default_model_selection {
            Some(selection) => selection,
            None => self.planner_model_selection(state)?,
        };
        Ok(Target {
            host_project,
            root: native.root,
            title: format!("{} planner", project.name),
            model_selection,
        })
    }

    /// The T3 project to bind when the engine project has no usable binding.
    fn unbound_target(
        &self,
        registry: &Projects,
        project: &ProjectSettings,
    ) -> Result<(String, RegisteredProject), Blocked> {
        if let Some(repo) = project
            .repositories
            .iter()
            .find(|repo| repo.host_project.is_some())
        {
            return Err(Blocked::Waiting(format!(
                "the T3 project bound to {} is gone or its folder changed",
                repo.origin
            )));
        }
        let primary = project
            .repositories
            .first()
            .ok_or_else(|| Blocked::Stopped("the project has no repository".into()))?;
        let origin = &primary.origin;
        let (id, native) = match self
            .host
            .cached_repository_project(origin, &primary.path)
            .map_err(|_| unsynchronized())?
        {
            RepositoryProject::Found(id, native) => (id, native),
            RepositoryProject::Unidentified => {
                return Err(Blocked::Waiting(format!(
                    "T3 hasn't identified the repository for {origin} yet"
                )));
            }
            RepositoryProject::Missing => {
                return Err(Blocked::Stopped(format!("no T3 project matches {origin}")));
            }
        };
        if registry
            .projects
            .values()
            .flat_map(|project| &project.repositories)
            .any(|repo| repo.host_project.as_deref() == Some(id.as_str()))
        {
            return Err(Blocked::Stopped(format!(
                "the T3 project for {origin} is bound to another repository"
            )));
        }
        Ok((id, native))
    }

    fn planner_model_selection(&self, state: &State) -> Result<Value, Blocked> {
        let choice = state
            .settings
            .dispatch
            .as_ref()
            .map(|dispatch| dispatch.planner_model.clone())
            .unwrap_or_default();
        let catalog = self
            .host
            .cached_profile_catalog()
            .ok_or_else(|| Blocked::Waiting("T3's model list hasn't arrived yet".into()))?;
        catalog
            .planner_selection(choice.provider, &choice.model, choice.effort)
            .ok_or_else(|| {
                Blocked::Waiting(format!(
                    "no ready T3 provider offers the planner model {} at its thinking level. Check Settings → Limits",
                    choice.model
                ))
            })
    }

    async fn record_launch_block(
        &self,
        row: &TellDelivery,
        cause: &str,
    ) -> Result<(), ServiceError> {
        let cause = format!("Can't start a planner: {cause}");
        self.record_assess_outcome(row, Some(&cause)).await
    }

    /// Show an assessment send's progress on its item. Other messages have no item.
    pub(super) async fn record_assess_outcome(
        &self,
        row: &TellDelivery,
        cause: Option<&str>,
    ) -> Result<(), ServiceError> {
        if !row.request_key.starts_with("assess-") {
            return Ok(());
        }
        self.storage.database().verify()?;
        let stamp = WriteAt {
            actor: "Nucleus",
            at_ms: now_ms(),
        };
        let changed = self
            .state
            .lock()
            .await
            .store
            .record_assess_outcome(row, cause, stamp)?;
        if let Some(item) = changed {
            service_log!(
                "item {item} in {}: {}",
                row.to_project,
                cause.unwrap_or("the planner has the message")
            );
            self.planning_changes.send_replace(());
        }
        Ok(())
    }

    /// Claim a launched planner, binding its T3 project to the repository it started in.
    pub(super) async fn claim_launched_planner(
        &self,
        project: &str,
        host_project: &str,
        thread: &str,
        provider_instance_id: Option<String>,
    ) -> Result<(), ServiceError> {
        let _write = self.project_writes.write().await;
        let file = self.settings.clone();
        let id = project.to_owned();
        let host = host_project.to_owned();
        let native = self.host.cached_project(host_project).ok();
        let claimed = thread.to_owned();
        let occurrence = new_id("claim")?;
        let saved = tokio::task::spawn_blocking(move || {
            let before = file.read::<Projects>()?;
            file.edit(&before.revision, |projects: &mut Projects| {
                let entry = projects
                    .projects
                    .get_mut(&id)
                    .filter(|p| !p.archived)
                    .ok_or(nucleus_store::StorageError::SettingsConflict)?;
                let repos = &entry.repositories;
                let index = repos
                    .iter()
                    .position(|repo| repo.host_project.as_deref() == Some(host.as_str()))
                    .or_else(|| {
                        let root = Path::new(&native.as_ref()?.root);
                        repos
                            .iter()
                            .position(|repo| repo.host_project.is_none() && repo.path == root)
                    })
                    .ok_or(nucleus_store::StorageError::SettingsConflict)?;
                let repo = &mut entry.repositories[index];
                if repo.host_project.is_none() {
                    repo.host_project = Some(host);
                    repo.host_project_title =
                        native.and_then(|native| host_project_title(native.title));
                }
                if !repo.planner_threads.contains(&claimed) {
                    repo.planner_threads.push(claimed.clone());
                }
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
            })
        })
        .await
        .map_err(|_| ServiceError::Input)??;
        let mut state = self.state.lock().await;
        state.settings.projects = Some(saved.0.value);
        state.enroll_launched_planner(PlannerIdentity::top_level(
            thread.to_owned(),
            host_project.to_owned(),
            provider_instance_id,
        ));
        if saved.1 {
            self.project_settings_changed(&mut state);
            self.tell_wake.notify_one();
        }
        Ok(())
    }
}
