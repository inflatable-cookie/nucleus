use std::sync::Arc;

use axum::{
    Extension, Json,
    extract::{Path, State, rejection::JsonRejection},
};
use nucleus_core::Authority;
use nucleus_store::{
    DispatchSettings, EngineSettings, Hosts, Profiles, ProjectSettings, Projects,
    RepositorySettings, SettingsFile, SettingsSnapshot, SettingsValue, StorageError,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::{task, time::Instant};

use super::{Api, ApiError, body};
use crate::{Project, Service, ServiceError};

pub(crate) struct RuntimeSettings {
    pub dispatch: Option<DispatchSettings>,
    pub profiles: Option<Arc<Profiles>>,
    projects: Option<Projects>,
    pub host: CachedHost,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CachedHost {
    Unknown,
    Reachable,
    Unavailable,
}

impl RuntimeSettings {
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

    fn fixture_project(
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

    pub(crate) const fn uses_project_registry(&self) -> bool {
        self.projects.is_some()
    }

    pub(crate) fn planning_project_id<'a>(&'a self, binding: &'a Project) -> &'a str {
        self.fixture_project(binding)
            .map_or(binding.host_project.as_str(), |(id, _, _)| id)
    }

    pub(crate) fn knows_planning_project(&self, binding: &Project, project: &str) -> bool {
        match &self.projects {
            Some(registry) => registry.projects.contains_key(project),
            None => binding.host_project == project,
        }
    }

    pub(crate) fn fixture_checks(&self, fixture: &Project) -> Vec<String> {
        self.fixture_project(fixture)
            .map_or_else(Vec::new, |(_, _, repo)| repo.required_checks.clone())
    }

    pub(crate) fn fixture_slots(&self, fixture: &Project) -> Option<u32> {
        match &self.projects {
            None => Some(u32::MAX),
            Some(_) => self
                .fixture_project(fixture)
                .filter(|(_, project, _)| !project.archived)
                .map(|(_, project, _)| project.slots),
        }
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
    let mut waits: Vec<_> = state.waits.iter().collect();
    waits.sort_unstable_by_key(|(id, (_, since))| (*since, *id));
    let oldest: Vec<_> = waits.into_iter().take(5).map(|(id, (reason, since))| {
        json!({"taskId": id, "reason": reason, "seconds": now.saturating_duration_since(*since).as_secs()})
    }).collect();
    Json(json!({
        "lanes": {"t3": {"depth": state.schedule.depth(), "status": state.settings.host}},
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
    let planner = state
        .planner_authority
        .values()
        .filter_map(super::super::question::PlannerAuthority::resolved)
        .max_by_key(|(checked_at, _)| *checked_at)
        .map(|(_, planner)| planner);
    let mut resolved = serde_json::Map::new();
    for id in settings.value.projects.keys() {
        let planner = planner.filter(|_| {
            state
                .settings
                .fixture_project(&service.project)
                .is_some_and(|(active, project, _)| active == id && !project.archived)
                && state.settings.projects.as_ref() == Some(&settings.value)
        });
        resolved.insert(id.clone(), json!(planner));
    }
    json!({"settings": settings, "resolvedPlanners": resolved})
}

async fn host_view(service: &Service, settings: SettingsSnapshot<Hosts>) -> Value {
    let status = service.state.lock().await.settings.host;
    json!({"settings": settings, "active": {"endpoint": service.host.endpoint(), "status": status}})
}

fn storage_view(service: &Service, settings: &SettingsSnapshot<EngineSettings>) -> Value {
    json!({
        "settings": settings,
        "active": {
            "databaseRoot": service.storage.database().path(),
            "workRoot": service.storage.work().path(),
            "scratchRoot": service.storage.scratch().path(),
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
        match domain {
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
                save_projects(&service, revision, move |current| {
                    *current = value;
                    Ok(())
                })
                .await
            }
            Domain::Hosts => {
                let (saved, _) = replace::<Hosts>(&service.settings, revision, value).await?;
                Ok(host_view(&service, saved).await)
            }
            Domain::Storage => {
                let (saved, _) =
                    replace::<EngineSettings>(&service.settings, revision, value).await?;
                Ok(storage_view(&service, &saved))
            }
        }
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
                state.settings.dispatch = Some(saved.value.clone());
                service.wake_settings_capacity(&mut state);
            }
            Ok(json!(saved))
        }
        Err(error) => {
            if error.may_have_published() {
                // Fall back to a read of the atomically replaced file before admitting more work.
                let saved = read::<DispatchSettings>(&service.settings).await;
                state.settings.dispatch = saved.ok().map(|snapshot| snapshot.value);
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
    fn project_settings_changed(&self, state: &mut crate::State) {
        state.invalidate_planner_authority();
        state.observed_forge.clear();
        self.planner_wake.notify_one();
        self.wake_settings_capacity(state);
    }

    fn wake_settings_capacity(&self, state: &mut crate::State) {
        let now = Instant::now();
        for id in &state.capacity_waiters {
            state
                .schedule
                .wake(id, now, crate::schedule::Priority::Wake);
        }
        self.wake.notify_one();
    }
}
