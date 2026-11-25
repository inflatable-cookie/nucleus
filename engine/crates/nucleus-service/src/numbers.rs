use crate::{ControllerScope, Service, ServiceError, State};

pub(super) struct TaskReference<'a> {
    repository: Option<&'a str>,
    number: i64,
}

impl<'a> TaskReference<'a> {
    pub(super) fn parse(value: &'a str) -> Result<Self, ServiceError> {
        let (repository, number) = value
            .split_once('#')
            .ok_or(ServiceError::TaskReferenceMissing)?;
        let number = number
            .parse::<i64>()
            .ok()
            .filter(|value| *value > 0 && number.bytes().all(|byte| byte.is_ascii_digit()))
            .ok_or(ServiceError::TaskReferenceMissing)?;
        Ok(Self {
            repository: (!repository.is_empty()).then_some(repository),
            number,
        })
    }

    pub(super) fn candidates(&self, state: &State) -> Result<Vec<String>, ServiceError> {
        Ok(state
            .store
            .numbered_task_ids(self.repository, self.number)?)
    }
}

impl Service {
    pub(super) async fn resolve_task_reference(
        &self,
        value: &str,
        scope: &ControllerScope,
    ) -> Result<String, ServiceError> {
        self.storage.database().verify()?;
        let state = self.state.lock().await;
        self.resolve_reference_in_state(&state, value, scope, None)
    }

    pub(super) fn resolve_reference_in_state(
        &self,
        state: &State,
        value: &str,
        scope: &ControllerScope,
        default_repository: Option<&str>,
    ) -> Result<String, ServiceError> {
        let mut reference = TaskReference::parse(value)?;
        if reference.repository.is_none() {
            reference.repository = Some(match default_repository {
                Some(repository) => repository,
                None => self.reference_repository(state, scope)?,
            });
        }
        let mut selected = None;
        for id in reference.candidates(state)? {
            let Some(row) = state.store.row(&id)? else {
                continue;
            };
            let identity = row.task.identity();
            if self.task_scope(identity).is_ok() && scope.task(state, identity).is_ok() {
                if selected.is_some() {
                    return Err(ServiceError::TaskReferenceAmbiguous);
                }
                selected = Some(id);
            }
        }
        selected.ok_or(ServiceError::TaskReferenceMissing)
    }

    fn reference_repository<'a>(
        &'a self,
        state: &'a State,
        scope: &ControllerScope,
    ) -> Result<&'a str, ServiceError> {
        if let Some(fixture) = &self.project {
            return Ok(&fixture.repository);
        }
        if let Some(project) = scope
            .actor()
            .and_then(|actor| state.live_planner_project(actor))
            .and_then(|id| state.settings.projects.as_ref()?.projects.get(id))
            && let [repository] = project.repositories.as_slice()
        {
            return Ok(&repository.origin);
        }
        Err(ServiceError::TaskReferenceNeedsRepository)
    }
}
