use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use nucleus_hosts::{PlannerIdentity, ThreadHint};
use nucleus_store::{
    ProjectSettings, Projects, RepositorySettings, StorageError, ThreadProvenance,
};
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use crate::{ControllerScope, Service, ServiceError, State, project::discover_repository};

const MAX_PENDING: usize = 128;
const RETRY_DELAY: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(super) struct Enrollments(BTreeMap<String, Contact>);

enum Contact {
    Requested,
    Checking,
    Refused {
        until: Instant,
        reason: Option<&'static str>,
    },
}

pub(super) struct EnrolledPlanner {
    pub(super) identity: PlannerIdentity,
    pub(super) verified_at: Instant,
}

impl State {
    pub(crate) fn live_planner_project(&self, actor: &str) -> Option<&str> {
        let proof = self.enrolled_planners.get(actor)?;
        let (id, repository) = self.settings.planner_route(actor)?;
        (repository.host_project.as_deref() == Some(&proof.identity.project_id)).then_some(id)
    }

    pub(super) fn invalidate_enrolled_planner(&mut self, hint: &ThreadHint) -> bool {
        let changed = self
            .enrolled_planners
            .get(&hint.thread)
            .is_some_and(|planner| hint.is_identity_change(Some(&planner.identity)));
        if changed {
            self.enrolled_planners.remove(&hint.thread);
        }
        if changed
            || (self.enrollments.0.get(&hint.thread).is_some_and(|contact| {
                matches!(contact, Contact::Checking) && hint.is_identity_change(None)
            }))
        {
            self.planner_authority_epoch += 1;
        }
        if hint.closed() && self.settings.planner_route(&hint.thread).is_some() {
            self.enrollments.0.insert(
                hint.thread.clone(),
                Contact::Refused {
                    until: Instant::now() + RETRY_DELAY,
                    reason: Some("The T3 planner thread is archived or gone."),
                },
            );
        }
        changed
    }
}

pub(crate) struct PlanningRepository {
    pub(crate) project_id: String,
    pub(crate) repository: String,
    pub(crate) base: String,
}

impl Service {
    /// Resolve an admission's local route, or queue one proof for a new T3 caller.
    pub(crate) fn planning_repository(
        &self,
        state: &mut State,
        scope: &ControllerScope,
        project_id: Option<&str>,
        origin: Option<&str>,
    ) -> Result<PlanningRepository, ServiceError> {
        if let Some(project) = &self.project {
            let id = state.settings.planning_project_id(project);
            if project_id.is_some_and(|requested| requested != id)
                || origin
                    .is_some_and(|requested| !project.repository.eq_ignore_ascii_case(requested))
                || state.settings.fixture_slots(project).is_none()
            {
                return Err(ServiceError::Project);
            }
            return Ok(PlanningRepository {
                project_id: id.into(),
                repository: project.repository.clone(),
                base: project.base.clone(),
            });
        }
        let (id, origin) = if let Some(actor) = scope.actor() {
            if state.live_planner_project(actor).is_none() {
                return Err(self.request_enrollment(state, actor));
            }
            let (id, repo) = state
                .settings
                .planner_route(actor)
                .ok_or(ServiceError::ControllerProject)?;
            if project_id.is_some_and(|requested| requested != id)
                || origin.is_some_and(|requested| !repo.origin.eq_ignore_ascii_case(requested))
            {
                return Err(ServiceError::ControllerProject);
            }
            (id, repo.origin.as_str())
        } else {
            let origin = origin
                .or_else(|| state.settings.only_bound_repository(project_id?))
                .ok_or(ServiceError::Project)?;
            let (id, _, _) = state
                .settings
                .project_for_origin(origin)
                .ok_or(ServiceError::Project)?;
            if project_id.is_some_and(|requested| requested != id) {
                return Err(ServiceError::Project);
            }
            (id, origin)
        };
        let repo = state.settings.repository(id, origin)?;
        Ok(PlanningRepository {
            project_id: id.into(),
            repository: repo.origin.clone(),
            base: repo.base.clone(),
        })
    }

    pub(super) fn request_enrollment(&self, state: &mut State, actor: &str) -> ServiceError {
        let contacts = &mut state.enrollments.0;
        let now = Instant::now();
        contacts.retain(
            |_, contact| !matches!(contact, Contact::Refused { until, .. } if now >= *until),
        );
        match contacts.get(actor) {
            Some(Contact::Refused {
                reason: Some(reason),
                ..
            }) => ServiceError::PlannerEnrollmentRefused(reason),
            None if contacts.len() < MAX_PENDING => {
                contacts.insert(actor.into(), Contact::Requested);
                self.enrollment_wake.notify_one();
                ServiceError::PlannerEnrollmentPending
            }
            Some(Contact::Requested | Contact::Checking | Contact::Refused { .. }) | None => {
                ServiceError::PlannerEnrollmentPending
            }
        }
    }

    pub(super) async fn watch_enrollments(&self) {
        loop {
            self.enrollment_wake.notified().await;
            while let Some(actor) = self.take_enrollment().await {
                self.complete_enrollment(&actor).await;
            }
        }
    }

    pub(super) async fn take_enrollment(&self) -> Option<String> {
        let mut state = self.state.lock().await;
        let (actor, contact) = state
            .enrollments
            .0
            .iter_mut()
            .find(|(_, contact)| matches!(contact, Contact::Requested))?;
        *contact = Contact::Checking;
        Some(actor.clone())
    }

    pub(super) async fn complete_enrollment(&self, actor: &str) {
        let result = self.verify_enrollment(actor).await;
        let mut state = self.state.lock().await;
        let reason = match result {
            Ok(()) => {
                state.enrollments.0.remove(actor);
                return;
            }
            Err(ServiceError::PlannerEnrollmentPending) => None,
            Err(ServiceError::PlannerEnrollmentRefused(reason)) => Some(reason),
            Err(ServiceError::Settings(StorageError::InvalidSettings(_))) => Some(
                "The GitHub repository is already bound to a different checkout or T3 project.",
            ),
            Err(_) => Some("Nucleus could not save the Projects binding. Retry shortly."),
        };
        state.enrollments.0.insert(
            actor.into(),
            Contact::Refused {
                until: Instant::now() + RETRY_DELAY,
                reason,
            },
        );
    }

    async fn verify_enrollment(&self, actor: &str) -> Result<(), ServiceError> {
        if !self.host.projects_synchronized() {
            return Err(ServiceError::PlannerEnrollmentPending);
        }
        let epoch = self.state.lock().await.planner_authority_epoch;
        let planner = self
            .host
            .planner_identity(actor)
            .await
            .map_err(|_| {
                ServiceError::PlannerEnrollmentRefused(
                    "T3 could not prove the exact calling thread. Retry shortly.",
                )
            })?
            .filter(|planner| {
                !planner.is_child()
                    && planner.provider_instance_id.as_deref() != self.acp_provider()
            })
            .ok_or(ServiceError::PlannerEnrollmentRefused(
                "Submit from an active, top-level T3 planner thread.",
            ))?;
        let registered = self.host.cached_project(&planner.project_id).map_err(|_| {
            ServiceError::PlannerEnrollmentRefused(
                "T3 did not report an active project and exact checkout root.",
            )
        })?;
        let checkout = PathBuf::from(registered.root);
        let git = self.git.clone();
        let mut repository =
            tokio::task::spawn_blocking(move || discover_repository(checkout, &git))
                .await
                .map_err(|_| {
                    ServiceError::PlannerEnrollmentRefused(
                        "Nucleus could not inspect the registered Git checkout.",
                    )
                })??;
        repository.host_project = Some(planner.project_id.clone());
        repository.host_project_title = registered.title.filter(|title| {
            !title.trim().is_empty() && title.len() <= 240 && !title.chars().any(char::is_control)
        });
        self.save_enrollment(epoch, planner, repository).await
    }

    async fn save_enrollment(
        &self,
        epoch: u64,
        planner: PlannerIdentity,
        repository: RepositorySettings,
    ) -> Result<(), ServiceError> {
        let _projects = self.project_writes.write().await;
        let mut state = self.state.lock().await;
        if state.planner_authority_epoch != epoch
            || !self
                .host
                .cached_project(&planner.project_id)
                .is_ok_and(|project| std::path::Path::new(&project.root) == repository.path)
        {
            return Err(ServiceError::PlannerEnrollmentPending);
        }
        if state
            .store
            .routing_provenance(&repository.origin, &[planner.id.as_str()])?
            .get(&planner.id)
            == Some(&ThreadProvenance::TaskRole)
        {
            return Err(ServiceError::PlannerEnrollmentRefused(
                "A task role cannot enroll as a project planner.",
            ));
        }
        let file = self.settings.clone();
        let actor = planner.id.clone();
        let (snapshot, changed) = tokio::task::spawn_blocking(move || {
            let revision = file.read::<Projects>()?.revision;
            file.edit(&revision, move |projects| {
                register(projects, repository, actor)
            })
        })
        .await
        .map_err(|_| {
            ServiceError::PlannerEnrollmentRefused(
                "Nucleus could not save the Projects binding. Retry shortly.",
            )
        })??;
        state.settings.projects = Some(snapshot.value);
        state.enrolled_planners.insert(
            planner.id.clone(),
            EnrolledPlanner {
                identity: planner,
                verified_at: Instant::now(),
            },
        );
        if changed {
            self.project_settings_changed(&mut state);
        } else {
            self.project_changes.send_replace(());
            self.settings_changes.send_replace(());
        }
        Ok(())
    }
}

fn register(
    projects: &mut Projects,
    mut repository: RepositorySettings,
    actor: String,
) -> Result<(), StorageError> {
    let conflict =
        || StorageError::InvalidSettings("the T3 caller or repository is already bound".into());
    if projects
        .projects
        .values()
        .flat_map(|project| &project.repositories)
        .any(|existing| {
            !existing.origin.eq_ignore_ascii_case(&repository.origin)
                && (existing.host_project.is_some()
                    && existing.host_project == repository.host_project
                    || existing.planner_threads.contains(&actor))
        })
    {
        return Err(conflict());
    }
    for project in projects.projects.values_mut() {
        if let Some(existing) = project
            .repositories
            .iter_mut()
            .find(|existing| existing.origin.eq_ignore_ascii_case(&repository.origin))
        {
            if project.archived
                || existing.path != repository.path
                || existing.base != repository.base
                || existing
                    .host_project
                    .as_ref()
                    .is_some_and(|id| Some(id) != repository.host_project.as_ref())
            {
                return Err(conflict());
            }
            existing.host_project = repository.host_project;
            existing.host_project_title = repository.host_project_title;
            if !existing.planner_threads.contains(&actor) {
                existing.planner_threads.push(actor);
            }
            return Ok(());
        }
    }
    let id = format!("repo-{:x}", Sha256::digest(&repository.origin));
    if projects.projects.contains_key(&id) {
        return Err(conflict());
    }
    let name = repository.host_project_title.clone().unwrap_or(
        repository
            .origin
            .split_once('/')
            .ok_or_else(conflict)?
            .1
            .into(),
    );
    repository.planner_threads.push(actor);
    projects.projects.insert(
        id,
        ProjectSettings {
            name,
            slots: 1,
            archived: false,
            repositories: vec![repository],
        },
    );
    Ok(())
}
