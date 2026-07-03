//! Persistence for stopped planning capture publication/share requests.
//!
//! These records preserve request intent and evidence only. They do not run
//! SCM, forge, provider, import, task promotion, callback, interruption, or
//! recovery effects.

use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

mod diagnostics;
mod helpers;
mod record_builder;
mod store;
#[cfg(test)]
mod tests;
mod types;

pub use diagnostics::planning_capture_publication_stopped_request_diagnostics;
pub use types::{
    PlanningCapturePublicationStoppedRequestBlocker,
    PlanningCapturePublicationStoppedRequestDiagnosticBucket,
    PlanningCapturePublicationStoppedRequestDiagnostics,
    PlanningCapturePublicationStoppedRequestInput, PlanningCapturePublicationStoppedRequestRecord,
    PlanningCapturePublicationStoppedRequestStatus,
};

use crate::{PlanningCapturePublicationAdmissionStatus, ServerStateService};
use record_builder::{request_id, request_record};
use store::{decode_stopped_request_record, write_stopped_request_record, STOPPED_REQUEST_PREFIX};

pub fn persist_planning_capture_publication_stopped_request<B>(
    state: &ServerStateService<B>,
    input: PlanningCapturePublicationStoppedRequestInput,
) -> LocalStoreResult<PlanningCapturePublicationStoppedRequestRecord>
where
    B: LocalStoreBackend,
{
    let request_id = request_id(&input.admission.admission_id);
    if input.existing_request_ids.contains(&request_id) {
        return Ok(request_record(
            input,
            request_id,
            PlanningCapturePublicationStoppedRequestStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        PlanningCapturePublicationStoppedRequestStatus::Persisted
    } else {
        PlanningCapturePublicationStoppedRequestStatus::Blocked
    };
    let record = request_record(input, request_id, status, blockers, false);

    if record.status == PlanningCapturePublicationStoppedRequestStatus::Persisted {
        write_stopped_request_record(state, &record)?;
    }

    Ok(record)
}

pub fn read_planning_capture_publication_stopped_requests<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<PlanningCapturePublicationStoppedRequestRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(STOPPED_REQUEST_PREFIX))
        .map(|record| decode_stopped_request_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.request_id.cmp(&right.request_id));
    Ok(records)
}

fn blockers(
    input: &PlanningCapturePublicationStoppedRequestInput,
) -> Vec<PlanningCapturePublicationStoppedRequestBlocker> {
    let mut blockers = Vec::new();
    let admission = &input.admission;
    if admission.status != PlanningCapturePublicationAdmissionStatus::Admitted {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::AdmissionNotAdmitted);
    }
    if !admission.stopped_request_admitted {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::StoppedRequestNotAdmitted);
    }
    if admission
        .evidence_refs
        .iter()
        .all(|value| value.trim().is_empty())
    {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::MissingEvidenceRef);
    }
    if admission
        .approval_ref
        .as_ref()
        .is_none_or(|value| value.trim().is_empty())
    {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::MissingApprovalRef);
    }
    if input.raw_payload_present {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::RawPayloadPresent);
    }
    if input.command_execution_requested {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::CommandExecutionRequested);
    }
    if input.runner_handoff_requested {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::RunnerHandoffRequested);
    }
    if input.scm_or_snapshot_mutation_requested {
        blockers
            .push(PlanningCapturePublicationStoppedRequestBlocker::ScmOrSnapshotMutationRequested);
    }
    if input.remote_share_requested {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::RemoteShareRequested);
    }
    if input.forge_mutation_requested {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::ForgeMutationRequested);
    }
    if input.provider_write_requested {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::ProviderWriteRequested);
    }
    if input.projection_import_requested {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::ProjectionImportRequested);
    }
    if input.task_promotion_requested {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::TaskPromotionRequested);
    }
    if input.callback_response_requested {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(PlanningCapturePublicationStoppedRequestBlocker::RecoveryRequested);
    }
    blockers
}
