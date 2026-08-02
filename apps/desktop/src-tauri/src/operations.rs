use std::sync::{Arc, Mutex};

use longhorn_core::{
    OperationAuthorityId, OperationId, OperationKindId, OperationRequestId, OperationScopeId,
};
use longhorn_operation::{
    OperationAuthorityEpoch, OperationCancellationCommand, OperationCancellationResult,
    OperationCancellationSupportProjection, OperationCatalogue, OperationCatalogueLimits,
    OperationMutationCommand, OperationMutationResult, OperationProtocolVersion, OperationSnapshot,
    OperationSnapshotQuery, OperationSnapshotResponse, OperationStateProjection,
};
use longhorn_tauri_operation::{
    operation_cancellation_changed_event, operation_mutation_changed_event, OperationHostError,
    OperationHostService, TauriOperationState, OPERATION_CHANGED_EVENT,
};
use tauri::{App, AppHandle, Emitter, Manager, Runtime};

pub(crate) const KIND_FORGE_INSPECTION: &str = "nucleus:forge-inspection";
pub(crate) const KIND_FORGE_MUTATION: &str = "nucleus:forge-mutation";
pub(crate) const KIND_FORGE_COMMIT: &str = "nucleus:forge-commit";
#[cfg(test)]
pub(crate) const KIND_RESOURCE_IMPORT: &str = "nucleus:resource-import";
#[cfg(test)]
pub(crate) const KIND_INDEXING: &str = "nucleus:indexing";
#[cfg(test)]
pub(crate) const KIND_RECOVERY: &str = "nucleus:recovery";

#[derive(Clone)]
pub(crate) struct NucleusOperationState {
    runtime: Arc<NucleusOperationRuntime>,
}

impl NucleusOperationState {
    pub(crate) fn begin<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        kind: &str,
        scope: Option<&str>,
        label: &str,
        cancellable: bool,
    ) -> Result<NucleusOperationHandle, String> {
        self.runtime.begin(app, kind, scope, label, cancellable)
    }

    pub(crate) fn finish<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        handle: &NucleusOperationHandle,
        succeeded: bool,
    ) {
        if let Err(error) = self.runtime.finish(app, handle, succeeded) {
            eprintln!("operation terminal publication failed: {error}");
        }
    }
}

pub(crate) struct NucleusOperationHandle {
    operation_id: OperationId,
    kind: String,
    scope: Option<String>,
    label: String,
}

struct NucleusOperationRuntime {
    catalogue: Mutex<OperationCatalogue>,
    sequence: Mutex<u64>,
}

impl NucleusOperationRuntime {
    fn new() -> Result<Self, String> {
        Ok(Self {
            catalogue: Mutex::new(OperationCatalogue::new(
                id::<OperationAuthorityId>("nucleus:desktop-operations")?,
                OperationAuthorityEpoch::new(1).map_err(|error| error.to_string())?,
                OperationCatalogueLimits::new(64, 100, 1024 * 1024)
                    .map_err(|error| error.to_string())?,
            )),
            sequence: Mutex::new(0),
        })
    }

    fn begin<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        kind: &str,
        scope: Option<&str>,
        label: &str,
        cancellable: bool,
    ) -> Result<NucleusOperationHandle, String> {
        let (operation_id, result) = self.begin_mutation(kind, scope, label, cancellable)?;
        publish_mutation(app, &result)?;
        match result {
            OperationMutationResult::Committed { .. } => Ok(NucleusOperationHandle {
                operation_id,
                kind: kind.to_owned(),
                scope: scope.map(str::to_owned),
                label: label.to_owned(),
            }),
            OperationMutationResult::Rejected { rejection, .. } => Err(rejection.detail),
        }
    }

    fn begin_mutation(
        &self,
        kind: &str,
        scope: Option<&str>,
        label: &str,
        cancellable: bool,
    ) -> Result<(OperationId, OperationMutationResult), String> {
        let sequence = {
            let mut sequence = self
                .sequence
                .lock()
                .map_err(|_| "operation sequence unavailable")?;
            *sequence = sequence
                .checked_add(1)
                .ok_or("operation sequence exhausted")?;
            *sequence
        };
        let operation_id = id::<OperationId>(&format!("operation:nucleus:{sequence}"))?;
        let mut catalogue = self
            .catalogue
            .lock()
            .map_err(|_| "operation authority unavailable")?;
        let snapshot =
            OperationSnapshot::from_catalogue(&catalogue).map_err(|error| error.to_string())?;
        let result = catalogue
            .execute_protocol_mutation(OperationMutationCommand::Register {
                request_id: request_id(sequence, "register")?,
                protocol_version: OperationProtocolVersion::CURRENT,
                authority: snapshot.authority,
                expected_catalogue_revision: snapshot.catalogue_revision,
                operation_id: operation_id.clone(),
                kind_id: id::<OperationKindId>(kind)?,
                scope_id: scope.map(id::<OperationScopeId>).transpose()?,
                label: label.to_owned(),
                initial_state: OperationStateProjection::Running,
                cancellation_support: if cancellable {
                    OperationCancellationSupportProjection::Supported
                } else {
                    OperationCancellationSupportProjection::Unsupported
                },
                retry_of: None,
            })
            .map_err(|error| error.to_string())?;
        Ok((operation_id, result))
    }

    fn finish<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        handle: &NucleusOperationHandle,
        succeeded: bool,
    ) -> Result<(), String> {
        let result = self.finish_mutation(handle, succeeded)?;
        publish_mutation(app, &result)?;
        if !succeeded {
            crate::notifications::publish_operation_failure(
                app,
                &handle.operation_id,
                &handle.kind,
                handle.scope.as_deref(),
                &handle.label,
            );
        }
        match result {
            OperationMutationResult::Committed { .. } => Ok(()),
            OperationMutationResult::Rejected { rejection, .. } => Err(rejection.detail),
        }
    }

    fn finish_mutation(
        &self,
        handle: &NucleusOperationHandle,
        succeeded: bool,
    ) -> Result<OperationMutationResult, String> {
        let mut catalogue = self
            .catalogue
            .lock()
            .map_err(|_| "operation authority unavailable")?;
        let snapshot =
            OperationSnapshot::from_catalogue(&catalogue).map_err(|error| error.to_string())?;
        let (operation_sequence, operation_revision) = {
            let operation = catalogue
                .operation(&handle.operation_id)
                .ok_or("operation is no longer retained")?;
            (operation.sequence().get(), operation.revision())
        };
        let result = catalogue
            .execute_protocol_mutation(OperationMutationCommand::Transition {
                request_id: request_id(operation_sequence, "terminal")?,
                protocol_version: OperationProtocolVersion::CURRENT,
                authority: snapshot.authority,
                operation_id: handle.operation_id.clone(),
                expected_operation_revision: operation_revision,
                next_state: if succeeded {
                    OperationStateProjection::Succeeded
                } else {
                    OperationStateProjection::Failed
                },
            })
            .map_err(|error| error.to_string())?;
        Ok(result)
    }

    fn authorize(caller: &str) -> Result<(), OperationHostError> {
        if caller == "main" {
            Ok(())
        } else {
            Err(OperationHostError::authority(
                "operation caller is not authorized",
                false,
            ))
        }
    }
}

impl OperationHostService for NucleusOperationRuntime {
    fn snapshot(
        &self,
        caller: &str,
        query: OperationSnapshotQuery,
    ) -> Result<OperationSnapshotResponse, OperationHostError> {
        Self::authorize(caller)?;
        if query.protocol_version != OperationProtocolVersion::CURRENT {
            return Err(OperationHostError::authority(
                "operation protocol is incompatible",
                false,
            ));
        }
        let catalogue = self
            .catalogue
            .lock()
            .map_err(|_| OperationHostError::authority("operation authority unavailable", true))?;
        let snapshot = OperationSnapshot::from_catalogue(&catalogue)
            .map_err(|error| OperationHostError::authority(error.to_string(), false))?;
        Ok(OperationSnapshotResponse {
            request_id: query.request_id,
            snapshot,
        })
    }

    fn mutate(
        &self,
        caller: &str,
        command: OperationMutationCommand,
    ) -> Result<OperationMutationResult, OperationHostError> {
        Self::authorize(caller)?;
        if !matches!(command, OperationMutationCommand::Dismiss { .. }) {
            return Err(OperationHostError::authority(
                "renderer may only dismiss terminal operation projections",
                false,
            ));
        }
        self.catalogue
            .lock()
            .map_err(|_| OperationHostError::authority("operation authority unavailable", true))?
            .execute_protocol_mutation(command)
            .map_err(|error| OperationHostError::authority(error.to_string(), false))
    }

    fn cancel(
        &self,
        caller: &str,
        command: OperationCancellationCommand,
    ) -> Result<OperationCancellationResult, OperationHostError> {
        Self::authorize(caller)?;
        self.catalogue
            .lock()
            .map_err(|_| OperationHostError::authority("operation authority unavailable", true))?
            .execute_protocol_cancellation(command)
            .map_err(|error| OperationHostError::authority(error.to_string(), false))
    }
}

pub(crate) fn install(app: &App) -> Result<(), String> {
    let runtime = Arc::new(NucleusOperationRuntime::new()?);
    let service: Arc<dyn OperationHostService> = runtime.clone();
    app.manage(NucleusOperationState { runtime });
    app.manage(TauriOperationState::new(service));
    Ok(())
}

fn publish_mutation<R: Runtime>(
    app: &AppHandle<R>,
    result: &OperationMutationResult,
) -> Result<(), String> {
    if let Some(event) = operation_mutation_changed_event(result) {
        app.emit(OPERATION_CHANGED_EVENT, event)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[allow(dead_code)]
fn publish_cancellation<R: Runtime>(
    app: &AppHandle<R>,
    result: &OperationCancellationResult,
) -> Result<(), String> {
    if let Some(event) = operation_cancellation_changed_event(result) {
        app.emit(OPERATION_CHANGED_EVENT, event)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn request_id(sequence: u64, phase: &str) -> Result<OperationRequestId, String> {
    id(&format!("request:nucleus-operation:{sequence}:{phase}"))
}

fn id<T>(value: &str) -> Result<T, String>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    value.parse::<T>().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests;
