use nucleus_core::RevisionId;
use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus, ManagementProjectionRecordId,
};
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult, RevisionExpectation};

use crate::runtime_receipt_state::write_runtime_receipt;
use crate::state::ServerStateService;

use super::super::types::{ManagementProjectionAppliedRecord, ManagementProjectionApplyBlock};

pub(super) fn write_apply_receipt<B>(
    state: &ServerStateService<B>,
    receipt: &EngineRuntimeReceiptRecord,
) -> LocalStoreResult<()>
where
    B: LocalStoreBackend,
{
    write_runtime_receipt(
        state,
        receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::Any,
    )
    .map(|_| ())
}

pub(super) fn receipt_for_applied(
    applied: &ManagementProjectionAppliedRecord,
) -> EngineRuntimeReceiptRecord {
    apply_receipt(
        &receipt_id(&applied.record_id, "accepted"),
        EngineRuntimeReceiptStatus::Completed,
        &applied.record_id,
        &applied.file_ref,
        vec![EngineRuntimeReceiptRef::Custom(format!(
            "revision:{}",
            applied.revision_id.0
        ))],
        Some(format!(
            "accepted management projection apply for {}",
            applied.record_id.0
        )),
    )
}

pub(super) fn receipt_for_block(
    block: &ManagementProjectionApplyBlock,
) -> EngineRuntimeReceiptRecord {
    let record_id = block
        .record_id
        .clone()
        .unwrap_or_else(|| ManagementProjectionRecordId("unknown".to_owned()));
    let mut evidence_refs = vec![EngineRuntimeReceiptRef::Custom(format!(
        "block_kind:{:?}",
        block.kind
    ))];
    if let Some(conflict) = &block.conflict {
        evidence_refs.push(EngineRuntimeReceiptRef::Custom(format!(
            "conflict:{}",
            conflict.conflict_id
        )));
    }
    let status = if block.kind
        == super::super::types::ManagementProjectionApplyBlockKind::SemanticConflict
    {
        EngineRuntimeReceiptStatus::WaitingForApproval
    } else {
        EngineRuntimeReceiptStatus::Blocked
    };

    apply_receipt(
        &receipt_id(&record_id, "blocked"),
        status,
        &record_id,
        &block.file_ref,
        evidence_refs,
        Some(format!(
            "blocked management projection apply for {}: {:?}",
            record_id.0, block.kind
        )),
    )
}

pub(super) fn receipt_for_skipped(
    applied: &ManagementProjectionAppliedRecord,
) -> EngineRuntimeReceiptRecord {
    apply_receipt(
        &receipt_id(&applied.record_id, "skipped"),
        EngineRuntimeReceiptStatus::Blocked,
        &applied.record_id,
        &applied.file_ref,
        vec![EngineRuntimeReceiptRef::Custom(
            "skipped_due_to_blocked_apply_batch".to_owned(),
        )],
        Some(format!(
            "skipped management projection apply for {} because another record was blocked",
            applied.record_id.0
        )),
    )
}

fn apply_receipt(
    receipt_id: &EngineRuntimeReceiptRecordId,
    status: EngineRuntimeReceiptStatus,
    record_id: &ManagementProjectionRecordId,
    file_ref: &nucleus_engine::ManagementProjectionFileRef,
    mut evidence_refs: Vec<EngineRuntimeReceiptRef>,
    summary: Option<String>,
) -> EngineRuntimeReceiptRecord {
    evidence_refs.push(EngineRuntimeReceiptRef::Custom(format!(
        "record:{}",
        record_id.0
    )));
    evidence_refs.push(EngineRuntimeReceiptRef::Custom(format!(
        "file:{}",
        file_ref.0
    )));

    EngineRuntimeReceiptRecord {
        receipt_id: receipt_id.clone(),
        family: EngineRuntimeReceiptEffectFamily::Custom("management_projection_apply".to_owned()),
        status,
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(
            "management_projection_apply".to_owned(),
        )),
        evidence_refs,
        artifact_refs: Vec::new(),
        summary,
    }
}

fn receipt_id(
    record_id: &ManagementProjectionRecordId,
    suffix: &str,
) -> EngineRuntimeReceiptRecordId {
    EngineRuntimeReceiptRecordId(format!(
        "receipt:management-projection-apply:{}:{suffix}",
        record_id.0
    ))
}
