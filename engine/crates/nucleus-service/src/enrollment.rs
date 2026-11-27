use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use nucleus_hosts::{HostError, PlannerIdentity, ThreadHint};
use nucleus_store::{
    ProjectSettings, Projects, RepositorySettings, StorageError, ThreadProvenance,
};
use sha2::{Digest, Sha256};
use tokio::{sync::watch, time::Instant};

use crate::{ControllerScope, Service, ServiceError, State, project::discover_repository};

const MAX_PENDING: usize = 128;
const RETRY_DELAY: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(super) struct Enrollments(BTreeMap<String, Contact>);

#[derive(Default)]
struct EnrollmentTiming {
    identity: Option<u64>,
    checkout: Option<u64>,
    saved: Option<u64>,
    state_wait: Duration,
}

impl EnrollmentTiming {
    async fn lock_state<'a>(&mut self, service: &'a Service) -> crate::diagnostics::StateGuard<'a> {
        let start = Instant::now();
        let state = service.state.lock().await;
        self.state_wait += start.elapsed();
        state
    }
}

enum Contact {
    Requested {
        finished: watch::Sender<()>,
        binding: Option<Box<PlannerBinding>>,
        requested_ms: u64,
    },
    Checking {
        finished: watch::Sender<()>,
        requested_ms: u64,
        binding: Option<Box<PlannerBinding>>,
        observed: Option<Box<ThreadHint>>,
    },
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

#[derive(Clone)]
pub(super) struct EnrolledPlanner {
    pub(super) identity: PlannerIdentity,
    pub(super) verified_at: Instant,
    binding: PlannerBinding,
}

#[derive(Clone, PartialEq, Eq)]
struct PlannerBinding {
    project: String,
    native_project: String,
    checkout: PathBuf,
    repository: String,
    base: String,
}

impl PlannerBinding {
    fn matches(&self, project: &str, repo: &RepositorySettings) -> bool {
        self.project == project
            && repo.host_project.as_deref() == Some(&self.native_project)
            && self.checkout == repo.path
            && self.repository == repo.origin
            && self.base == repo.base
    }
}

impl State {
    fn planner_binding(&self, actor: &str) -> Option<PlannerBinding> {
        let (project, repo) = self.settings.planner_route(actor)?;
        Some(PlannerBinding {
            project: project.into(),
            native_project: repo.host_project.clone()?,
            checkout: repo.path.clone(),
            repository: repo.origin.clone(),
            base: repo.base.clone(),
        })
    }

    pub(super) fn planner_candidates_for(&self, project: &str) -> Vec<String> {
        let Some(project) = self
            .settings
            .projects
            .as_ref()
            .and_then(|s| s.projects.get(project))
            .filter(|project| !project.archived)
        else {
            return Vec::new();
        };
        let mut candidates: Vec<_> = project
            .repositories
            .iter()
            .rev()
            .flat_map(|repo| repo.planner_threads.iter().rev())
            .cloned()
            .collect();
        candidates.sort_by_key(|actor| {
            std::cmp::Reverse(
                self.enrolled_planners
                    .get(actor)
                    .map(|proof| proof.verified_at),
            )
        });
        candidates
    }

    pub(crate) fn live_planner_project(&self, actor: &str) -> Option<&str> {
        self.live_planner_route(actor).map(|(id, _)| id)
    }

    pub(super) fn live_planner_route(&self, actor: &str) -> Option<(&str, &RepositorySettings)> {
        let proof = self.enrolled_planners.get(actor)?;
        let (id, repository) = self.settings.planner_route(actor)?;
        proof
            .binding
            .matches(id, repository)
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
        if let Some(Contact::Checking { observed, .. }) = self.enrollments.0.get_mut(&hint.thread) {
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

#[derive(PartialEq, Eq)]
pub(crate) struct PlanningRepository {
    pub(crate) project_id: String,
    pub(crate) checkout: std::path::PathBuf,
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
        if let Some(name) = selector
            && state.settings.resolve_planning_project(None, name)? != id
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
        self.resolve_admission_route(state, scope, selector, origin)
            .map_err(|error| {
                let Some((id, project, repo)) =
                    origin.and_then(|origin| state.settings.project_for_origin(origin))
                else {
                    return error;
                };
                // Describe a repository only inside the caller's established project.
                if project.archived
                    || scope
                        .actor()
                        .is_some_and(|actor| state.live_planner_project(actor) != Some(id))
                {
                    return error;
                }
                match error {
                    ServiceError::TellUnknownProject(selector) => ServiceError::RepositoryOwner {
                        selector,
                        repository: repo.origin.clone(),
                        project: project.name.clone(),
                    },
                    ServiceError::Project | ServiceError::ControllerProject
                        if repo.host_project.is_none()
                            && selector.is_none_or(|name| {
                                state
                                    .settings
                                    .resolve_planning_project(self.project.as_ref(), name)
                                    .ok()
                                    == Some(id)
                            }) =>
                    {
                        ServiceError::UnboundCheckout {
                            repository: repo.origin.clone(),
                            project: project.name.clone(),
                            planner: scope.actor().is_some(),
                        }
                    }
                    other => other,
                }
            })
    }

    fn resolve_admission_route(
        &self,
        state: &mut State,
        scope: &ControllerScope,
        selector: Option<&str>,
        origin: Option<&str>,
    ) -> Result<PlanningRepository, ServiceError> {
        if let Some(project) = &self.project {
            let id = state.settings.planning_project_id(project);
            if let Some(name) = selector
                && state
                    .settings
                    .resolve_planning_project(Some(project), name)?
                    != id
            {
                return Err(ServiceError::Project);
            }
            if origin.is_some_and(|requested| !project.repository.eq_ignore_ascii_case(requested))
                || state.settings.fixture_slots(project).is_none()
            {
                return Err(ServiceError::Project);
            }
            return Ok(PlanningRepository {
                project_id: id.into(),
                checkout: project.checkout.clone(),
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
                checkout: target.path.clone(),
                repository: target.origin.clone(),
                base: target.base.clone(),
            });
        }

        let project_id = selector
            .map(|name| state.settings.resolve_planning_project(None, name))
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
            checkout: repo.path.clone(),
            repository: repo.origin.clone(),
            base: repo.base.clone(),
        })
    }

    /// A completed negative check can settle this recipient while a later demand
    /// refreshes its saved binding on the enrollment worker's retry cadence.
    pub(super) fn request_tell_enrollment(
        &self,
        state: &mut State,
        actor: &str,
    ) -> Option<ServiceError> {
        let checked = matches!(
            state.enrollments.0.get(actor),
            Some(Contact::Refused { until, .. }) if Instant::now() < *until
        );
        let result = self.request_enrollment(state, actor);
        (!checked).then_some(result)
    }

    pub(super) fn request_enrollment(&self, state: &mut State, actor: &str) -> ServiceError {
        let now = Instant::now();
        match state.enrollments.0.get(actor) {
            Some(Contact::Refused { until, failure }) if now < *until => return (*failure).into(),
            Some(Contact::Requested { finished, .. } | Contact::Checking { finished, .. }) => {
                return ServiceError::PlannerEnrollmentPending(finished.subscribe());
            }
            _ => {}
        }
        let binding = state.planner_binding(actor).map(Box::new);
        let contacts = &mut state.enrollments.0;
        if contacts.len() >= MAX_PENDING {
            contacts.retain(
                |_, contact| !matches!(contact, Contact::Refused { until, .. } if now >= *until),
            );
            if contacts.len() >= MAX_PENDING {
                return ServiceError::PlannerEnrollmentUnavailable(
                    "The T3 enrollment queue is full. Retry shortly.",
                );
            }
        }
        let (finished, wait) = watch::channel(());
        contacts.insert(
            actor.into(),
            Contact::Requested {
                binding,
                requested_ms: crate::now_ms(),
                finished,
            },
        );
        self.enrollment_wake.notify_one();
        ServiceError::PlannerEnrollmentPending(wait)
    }

    pub(super) async fn watch_enrollments(&self) {
        loop {
            self.enrollment_wake.notified().await;
            loop {
                self.host.wait_for_requests().await;
                let Some(actor) = self.take_enrollment().await else {
                    break;
                };
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
            .find(|(_, contact)| matches!(contact, Contact::Requested { .. }))?;
        let Contact::Requested {
            finished,
            binding,
            requested_ms,
        } = contact
        else {
            return None;
        };
        *contact = Contact::Checking {
            finished: finished.clone(),
            requested_ms: *requested_ms,
            binding: binding.take(),
            observed: None,
        };
        Some(actor.clone())
    }

    pub(super) async fn complete_enrollment(&self, actor: &str) {
        let (binding, requested_ms) = {
            let state = self.state.lock().await;
            let Some(Contact::Checking {
                binding,
                requested_ms,
                ..
            }) = state.enrollments.0.get(actor)
            else {
                return;
            };
            (
                binding
                    .clone()
                    .or_else(|| state.planner_binding(actor).map(Box::new)),
                *requested_ms,
            )
        };
        let result = self
            .verify_enrollment(actor, binding.as_deref(), requested_ms)
            .await;
        let mut state = self.state.lock().await;
        let failure = match result {
            Ok(()) => {
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
        state.enrollments.0.insert(
            actor.into(),
            Contact::Refused {
                until: Instant::now() + RETRY_DELAY,
                failure,
            },
        );
    }

    /// A persisted route is a candidate until checked against the exact thread and checkout.
    pub(super) async fn check_registered_planner(&self, actor: &str) -> Result<bool, ServiceError> {
        let requested_ms = crate::now_ms();
        let binding = {
            let mut state = self.state.lock().await;
            let Some(binding) = state.planner_binding(actor) else {
                return Ok(false);
            };
            if matches!(
                state.enrollments.0.get(actor),
                Some(Contact::Requested { .. } | Contact::Checking { .. })
            ) {
                return Err(HostError::Uncertain.into());
            }
            state.enrollments.0.insert(
                actor.into(),
                Contact::Checking {
                    finished: watch::channel(()).0,
                    requested_ms,
                    binding: None,
                    observed: None,
                },
            );
            binding
        };
        let result = self
            .verify_enrollment(actor, Some(&binding), requested_ms)
            .await;
        let mut state = self.state.lock().await;
        state.enrollments.0.remove(actor);
        if result.is_ok() {
            return Ok(state.live_planner_project(actor) == Some(binding.project.as_str()));
        }
        if state.enrolled_planners.remove(actor).is_some() {
            self.planner_routes_changed(&mut state);
        }
        if state.planner_binding(actor).is_none() {
            return Ok(false);
        }
        Err(match result {
            Err(ServiceError::Settings(error)) => error.into(),
            Err(ServiceError::Host(error)) => error.into(),
            _ => HostError::Uncertain.into(),
        })
    }

    async fn verify_enrollment(
        &self,
        actor: &str,
        binding: Option<&PlannerBinding>,
        requested_ms: u64,
    ) -> Result<(), ServiceError> {
        let mut timing = EnrollmentTiming::default();
        let result = self.resolve_enrollment(actor, binding, &mut timing).await;
        let outcome = result
            .as_ref()
            .map_or_else(|error| format!("failed: {error}"), |()| "bound".to_owned());
        let stamp =
            |ms: Option<u64>| ms.map_or_else(|| "unresolved".to_owned(), |ms| ms.to_string());
        nucleus_hosts::service_log!(
            "T3 planner enrollment for {actor:?}: requested_ms={requested_ms} identity_resolved_ms={} checkout_verified_ms={} binding_saved_ms={} state_lock_wait_ms={} finished_ms={} {outcome}",
            stamp(timing.identity),
            stamp(timing.checkout),
            stamp(timing.saved),
            timing.state_wait.as_millis(),
            crate::now_ms()
        );
        result
    }

    async fn resolve_enrollment(
        &self,
        actor: &str,
        binding: Option<&PlannerBinding>,
        timing: &mut EnrollmentTiming,
    ) -> Result<(), ServiceError> {
        if !self.host.projects_synchronized() {
            return Err(ServiceError::PlannerEnrollmentUnavailable(
                "The T3 project snapshot has not synchronized. Retry shortly.",
            ));
        }
        let epoch = timing.lock_state(self).await.planner_authority_epoch;
        let planner = self.host.planner_identity(actor).await.map_err(|error| {
            if binding.is_some() {
                return ServiceError::Host(error);
            }
            ServiceError::PlannerEnrollmentUnavailable(
                "T3 could not prove the exact calling thread. Retry shortly.",
            )
        })?;
        timing.identity = Some(crate::now_ms());
        let refused = match planner.as_ref() {
            None => Some("The T3 planner thread is archived or gone."),
            Some(planner) if planner.is_child() => {
                Some("Submit from a top-level T3 planner thread.")
            }
            Some(planner)
                if binding.is_some_and(|binding| binding.native_project != planner.project_id) =>
            {
                Some("The T3 planner thread changed projects.")
            }
            Some(_) => None,
        };
        if let Some(reason) = refused {
            if let Some(binding) = binding {
                self.revoke_planner(epoch, actor, binding, timing).await?;
            }
            return Err(ServiceError::PlannerEnrollmentRefused(reason));
        }
        let planner = planner.ok_or(ServiceError::Input)?;
        if self
            .acp_provider()
            .is_some_and(|provider| planner.provider_instance_id.as_deref() == Some(provider))
        {
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
        timing.checkout = Some(crate::now_ms());
        repository.host_project = Some(planner.project_id.clone());
        repository.host_project_title = registered.title.filter(|title| {
            !title.trim().is_empty() && title.len() <= 240 && !title.chars().any(char::is_control)
        });
        self.save_enrollment(epoch, planner, repository, binding, timing)
            .await?;
        timing.saved = Some(crate::now_ms());
        Ok(())
    }

    async fn save_enrollment(
        &self,
        epoch: u64,
        planner: PlannerIdentity,
        repository: RepositorySettings,
        binding: Option<&PlannerBinding>,
        timing: &mut EnrollmentTiming,
    ) -> Result<(), ServiceError> {
        let _projects = self.project_writes.write().await;
        let mut state = timing.lock_state(self).await;
        if let Some(Contact::Checking {
            observed: Some(hint),
            ..
        }) = state.enrollments.0.get(&planner.id)
        {
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
        if let Some(binding) = binding {
            if state.planner_binding(&planner.id).as_ref() != Some(binding)
                || binding.checkout != repository.path
                || !binding.repository.eq_ignore_ascii_case(&repository.origin)
                || binding.base != repository.base
            {
                return Err(ServiceError::PlannerEnrollmentUnavailable(
                    "The registered T3 checkout changed or is unavailable. Retry shortly.",
                ));
            }
            if state
                .enrolled_planners
                .get(&planner.id)
                .is_none_or(|proof| proof.binding != *binding || proof.identity != planner)
            {
                state.enrolled_planners.insert(
                    planner.id.clone(),
                    EnrolledPlanner {
                        identity: planner,
                        verified_at: Instant::now(),
                        binding: binding.clone(),
                    },
                );
                self.planner_routes_changed(&mut state);
            }
            return Ok(());
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
        let binding = state
            .planner_binding(&planner.id)
            .ok_or(ServiceError::Project)?;
        state.enrolled_planners.insert(
            planner.id.clone(),
            EnrolledPlanner {
                identity: planner,
                verified_at: Instant::now(),
                binding,
            },
        );
        if changed {
            self.project_settings_changed(&mut state);
        } else {
            self.planner_routes_changed(&mut state);
        }
        Ok(())
    }

    async fn revoke_planner(
        &self,
        epoch: u64,
        actor: &str,
        binding: &PlannerBinding,
        timing: &mut EnrollmentTiming,
    ) -> Result<(), ServiceError> {
        let _projects = self.project_writes.write().await;
        let mut state = timing.lock_state(self).await;
        if state.planner_authority_epoch != epoch
            || state.planner_binding(actor).as_ref() != Some(binding)
            || matches!(
                state.enrollments.0.get(actor),
                Some(Contact::Checking {
                    observed: Some(_),
                    ..
                })
            )
        {
            return Err(HostError::Uncertain.into());
        }
        let file = self.settings.clone();
        let binding = binding.clone();
        let actor = actor.to_owned();
        let remove = actor.clone();
        let (snapshot, _) = tokio::task::spawn_blocking(move || {
            let revision = file.read::<Projects>()?.revision;
            file.edit(&revision, |projects: &mut Projects| {
                if let Some(repo) =
                    projects
                        .projects
                        .get_mut(&binding.project)
                        .and_then(|project| {
                            project
                                .repositories
                                .iter_mut()
                                .find(|repo| binding.matches(&binding.project, repo))
                        })
                {
                    repo.planner_threads.retain(|thread| thread != &remove);
                }
                Ok(())
            })
        })
        .await
        .map_err(|_| HostError::Uncertain)??;
        state.settings.projects = Some(snapshot.value);
        state.enrolled_planners.remove(&actor);
        self.project_settings_changed(&mut state);
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
    if projects.removed_origin(&repository.origin) {
        return Err(StorageError::InvalidSettings(
            "This repository's project was removed".into(),
        ));
    }
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
            planner_claim: None,
            name,
            archived: false,
            repositories: vec![repository],
        },
    );
    Ok(())
}
