use std::sync::Arc;

use axum::{
    Extension, Json,
    extract::{Path, State, rejection::JsonRejection},
};
use nucleus_core::{Authority, Role, Task};
use nucleus_store::{
    DispatchMode, DispatchSettings, EngineSettings, Hosts, Profiles, ProjectSettings, Projects,
    RepositorySettings, SettingsFile, SettingsSnapshot, SettingsValue, StorageError, StoreError,
    planning::ProjectRemoval,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::{task, time::Instant};

use super::{Api, ApiError, body};
use crate::{Project, Service, ServiceError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProviderPause {
    until_ms: u64,
}

pub(super) async fn pause_group(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    Path(group): Path<String>,
    input: Result<Json<ProviderPause>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    require_operator(&authority)?;
    let now = crate::now_ms();
    let pause = body(input)?;
    let mut state = api.service.state.lock().await;
    if pause.until_ms <= now
        || !state.settings.profiles.as_ref().is_some_and(|profiles| {
            profiles
                .profiles
                .iter()
                .any(|profile| profile.group.as_deref() == Some(group.as_str()))
        })
    {
        return Err(ApiError::Invalid);
    }
    let until_ms = api
        .service
        .record_subscription_pause(&state, &group, pause.until_ms, now)?;
    api.service.wake_settings_capacity(&mut state);
    Ok(Json(json!({"group":group, "untilMs":until_ms})))
}

pub(crate) struct RuntimeSettings {
    pub dispatch: Option<DispatchSettings>,
    pub profiles: Option<Arc<Profiles>>,
    pub(crate) projects: Option<Projects>,
    pub host: CachedHost,
}

pub(crate) enum ProjectMatchError {
    Unknown,
    Ambiguous,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CachedHost {
    Unknown,
    Reachable,
    Unavailable,
}

impl RuntimeSettings {
    pub(crate) fn planner_route(&self, actor: &str) -> Option<(&str, &RepositorySettings)> {
        self.projects
            .as_ref()?
            .projects
            .iter()
            .filter(|(_, project)| !project.archived)
            .find_map(|(id, project)| {
                project
                    .repositories
                    .iter()
                    .find(|repo| repo.planner_threads.iter().any(|thread| thread == actor))
                    .map(|repo| (id.as_str(), repo))
            })
    }

    pub(crate) fn open(file: &SettingsFile) -> Result<Self, StorageError> {
        let dispatch = file.read::<DispatchSettings>()?;
        let profiles = file.read::<Profiles>()?;
        let projects = file.read::<Projects>()?;
        Ok(Self {
            dispatch: dispatch.configured.then_some(dispatch.value),
            profiles: profiles.configured.then(|| Arc::new(profiles.value)),
            projects: projects.configured.then_some(projects.value),
            host: CachedHost::Unknown,
        })
    }

    pub(crate) fn fixture_project(
        &self,
        fixture: &Project,
    ) -> Option<(&str, &ProjectSettings, &RepositorySettings)> {
        self.projects
            .as_ref()?
            .projects
            .iter()
            .find_map(|(id, project)| {
                project
                    .repositories
                    .iter()
                    .find(|repo| {
                        repo.origin.eq_ignore_ascii_case(&fixture.repository)
                            && repo.path == fixture.checkout
                            && repo.base == fixture.base
                    })
                    .map(|repo| (id.as_str(), project, repo))
            })
    }

    pub(crate) fn project_for_origin(
        &self,
        origin: &str,
    ) -> Option<(&str, &ProjectSettings, &RepositorySettings)> {
        self.projects
            .as_ref()?
            .projects
            .iter()
            .find_map(|(id, project)| {
                project
                    .repositories
                    .iter()
                    .find(|repo| repo.origin.eq_ignore_ascii_case(origin))
                    .map(|repo| (id.as_str(), project, repo))
            })
    }

    pub(crate) fn repository(
        &self,
        project_id: &str,
        origin: &str,
    ) -> Result<&RepositorySettings, ServiceError> {
        self.project_for_origin(origin)
            .filter(|(id, project, repo)| {
                *id == project_id && !project.archived && repo.host_project.is_some()
            })
            .map(|(_, _, repo)| repo)
            .ok_or(ServiceError::Project)
    }

    pub(crate) const fn uses_project_registry(&self) -> bool {
        self.projects.is_some()
    }

    pub(crate) fn planning_project_id<'a>(&'a self, binding: &'a Project) -> &'a str {
        self.fixture_project(binding)
            .map_or(binding.host_project.as_str(), |(id, _, _)| id)
    }

    pub(crate) fn resolve_planning_project<'a>(
        &'a self,
        binding: Option<&'a Project>,
        selector: &str,
    ) -> Option<&'a str> {
        self.match_planning_project(binding, selector).ok()
    }

    pub(crate) fn match_planning_project<'a>(
        &'a self,
        binding: Option<&'a Project>,
        selector: &str,
    ) -> Result<&'a str, ProjectMatchError> {
        match &self.projects {
            Some(registry) => {
                if let Some((id, _)) = registry.projects.get_key_value(selector) {
                    return Ok(id);
                }
                let selector = selector.to_lowercase();
                let mut matches = registry
                    .projects
                    .iter()
                    .filter(|(_, project)| project.name.to_lowercase() == selector);
                let (id, _) = matches.next().ok_or(ProjectMatchError::Unknown)?;
                if matches.next().is_some() {
                    return Err(ProjectMatchError::Ambiguous);
                }
                Ok(id)
            }
            None => binding
                .filter(|binding| binding.host_project == selector)
                .map(|binding| binding.host_project.as_str())
                .ok_or(ProjectMatchError::Unknown),
        }
    }

    pub(crate) fn only_bound_repository(&self, project: &str) -> Option<&str> {
        let mut bound = self
            .projects
            .as_ref()?
            .projects
            .get(project)?
            .repositories
            .iter()
            .filter(|repo| repo.host_project.is_some());
        let origin = &bound.next()?.origin;
        bound.next().is_none().then_some(origin.as_str())
    }

    pub(crate) fn planning_projects<'a>(
        &'a self,
        binding: Option<&'a Project>,
    ) -> impl Iterator<Item = &'a str> {
        // The registry belongs to this engine profile, which is connected to one host.
        self.projects
            .iter()
            .flat_map(|registry| registry.projects.keys().map(String::as_str))
            .chain(
                binding
                    .filter(|_| self.projects.is_none())
                    .map(|project| project.host_project.as_str()),
            )
    }

    pub(crate) fn fixture_checks(&self, fixture: &Project) -> Vec<String> {
        self.fixture_project(fixture)
            .map_or_else(Vec::new, |(_, _, repo)| repo.required_checks.clone())
    }

    pub(crate) fn fixture_slots(&self, fixture: &Project) -> Option<u32> {
        match &self.projects {
            None => Some(self.project_slots(&fixture.host_project)),
            Some(_) => self
                .fixture_project(fixture)
                .filter(|(_, project, _)| !project.archived)
                .map(|(id, _, _)| self.project_slots(id)),
        }
    }

    pub(crate) fn project_slots(&self, id: &str) -> u32 {
        self.dispatch.as_ref().map_or_else(
            || DispatchSettings::default().project_default_slots,
            |dispatch| dispatch.project_slots(id),
        )
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Domain {
    Profiles,
    Dispatch,
    Projects,
    Hosts,
    Storage,
}

pub(super) async fn health(State(api): State<Api>) -> Json<Value> {
    let state = api.service.state.lock().await;
    let now = Instant::now();
    let mut waits: Vec<_> = state
        .waits
        .iter()
        .filter(|(_, wait)| wait.reason.is_some())
        .collect();
    waits.sort_unstable_by_key(|(id, wait)| (wait.since, *id));
    let oldest: Vec<_> = waits.into_iter().take(5).map(|(id, wait)| {
        json!({"taskId": id, "reason": wait.reason, "seconds": now.saturating_duration_since(wait.since).as_secs()})
    }).collect();
    Json(json!({
        "engine": {
            "databaseRoot": api.service.storage.database().path(),
            "t3Endpoint": api.service.host.endpoint(),
        },
        "lanes": {"t3": {
            "depth": state.schedule.depth(),
            "status": state.settings.host,
            "hostCalls": {
                "lastPass": state.last_pass_calls,
                "total": api.service.host.host_calls(),
            },
        }},
        "inbox": api.service.inbox_health(),
        "oldestWaits": oldest,
    }))
}

pub(super) async fn all(State(api): State<Api>) -> Result<Json<Value>, ApiError> {
    let service = api.service;
    let file = service.settings.clone();
    let (profiles, dispatch, projects, hosts, storage) = task::spawn_blocking(move || {
        Ok::<_, StorageError>((
            file.read::<Profiles>()?,
            file.read::<DispatchSettings>()?,
            file.read::<Projects>()?,
            file.read::<Hosts>()?,
            file.read::<EngineSettings>()?,
        ))
    })
    .await
    .map_err(|_| ServiceError::Input)??;
    Ok(Json(json!({
        "profiles": profiles,
        "dispatch": dispatch,
        "projects": project_view(&service, projects).await,
        "hosts": host_view(&service, hosts).await,
        "storage": storage_view(&service, &storage),
    })))
}

pub(super) async fn get(
    State(api): State<Api>,
    Path(domain): Path<Domain>,
) -> Result<Json<Value>, ApiError> {
    let service = api.service;
    let file = &service.settings;
    let view = match domain {
        Domain::Profiles => json!(read::<Profiles>(file).await?),
        Domain::Dispatch => json!(read::<DispatchSettings>(file).await?),
        Domain::Projects => project_view(&service, read(file).await?).await,
        Domain::Hosts => host_view(&service, read(file).await?).await,
        Domain::Storage => {
            let settings = read(file).await?;
            let engine = Arc::clone(&service);
            let backups = task::spawn_blocking(move || engine.storage.backups())
                .await
                .map_err(|_| ServiceError::Input)?;
            let mut view = storage_view(&service, &settings);
            view["backups"] = match backups {
                Ok(backups) => json!(backups),
                Err(_) => json!({"complete": false, "verified": [], "issues": 1}),
            };
            view
        }
    };
    Ok(Json(view))
}

async fn read<S: SettingsValue + Send + 'static>(
    file: &SettingsFile,
) -> Result<SettingsSnapshot<S>, ApiError> {
    let file = file.clone();
    Ok(task::spawn_blocking(move || file.read())
        .await
        .map_err(|_| ServiceError::Input)??)
}

async fn project_view(service: &Service, settings: SettingsSnapshot<Projects>) -> Value {
    let state = service.state.lock().await;
    let mut resolved = serde_json::Map::new();
    let mut verified = serde_json::Map::new();
    for (id, project) in &settings.value.projects {
        let mut planners = Vec::new();
        if !project.archived && state.settings.projects.as_ref() == Some(&settings.value) {
            planners.extend(
                state
                    .enrolled_planners
                    .values()
                    .filter(|proof| state.live_planner_project(&proof.identity.id) == Some(id))
                    .map(|proof| (proof.verified_at, proof.identity.id.as_str())),
            );
            planners.extend(
                state
                    .planner_authority
                    .values()
                    .filter(|authority| authority.project_id() == Some(id))
                    .filter_map(super::super::question::PlannerAuthority::resolved),
            );
        }
        planners.sort_unstable_by(|left, right| right.cmp(left));
        let mut seen = std::collections::BTreeSet::new();
        let planners: Vec<_> = planners
            .into_iter()
            .map(|(_, thread)| thread)
            .filter(|thread| seen.insert(*thread))
            .collect();
        resolved.insert(id.clone(), json!(planners.first()));
        verified.insert(id.clone(), json!(planners));
    }
    let mut settings = settings;
    settings.value.removed.clear();
    json!({"settings": settings, "resolvedPlanners": resolved, "verifiedPlanners": verified})
}

async fn host_view(service: &Service, settings: SettingsSnapshot<Hosts>) -> Value {
    let status = service.state.lock().await.settings.host;
    json!({"settings": settings, "active": {"endpoint": service.host.endpoint(), "status": status}})
}

fn storage_view(service: &Service, settings: &SettingsSnapshot<EngineSettings>) -> Value {
    let EngineSettings {
        enabled,
        placement,
        work_root,
        scratch_root,
        builds_root,
        log_root,
        retention,
        work_volume: _,
    } = &settings.value;
    json!({
        "settings": {
            "revision": settings.revision,
            "configured": settings.configured,
            "value": {
                "enabled": enabled,
                "placement": placement,
                "workRoot": work_root,
                "scratchRoot": scratch_root,
                "buildsRoot": builds_root,
                "logRoot": log_root,
                "retention": retention,
            },
        },
        "active": {
            "home": service.storage.home(),
            "placement": service.storage.placement(),
            "bargePaths": service.storage.barge_paths(),
            "databaseRoot": service.storage.database().path(),
            "workRoot": service.storage.work().path(),
            "scratchRoot": service.storage.scratch().path(),
            "buildsRoot": service.storage.builds().path(),
            "backupRoot": service.storage.backup().path(),
            "logRoot": service.storage.log().path(),
        },
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Save {
    revision: String,
    value: Value,
}

pub(super) async fn put(
    State(api): State<Api>,
    Path(domain): Path<Domain>,
    Extension(authority): Extension<Authority>,
    input: Result<Json<Save>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    require_operator(&authority)?;
    let Save { revision, value } = body(input)?;
    let service = api.service;
    // Finish publishing the local read model even if the HTTP client disconnects.
    let saved = task::spawn(async move {
        let result = match domain {
            Domain::Profiles => {
                let value = decode::<Profiles>(value)?;
                save_profiles(&service, revision, value).await
            }
            Domain::Dispatch => {
                let value = decode::<DispatchSettings>(value)?;
                save_dispatch(&service, revision, value).await
            }
            Domain::Projects => {
                let value = decode::<Projects>(value)?;
                let legacy = service.project.is_some();
                save_projects(&service, revision, move |current| {
                    if legacy {
                        for repo in value
                            .projects
                            .values()
                            .flat_map(|project| &project.repositories)
                        {
                            current.restore_origin(&repo.origin)?;
                        }
                        current.projects = value.projects;
                        Ok(())
                    } else {
                        edit_project_details(current, value)
                    }
                })
                .await
            }
            Domain::Hosts => {
                let (saved, _) = replace::<Hosts>(&service.settings, revision, value).await?;
                Ok(host_view(&service, saved).await)
            }
            Domain::Storage => {
                let mut value: EngineSettings = decode(value)?;
                if value.work_volume.is_some() {
                    return Err(ApiError::Invalid);
                }
                let (saved, _) = edit(
                    &service.settings,
                    revision,
                    move |current: &mut EngineSettings| {
                        value.work_volume.clone_from(&current.work_volume);
                        *current = value;
                        Ok(())
                    },
                )
                .await?;
                Ok(storage_view(&service, &saved))
            }
        };
        if result.is_ok() {
            match domain {
                Domain::Projects => {} // Registry publication already signals resync.
                Domain::Storage => service.storage_changes.send_replace(()),
                _ => service.settings_changes.send_replace(()),
            }
        }
        result
    })
    .await
    .map_err(|_| ServiceError::Input)??;
    Ok(Json(saved))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Reassign {
    revision: String,
    origin: String,
    to_project: String,
}

pub(super) async fn reassign(
    State(api): State<Api>,
    Extension(authority): Extension<Authority>,
    input: Result<Json<Reassign>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    require_operator(&authority)?;
    let Reassign {
        revision,
        origin,
        to_project,
    } = body(input)?;
    let service = api.service;
    Ok(Json(
        task::spawn(async move {
            save_projects(&service, revision, move |projects| {
                move_repository(projects, &origin, &to_project)
            })
            .await
        })
        .await
        .map_err(|_| ServiceError::Input)??,
    ))
}

pub(super) async fn preview_project_removal(
    State(api): State<Api>,
    Path(project): Path<String>,
    Extension(authority): Extension<Authority>,
) -> Result<Json<ProjectRemoval>, ApiError> {
    require_operator(&authority)?;
    let service = &api.service;
    if service.project.is_some() {
        return Err(ServiceError::Project.into());
    }
    service
        .storage
        .database()
        .verify()
        .map_err(ServiceError::from)?;
    let state = service.state.lock().await;
    let preview = state
        .store
        .project_removal_preview(&service.settings, &project, |task| {
            service.removal_task_live(task)
        })
        .map_err(removal_error)?;
    Ok(Json(preview))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ConfirmRemoval {
    digest: String,
    reason: String,
}

pub(super) async fn remove_project(
    State(api): State<Api>,
    Path(project): Path<String>,
    Extension(authority): Extension<Authority>,
    input: Result<Json<ConfirmRemoval>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    require_operator(&authority)?;
    let ConfirmRemoval { digest, reason } = body(input)?;
    let reason = reason.trim().to_owned();
    let service = api.service;
    if service.project.is_some() || reason.is_empty() || reason.chars().count() > 4000 {
        return Err(ApiError::Invalid);
    }
    task::spawn(async move {
        let _projects = service.project_writes.write().await;
        service
            .storage
            .database()
            .verify()
            .map_err(ServiceError::from)?;
        let mut state = service.state.lock().await;
        let removed_at_ms = crate::now_ms();
        let result = state.store.remove_project(
            &service.settings,
            &project,
            &digest,
            reason,
            removed_at_ms,
            |task| service.removal_task_live(task),
        );
        match result {
            Ok((saved, removed)) => {
                if state.settings.projects.as_ref() != Some(&saved.value) {
                    state.settings.projects = Some(saved.value);
                    service.project_settings_changed(&mut state);
                }
                Ok(Json(json!({
                    "repositories": removed.repositories,
                    "removedAtMs": removed.removed_at_ms,
                })))
            }
            Err(error) => {
                // A publication error or failed SQLite commit can leave a durable tombstone.
                // Refresh routing under the same fence before allowing another admission.
                if matches!(error, StoreError::Storage(_) | StoreError::Sqlite(_)) {
                    let recovered = state.store.clean_removed_projects(&service.settings);
                    let value = recovered.as_ref().map_or_else(
                        |_| {
                            service
                                .settings
                                .read::<Projects>()
                                .map_or_else(|_| Projects::default(), |saved| saved.value)
                        },
                        |saved| saved.value.clone(),
                    );
                    if state.settings.projects.as_ref() != Some(&value) {
                        state.settings.projects = Some(value);
                        service.project_settings_changed(&mut state);
                    }
                    recovered.map_err(removal_error)?;
                }
                Err(removal_error(error))
            }
        }
    })
    .await
    .map_err(|_| ServiceError::Input)?
}

fn removal_error(error: StoreError) -> ApiError {
    match error {
        StoreError::PlanningConflict => ApiError::ProjectOpenTasks,
        StoreError::Storage(error) => error.into(),
        error => ServiceError::from(error).into(),
    }
}

fn edit_project_details(current: &mut Projects, value: Projects) -> Result<(), StorageError> {
    let changed_route =
        || StorageError::InvalidSettings("Nucleus discovers project routes from T3".into());
    if !current
        .projects
        .keys()
        .all(|id| value.projects.contains_key(id))
    {
        return Err(changed_route());
    }
    for (id, mut edits) in value.projects {
        let known = current.projects.get(&id);
        let existing = known.map_or(0, |project| project.repositories.len());
        if edits.repositories.len() < existing || (known.is_none() && edits.repositories.is_empty())
        {
            return Err(changed_route());
        }
        for repo in &edits.repositories[existing..] {
            if !current.removed_origin(&repo.origin)
                || repo.host_project.is_some()
                || repo.host_project_title.is_some()
                || !repo.planner_threads.is_empty()
            {
                return Err(changed_route());
            }
            current.restore_origin(&repo.origin)?;
        }
        if let Some(project) = current.projects.get_mut(&id) {
            project.name = edits.name;
            project.archived = edits.archived;
            for (repo, edit) in project
                .repositories
                .iter_mut()
                .zip(edits.repositories.drain(..existing))
            {
                if (repo.origin.as_str(), &repo.path, repo.base.as_str())
                    != (edit.origin.as_str(), &edit.path, edit.base.as_str())
                    || edit
                        .host_project
                        .as_ref()
                        .is_some_and(|id| Some(id) != repo.host_project.as_ref())
                    || !edit.planner_threads.is_empty()
                        && edit.planner_threads != repo.planner_threads
                {
                    return Err(changed_route());
                }
                repo.required_checks = edit.required_checks;
                repo.hung_tool_minutes = edit.hung_tool_minutes;
            }
            project.repositories.extend(edits.repositories);
        } else {
            current.projects.insert(id, edits);
        }
    }
    Ok(())
}

fn move_repository(
    projects: &mut Projects,
    origin: &str,
    destination: &str,
) -> Result<(), StorageError> {
    if projects
        .projects
        .get(destination)
        .is_none_or(|project| project.archived)
    {
        return Err(StorageError::InvalidSettings(
            "select an active destination project".into(),
        ));
    }
    for (id, project) in &mut projects.projects {
        let Some(index) = project
            .repositories
            .iter()
            .position(|repo| repo.origin.eq_ignore_ascii_case(origin))
        else {
            continue;
        };
        if id == destination {
            return Ok(());
        }
        let repo = project.repositories.remove(index);
        projects
            .projects
            .get_mut(destination)
            .ok_or(StorageError::SettingsConflict)?
            .repositories
            .push(repo);
        return Ok(());
    }
    Err(StorageError::InvalidSettings(
        "the repository is not assigned to a project".into(),
    ))
}

fn require_operator(authority: &Authority) -> Result<(), ApiError> {
    match authority {
        Authority::Operator { .. } => Ok(()),
        Authority::Planner { .. } => Err(ApiError::SettingsOperator),
    }
}

fn decode<S: DeserializeOwned>(value: Value) -> Result<S, ApiError> {
    serde_json::from_value(value).map_err(|_| ApiError::Invalid)
}

async fn replace<S: SettingsValue + Send + 'static>(
    file: &SettingsFile,
    revision: String,
    value: Value,
) -> Result<(SettingsSnapshot<S>, bool), ApiError> {
    let value = decode(value)?;
    Ok(edit(file, revision, move |current| {
        *current = value;
        Ok(())
    })
    .await?)
}

async fn edit<S: SettingsValue + Send + 'static>(
    file: &SettingsFile,
    revision: String,
    patch: impl FnOnce(&mut S) -> Result<(), StorageError> + Send + 'static,
) -> Result<(SettingsSnapshot<S>, bool), StorageError> {
    let file = file.clone();
    task::spawn_blocking(move || file.edit(&revision, patch))
        .await
        .map_err(|_| StorageError::SettingsUnavailable)?
}

async fn save_dispatch(
    service: &Service,
    revision: String,
    value: DispatchSettings,
) -> Result<Value, ApiError> {
    let mut state = service.state.lock().await;
    let result = edit(&service.settings, revision, move |current| {
        *current = value;
        Ok(())
    })
    .await;
    match result {
        Ok((saved, changed)) => {
            if changed {
                let stopping = saved.value.mode == DispatchMode::Stopped
                    && state.settings.dispatch.as_ref().map(|prior| prior.mode)
                        != Some(DispatchMode::Stopped);
                state.settings.dispatch = Some(saved.value.clone());
                state.refresh_allowance_clock();
                service.title_wake.notify_one();
                if stopping {
                    wake_runs(&mut state)?;
                }
                service.wake_settings_capacity(&mut state);
            }
            Ok(json!(saved))
        }
        Err(error) => {
            if error.may_have_published() {
                // Fall back to a read of the atomically replaced file before admitting more work.
                let saved = read::<DispatchSettings>(&service.settings).await;
                state.settings.dispatch = saved.ok().map(|snapshot| snapshot.value);
                state.refresh_allowance_clock();
                service.title_wake.notify_one();
                service.wake_settings_capacity(&mut state);
            }
            Err(error.into())
        }
    }
}

async fn save_profiles(
    service: &Service,
    revision: String,
    value: Profiles,
) -> Result<Value, ApiError> {
    let mut state = service.state.lock().await;
    match edit(&service.settings, revision, move |current| {
        *current = value;
        Ok(())
    })
    .await
    {
        Ok((saved, changed)) => {
            if changed {
                state.settings.profiles = Some(Arc::new(saved.value.clone()));
                service.wake_settings_capacity(&mut state);
            }
            Ok(json!(saved))
        }
        Err(error) => {
            if error.may_have_published() {
                let profiles = read::<Profiles>(&service.settings)
                    .await
                    .map_or_else(|_| Profiles::default(), |saved| saved.value);
                state.settings.profiles = Some(Arc::new(profiles));
                service.wake_settings_capacity(&mut state);
            }
            Err(error.into())
        }
    }
}

async fn save_projects(
    service: &Service,
    revision: String,
    patch: impl FnOnce(&mut Projects) -> Result<(), StorageError> + Send + 'static,
) -> Result<Value, ApiError> {
    let _writes = service.project_writes.write().await;
    // This is the same lock direct and ACP planner commands use to apply a decision.
    // An in-flight scheduler refresh carries the previous epoch and cannot publish.
    let mut state = service.state.lock().await;
    let result = edit(&service.settings, revision, patch).await;
    match result {
        Ok((saved, changed)) => {
            if changed {
                state.settings.projects = Some(saved.value.clone());
                service.project_settings_changed(&mut state);
            }
            drop(state);
            Ok(project_view(service, saved).await)
        }
        Err(error) => {
            if error.may_have_published() {
                let saved = read::<Projects>(&service.settings).await;
                state.settings.projects =
                    Some(saved.map_or_else(|_| Projects::default(), |saved| saved.value));
                service.project_settings_changed(&mut state);
            }
            Err(error.into())
        }
    }
}

impl Service {
    fn removal_task_live(&self, task: &Task) -> bool {
        let identity = task.identity();
        let checkout = nucleus_work::checkout_path(
            self.storage.work().path(),
            &identity.repository,
            &identity.id,
        );
        [Role::Worker, Role::Reviewer]
            .into_iter()
            .filter_map(|role| task.threads().get(role))
            .chain(task.run().map(|run| run.launch().thread.as_str()))
            .any(|thread| self.host.bound_child_active(thread, &checkout))
    }

    pub(crate) fn project_settings_changed(&self, state: &mut crate::State) {
        state.invalidate_planner_authority();
        state.observed_forge.clear();
        self.planner_wake.notify_one();
        self.title_wake.notify_one();
        self.planner_routes_changed(state);
        self.inbox_changed();
        self.wake_settings_capacity(state);
    }

    fn wake_settings_capacity(&self, state: &mut crate::State) {
        let now = Instant::now();
        for id in state
            .capacity_waiters
            .iter()
            .map(|(_, id)| id)
            .chain(state.group_waits.keys())
            .chain(state.waits.iter().filter_map(|(id, wait)| {
                (wait.reason == Some(nucleus_core::WaitReason::UsagePermission)).then_some(id)
            }))
        {
            state
                .schedule
                .wake(id, now, crate::schedule::Priority::Wake);
        }
        self.wake.notify_one();
    }
}

/// A global stop reaches every task that holds a run on its next pass.
fn wake_runs(state: &mut crate::State) -> Result<(), ServiceError> {
    let now = Instant::now();
    for id in state.store.run_ids()? {
        state
            .schedule
            .wake(&id, now, crate::schedule::Priority::Wake);
    }
    Ok(())
}
