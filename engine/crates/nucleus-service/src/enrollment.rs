use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use nucleus_hosts::{HostError, PlannerIdentity, ThreadHint};
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
    Checking(Option<Box<ThreadHint>>),
    Refused {
        until: Instant,
        failure: EnrollmentFailure,
    },
}

#[derive(Clone, Copy)]
enum EnrollmentFailure {
    Refused(&'static str),
    Unavailable(&'static str),
}

impl From<EnrollmentFailure> for ServiceError {
    fn from(failure: EnrollmentFailure) -> Self {
        match failure {
            EnrollmentFailure::Refused(reason) => Self::PlannerEnrollmentRefused(reason),
            EnrollmentFailure::Unavailable(reason) => Self::PlannerEnrollmentUnavailable(reason),
        }
    }
}

pub(super) struct EnrolledPlanner {
    pub(super) identity: PlannerIdentity,
    pub(super) verified_at: Instant,
}

impl State {
    pub(crate) fn live_planner_project(&self, actor: &str) -> Option<&str> {
        self.live_planner_route(actor).map(|(id, _)| id)
    }

    pub(super) fn live_planner_route(&self, actor: &str) -> Option<(&str, &RepositorySettings)> {
        let proof = self.enrolled_planners.get(actor)?;
        let (id, repository) = self.settings.planner_route(actor)?;
        (repository.host_project.as_deref() == Some(&proof.identity.project_id))
            .then_some((id, repository))
    }

    pub(super) fn invalidate_enrolled_planner(&mut self, hint: &ThreadHint) -> bool {
        let changed = self
            .enrolled_planners
            .get(&hint.thread)
            .is_some_and(|planner| hint.is_identity_change(Some(&planner.identity)));
        if changed {
            self.enrolled_planners.remove(&hint.thread);
            self.planner_authority_epoch += 1;
        }
        if let Some(Contact::Checking(observed)) = self.enrollments.0.get_mut(&hint.thread) {
            // Compare the shell identity to the exact read before publishing.
            // Keep a closure even if a later update arrives during this attempt.
            if hint.is_identity_change(None) && !observed.as_ref().is_some_and(|hint| hint.closed())
            {
                *observed = Some(Box::new(hint.clone()));
            }
        } else if hint.closed() && self.settings.planner_route(&hint.thread).is_some() {
            self.enrollments.0.insert(
                hint.thread.clone(),
                Contact::Refused {
                    until: Instant::now() + RETRY_DELAY,
                    failure: EnrollmentFailure::Refused(
                        "The T3 planner thread is archived or gone.",
                    ),
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
    pub(super) fn planning_planner_project(
        &self,
        state: &mut State,
        actor: &str,
        selector: Option<&str>,
    ) -> Result<String, ServiceError> {
        let Some(id) = state.live_planner_project(actor) else {
            return Err(self.request_enrollment(state, actor));
        };
        if selector
            .is_some_and(|name| state.settings.resolve_planning_project(None, name) != Some(id))
        {
            return Err(ServiceError::ControllerProject);
        }
        Ok(id.into())
    }

    fn require_planning_checkout(&self, repo: &RepositorySettings) -> Result<(), ServiceError> {
        if repo.host_project.as_ref().is_some_and(|host| {
            self.host
                .cached_project(host)
                .is_ok_and(|project| std::path::Path::new(&project.root) == repo.path)
        }) {
            Ok(())
        } else {
            Err(ServiceError::PlannerEnrollmentUnavailable(
                "The registered T3 checkout changed or is unavailable. Retry shortly.",
            ))
        }
    }

    /// Resolve an admission's local route, or queue one proof for a new T3 caller.
    pub(crate) fn planning_repository(
        &self,
        state: &mut State,
        scope: &ControllerScope,
        selector: Option<&str>,
        origin: Option<&str>,
    ) -> Result<PlanningRepository, ServiceError> {
        if let Some(project) = &self.project {
            let id = state.settings.planning_project_id(project);
            if selector.is_some_and(|name| {
                state.settings.resolve_planning_project(Some(project), name) != Some(id)
            }) || origin
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
        if let Some(actor) = scope.actor() {
            let project_id = self.planning_planner_project(state, actor, selector)?;
            let (_, native) = state
                .live_planner_route(actor)
                .ok_or(ServiceError::ControllerProject)?;
            self.require_planning_checkout(native)?;
            let target = state
                .settings
                .repository(&project_id, origin.unwrap_or(&native.origin))
                .map_err(|_| ServiceError::ControllerProject)?;
            if !std::ptr::eq(target, native) {
                self.require_planning_checkout(target)?;
            }
            return Ok(PlanningRepository {
                project_id,
                repository: target.origin.clone(),
                base: target.base.clone(),
            });
        }

        let project_id = selector
            .map(|name| {
                state
                    .settings
                    .resolve_planning_project(None, name)
                    .ok_or(ServiceError::Project)
            })
            .transpose()?;
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
        match contacts.get(actor) {
            Some(&Contact::Refused { until, failure }) => {
                if now >= until {
                    contacts.insert(actor.into(), Contact::Requested);
                    self.enrollment_wake.notify_one();
                }
                failure.into()
            }
            Some(Contact::Requested | Contact::Checking(_)) => {
                ServiceError::PlannerEnrollmentPending
            }
            None => {
                if contacts.len() >= MAX_PENDING {
                    contacts.retain(
                        |_, contact| !matches!(contact, Contact::Refused { until, .. } if now >= *until),
                    );
                }
                if contacts.len() >= MAX_PENDING {
                    return ServiceError::PlannerEnrollmentUnavailable(
                        "The T3 enrollment queue is full. Retry shortly.",
                    );
                }
                contacts.insert(actor.into(), Contact::Requested);
                self.enrollment_wake.notify_one();
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
        *contact = Contact::Checking(None);
        Some(actor.clone())
    }

    pub(super) async fn complete_enrollment(&self, actor: &str) {
        let result = self.verify_enrollment(actor).await;
        let mut state = self.state.lock().await;
        let failure = match result {
            Ok(()) => {
                eprintln!("T3 planner enrollment for {actor:?}: verified and bound.");
                state.enrollments.0.remove(actor);
                return;
            }
            Err(ServiceError::PlannerEnrollmentRefused(reason)) => {
                EnrollmentFailure::Refused(reason)
            }
            Err(ServiceError::PlannerEnrollmentUnavailable(reason)) => {
                EnrollmentFailure::Unavailable(reason)
            }
            Err(ServiceError::Settings(StorageError::InvalidSettings(_))) => {
                EnrollmentFailure::Refused(
                    "The GitHub repository is already bound to a different checkout or T3 project.",
                )
            }
            Err(_) => EnrollmentFailure::Unavailable(
                "Nucleus could not save the Projects binding. Retry shortly.",
            ),
        };
        eprintln!(
            "T3 planner enrollment for {actor:?}: {}",
            ServiceError::from(failure)
        );
        state.enrollments.0.insert(
            actor.into(),
            Contact::Refused {
                until: Instant::now() + RETRY_DELAY,
                failure,
            },
        );
    }

    async fn verify_enrollment(&self, actor: &str) -> Result<(), ServiceError> {
        if !self.host.projects_synchronized() {
            return Err(ServiceError::PlannerEnrollmentUnavailable(
                "The T3 project snapshot has not synchronized. Retry shortly.",
            ));
        }
        let epoch = self.state.lock().await.planner_authority_epoch;
        let planner = self
            .host
            .planner_identity(actor)
            .await
            .map_err(|_| {
                ServiceError::PlannerEnrollmentUnavailable(
                    "T3 could not prove the exact calling thread. Retry shortly.",
                )
            })?
            .ok_or(ServiceError::PlannerEnrollmentRefused(
                "The T3 planner thread is archived or gone.",
            ))?;
        if planner.is_child() || planner.provider_instance_id.as_deref() == self.acp_provider() {
            return Err(ServiceError::PlannerEnrollmentRefused(
                "Submit from a top-level T3 planner thread.",
            ));
        }
        let registered = self
            .host
            .cached_project(&planner.project_id)
            .map_err(|error| {
                if matches!(error, HostError::Binding) {
                    ServiceError::PlannerEnrollmentRefused(
                        "T3 did not report an active project and exact checkout root.",
                    )
                } else {
                    ServiceError::PlannerEnrollmentUnavailable(
                        "The T3 project snapshot is unavailable. Retry shortly.",
                    )
                }
            })?;
        let checkout = PathBuf::from(registered.root);
        let git = self.git.clone();
        let mut repository =
            tokio::task::spawn_blocking(move || discover_repository(checkout, &git))
                .await
                .map_err(|_| {
                    ServiceError::PlannerEnrollmentUnavailable(
                        "Nucleus could not inspect the registered Git checkout. Retry shortly.",
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
        if let Some(Contact::Checking(Some(hint))) = state.enrollments.0.get(&planner.id) {
            if hint.closed() {
                return Err(ServiceError::PlannerEnrollmentRefused(
                    "The T3 planner thread is archived or gone.",
                ));
            }
            if hint.is_identity_change(Some(&planner)) {
                return Err(ServiceError::PlannerEnrollmentUnavailable(
                    "The T3 planner identity changed during verification. Retry shortly.",
                ));
            }
        }
        if state.planner_authority_epoch != epoch
            || !self
                .host
                .cached_project(&planner.project_id)
                .is_ok_and(|project| std::path::Path::new(&project.root) == repository.path)
        {
            return Err(ServiceError::PlannerEnrollmentUnavailable(
                "The T3 project or planner proof changed during verification. Retry shortly.",
            ));
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
            ServiceError::PlannerEnrollmentUnavailable(
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
                || existing.host_project.as_ref().is_some_and(|id| {
                    Some(id) != repository.host_project.as_ref()
                        || existing.path != repository.path
                        || existing.base != repository.base
                })
            {
                return Err(conflict());
            }
            existing.path = repository.path;
            existing.base = repository.base;
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
            archived: false,
            repositories: vec![repository],
        },
    );
    Ok(())
}
