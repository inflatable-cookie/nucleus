use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind};
use nucleus_engine::ManagementProjectionPayload;
use nucleus_local_store::{
    LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload, LocalStoreResult,
};

use super::super::PlanningProjectionImportActiveApplyExecutorOperationPlan;
use super::types::PlanningProjectionImportMinimumApplyProofRequest;

pub(super) fn planning_artifact_record(
    request: &PlanningProjectionImportMinimumApplyProofRequest,
    operation: &PlanningProjectionImportActiveApplyExecutorOperationPlan,
) -> LocalStoreResult<LocalStoreRecord> {
    let ManagementProjectionPayload::PlanningArtifact(artifact) =
        &request.reviewed_document.payload
    else {
        return Err(LocalStoreError::InvalidRecord {
            reason: "reviewed document payload is not a planning artifact".to_owned(),
        });
    };
    let bytes = serde_json::to_vec(artifact).map_err(|error| LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    })?;
    Ok(LocalStoreRecord {
        id: PersistenceRecordId(operation.record_id.clone()),
        domain: PersistenceDomain::Planning,
        kind: PersistenceRecordKind::PlanningArtifact,
        revision_id: request.next_revision_id.clone(),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes,
        },
    })
}
