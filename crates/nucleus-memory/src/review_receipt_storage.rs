//! JSON storage shape for accepted-memory import-apply review receipts.
//!
//! Review receipt payloads persist operator decisions over stopped
//! import-apply admissions. They do not store raw memory bodies, projection
//! payloads, provider payloads, raw transcripts, terminal streams,
//! credentials, secret values, or private notes.

use serde::{Deserialize, Serialize};

/// Current accepted-memory review receipt storage schema version.
pub const ACCEPTED_MEMORY_REVIEW_RECEIPT_STORAGE_SCHEMA_VERSION: u16 = 1;

/// Serializable accepted-memory import-apply review receipt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AcceptedMemoryReviewReceiptStorageRecord {
    pub schema_version: u16,
    pub review_receipt_id: String,
    pub project_id: String,
    pub command_id: String,
    pub operator_ref: String,
    pub approval_ref: Option<String>,
    pub decision_reason_ref: Option<String>,
    pub apply_admission_ref: String,
    pub import_admission_ref: String,
    pub conflict_ref: String,
    pub candidate_ref: String,
    pub memory_id: String,
    pub file_ref: String,
    #[serde(default)]
    pub provenance_refs: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    pub decision: AcceptedMemoryReviewReceiptDecisionStorage,
    pub status: AcceptedMemoryReviewReceiptStatusStorage,
    pub admission_status: AcceptedMemoryReviewReceiptAdmissionStatusStorage,
    #[serde(default)]
    pub blockers: Vec<AcceptedMemoryReviewReceiptBlockerStorage>,
    #[serde(default)]
    pub admission_blockers: Vec<AcceptedMemoryReviewReceiptAdmissionBlockerStorage>,
    pub reviewed_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Persisted review decision.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedMemoryReviewReceiptDecisionStorage {
    Approve,
    Defer,
    Reject,
}

/// Persisted review status.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedMemoryReviewReceiptStatusStorage {
    Approved,
    Deferred,
    Rejected,
    Blocked,
}

/// Persisted source apply-admission status.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedMemoryReviewReceiptAdmissionStatusStorage {
    Admitted,
    DuplicateNoop,
    Blocked,
}

/// Persisted review blocker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedMemoryReviewReceiptBlockerStorage {
    MissingCommandId,
    MissingOperatorRef,
    MissingApprovalRef,
    MissingDecisionReasonRef,
    MissingProvenanceRefs,
    MissingEvidenceRefs,
    MissingApplyAdmissionRef,
    MissingImportAdmissionRef,
    MissingConflictRef,
    MissingCandidateRef,
    MissingMemoryId,
    MissingFileRef,
    AdmissionNotAdmitted,
    AdmissionDuplicateNoop,
    AdmissionBlocked,
    AdmissionBlockersPresent,
    RawPayloadPresent,
    ActiveMemoryMutationRequested,
    ProjectionWriteRequested,
    ScmEffectRequested,
    EmbeddingRequested,
    ProviderSyncRequested,
    AutomaticExtractionRequested,
    TaskMutationRequested,
    AgentSchedulingRequested,
    UiEffectRequested,
}

/// Persisted source apply-admission blocker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedMemoryReviewReceiptAdmissionBlockerStorage {
    MissingRequestId,
    MissingOperatorRef,
    MissingApprovalRef,
    MissingProvenanceRefs,
    MissingEvidenceRefs,
    MissingImportAdmissionRef,
    MissingConflictRef,
    MissingCandidateRef,
    MissingMemoryId,
    MissingFileRef,
    DuplicateNoop,
    UnresolvedSemanticConflict,
    UnresolvedPolicyConflict,
    ImportConflictBlocked,
    RawPayloadPresent,
    ActiveMemoryMutationRequested,
    ProjectionWriteRequested,
    ScmEffectRequested,
    EmbeddingRequested,
    ProviderSyncRequested,
    AutomaticExtractionRequested,
    TaskMutationRequested,
    AgentSchedulingRequested,
    UiEffectRequested,
}

/// Accepted-memory review receipt storage codec error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryReviewReceiptRecordCodecError {
    pub reason: String,
}

/// Encode a review receipt storage record as JSON.
pub fn encode_accepted_memory_review_receipt_storage_payload(
    record: &AcceptedMemoryReviewReceiptStorageRecord,
) -> Result<Vec<u8>, AcceptedMemoryReviewReceiptRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

/// Decode a review receipt storage record from JSON.
pub fn decode_accepted_memory_review_receipt_storage_record(
    bytes: &[u8],
) -> Result<AcceptedMemoryReviewReceiptStorageRecord, AcceptedMemoryReviewReceiptRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

impl AcceptedMemoryReviewReceiptStorageRecord {
    /// Durable review receipts do not apply accepted memory by themselves.
    pub fn grants_active_apply_authority(&self) -> bool {
        false
    }

    /// Durable review receipts do not write projection files.
    pub fn grants_projection_write_authority(&self) -> bool {
        false
    }

    /// Durable review receipts do not grant SCM or forge authority.
    pub fn grants_scm_or_forge_authority(&self) -> bool {
        false
    }
}

fn codec_error(error: serde_json::Error) -> AcceptedMemoryReviewReceiptRecordCodecError {
    AcceptedMemoryReviewReceiptRecordCodecError {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_receipt_storage_codec_round_trips_record() {
        let record = storage_record();

        let encoded = encode_accepted_memory_review_receipt_storage_payload(&record).unwrap();
        let decoded = decode_accepted_memory_review_receipt_storage_record(&encoded).unwrap();

        assert_eq!(decoded, record);
        assert_eq!(
            decoded.schema_version,
            ACCEPTED_MEMORY_REVIEW_RECEIPT_STORAGE_SCHEMA_VERSION
        );
        assert_eq!(decoded.review_receipt_id, "accepted-memory-review:1");
        assert_eq!(
            decoded.decision,
            AcceptedMemoryReviewReceiptDecisionStorage::Approve
        );
        assert_eq!(
            decoded.status,
            AcceptedMemoryReviewReceiptStatusStorage::Approved
        );
    }

    #[test]
    fn review_receipt_storage_shape_excludes_raw_payload_fields() {
        let encoded = String::from_utf8(
            encode_accepted_memory_review_receipt_storage_payload(&storage_record()).unwrap(),
        )
        .unwrap();

        for forbidden in [
            "raw_transcript",
            "projection_payload",
            "provider_payload",
            "terminal_stream",
            "credential",
            "secret_value",
            "private_note",
            "memory_body",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "encoded review receipt leaked {forbidden}"
            );
        }
    }

    #[test]
    fn review_receipt_storage_grants_no_follow_on_authority() {
        let record = storage_record();

        assert!(!record.grants_active_apply_authority());
        assert!(!record.grants_projection_write_authority());
        assert!(!record.grants_scm_or_forge_authority());
    }

    #[test]
    fn decode_errors_are_reported() {
        let error = decode_accepted_memory_review_receipt_storage_record(b"{not-json")
            .expect_err("decode error");

        assert!(!error.reason.is_empty());
    }

    fn storage_record() -> AcceptedMemoryReviewReceiptStorageRecord {
        AcceptedMemoryReviewReceiptStorageRecord {
            schema_version: ACCEPTED_MEMORY_REVIEW_RECEIPT_STORAGE_SCHEMA_VERSION,
            review_receipt_id: "accepted-memory-review:1".to_owned(),
            project_id: "project:nucleus".to_owned(),
            command_id: "command:review:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            approval_ref: Some("approval:1".to_owned()),
            decision_reason_ref: None,
            apply_admission_ref: "apply-admission:1".to_owned(),
            import_admission_ref: "import-admission:1".to_owned(),
            conflict_ref: "conflict:1".to_owned(),
            candidate_ref: "candidate:1".to_owned(),
            memory_id: "memory:1".to_owned(),
            file_ref: "nucleus/memory/memory-1.toml".to_owned(),
            provenance_refs: vec!["provenance:1".to_owned()],
            evidence_refs: vec!["evidence:1".to_owned()],
            decision: AcceptedMemoryReviewReceiptDecisionStorage::Approve,
            status: AcceptedMemoryReviewReceiptStatusStorage::Approved,
            admission_status: AcceptedMemoryReviewReceiptAdmissionStatusStorage::Admitted,
            blockers: Vec::new(),
            admission_blockers: Vec::new(),
            reviewed_at: Some("2026-07-06T00:00:00Z".to_owned()),
            updated_at: None,
        }
    }
}
