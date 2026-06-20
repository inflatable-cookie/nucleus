//! Admission records for completion SCM capture preparation.

use serde::{Deserialize, Serialize};

use crate::{CompletionScmProviderNeutralReadinessStatus, CompletionScmReadModelRecord};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmCaptureAdmissionInput {
    pub read_model: CompletionScmReadModelRecord,
    pub request_id: String,
    pub readiness_id: String,
    pub candidate_id: String,
    pub task_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub capture_execution_requested: bool,
    pub publish_requested: bool,
    pub forge_change_request_requested: bool,
    pub merge_requested: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
    pub raw_material_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmCaptureAdmissionRecord {
    pub admission_id: String,
    pub request_id: String,
    pub readiness_id: String,
    pub candidate_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub status: CompletionScmCaptureAdmissionStatus,
    pub blockers: Vec<CompletionScmCaptureAdmissionBlocker>,
    pub capture_admitted: bool,
    pub scm_capture_executed: bool,
    pub scm_publish_executed: bool,
    pub forge_change_request_created: bool,
    pub forge_merge_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionScmCaptureAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionScmCaptureAdmissionBlocker {
    SourceHistoryMissing,
    ReadinessRefMissing,
    CandidateRefMismatch,
    TaskRefMismatch,
    OperatorRefMismatch,
    ReadinessUnsupported,
    ReadinessRepairRequired,
    EvidenceRefsMissing,
    EmptyEvidenceRef,
    CaptureExecutionRequested,
    PublishRequested,
    ForgeChangeRequestRequested,
    MergeRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
    RawMaterialRequested,
}

pub fn completion_scm_capture_admission(
    input: CompletionScmCaptureAdmissionInput,
) -> CompletionScmCaptureAdmissionRecord {
    let readiness = input
        .read_model
        .mapping
        .readiness
        .iter()
        .find(|readiness| readiness.readiness_id == input.readiness_id);
    let blockers = blockers(&input, readiness);
    let status = if blockers.is_empty() {
        CompletionScmCaptureAdmissionStatus::Admitted
    } else {
        CompletionScmCaptureAdmissionStatus::Blocked
    };
    let capture_admitted = status == CompletionScmCaptureAdmissionStatus::Admitted;

    CompletionScmCaptureAdmissionRecord {
        admission_id: format!("completion-scm-capture-admission:{}", input.request_id),
        request_id: input.request_id,
        readiness_id: input.readiness_id,
        candidate_id: input.candidate_id,
        task_id: input.task_id,
        work_item_id: readiness.map(|readiness| readiness.work_item_id.clone()),
        completion_id: readiness.map(|readiness| readiness.completion_id.clone()),
        operator_ref: input.operator_ref,
        evidence_refs: unique_sorted(input.evidence_refs),
        status,
        blockers,
        capture_admitted,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_change_request_created: false,
        forge_merge_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_material_exposed: false,
    }
}

fn blockers(
    input: &CompletionScmCaptureAdmissionInput,
    readiness: Option<&crate::CompletionScmProviderNeutralReadiness>,
) -> Vec<CompletionScmCaptureAdmissionBlocker> {
    let mut blockers = Vec::new();
    if !input.read_model.source_history_available {
        blockers.push(CompletionScmCaptureAdmissionBlocker::SourceHistoryMissing);
    }
    let Some(readiness) = readiness else {
        blockers.push(CompletionScmCaptureAdmissionBlocker::ReadinessRefMissing);
        external_blockers(input, &mut blockers);
        evidence_blockers(input, &mut blockers);
        return blockers;
    };
    if readiness.candidate_id != input.candidate_id {
        blockers.push(CompletionScmCaptureAdmissionBlocker::CandidateRefMismatch);
    }
    if readiness.task_id != input.task_id {
        blockers.push(CompletionScmCaptureAdmissionBlocker::TaskRefMismatch);
    }
    if readiness.operator_ref != input.operator_ref {
        blockers.push(CompletionScmCaptureAdmissionBlocker::OperatorRefMismatch);
    }
    match readiness.status {
        CompletionScmProviderNeutralReadinessStatus::Ready => {}
        CompletionScmProviderNeutralReadinessStatus::Unsupported => {
            blockers.push(CompletionScmCaptureAdmissionBlocker::ReadinessUnsupported);
        }
        CompletionScmProviderNeutralReadinessStatus::RepairRequired => {
            blockers.push(CompletionScmCaptureAdmissionBlocker::ReadinessRepairRequired);
        }
    }
    external_blockers(input, &mut blockers);
    evidence_blockers(input, &mut blockers);
    blockers
}

fn evidence_blockers(
    input: &CompletionScmCaptureAdmissionInput,
    blockers: &mut Vec<CompletionScmCaptureAdmissionBlocker>,
) {
    if input.evidence_refs.is_empty() {
        blockers.push(CompletionScmCaptureAdmissionBlocker::EvidenceRefsMissing);
    }
    if input
        .evidence_refs
        .iter()
        .any(|evidence_ref| evidence_ref.trim().is_empty())
    {
        blockers.push(CompletionScmCaptureAdmissionBlocker::EmptyEvidenceRef);
    }
}

fn external_blockers(
    input: &CompletionScmCaptureAdmissionInput,
    blockers: &mut Vec<CompletionScmCaptureAdmissionBlocker>,
) {
    if input.capture_execution_requested {
        blockers.push(CompletionScmCaptureAdmissionBlocker::CaptureExecutionRequested);
    }
    if input.publish_requested {
        blockers.push(CompletionScmCaptureAdmissionBlocker::PublishRequested);
    }
    if input.forge_change_request_requested {
        blockers.push(CompletionScmCaptureAdmissionBlocker::ForgeChangeRequestRequested);
    }
    if input.merge_requested {
        blockers.push(CompletionScmCaptureAdmissionBlocker::MergeRequested);
    }
    if input.provider_write_requested {
        blockers.push(CompletionScmCaptureAdmissionBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(CompletionScmCaptureAdmissionBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(CompletionScmCaptureAdmissionBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(CompletionScmCaptureAdmissionBlocker::RecoveryRequested);
    }
    if input.raw_material_requested {
        blockers.push(CompletionScmCaptureAdmissionBlocker::RawMaterialRequested);
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_scm_capture_admission_request_accepts_ready_refs() {
        let record = completion_scm_capture_admission(input(read_model(true, true), "readiness:1"));

        assert_eq!(record.status, CompletionScmCaptureAdmissionStatus::Admitted);
        assert!(record.capture_admitted);
        assert_eq!(record.work_item_id, Some("work:1".to_owned()));
        assert!(!record.scm_capture_executed);
        assert!(!record.forge_change_request_created);
    }

    #[test]
    fn completion_scm_readiness_ref_validation_blocks_missing_and_unsupported_refs() {
        let missing = completion_scm_capture_admission(input(read_model(true, true), "missing"));
        let unsupported =
            completion_scm_capture_admission(input(read_model(true, false), "readiness:1"));
        let no_source =
            completion_scm_capture_admission(input(read_model(false, true), "readiness:1"));

        assert!(missing
            .blockers
            .contains(&CompletionScmCaptureAdmissionBlocker::ReadinessRefMissing));
        assert!(unsupported
            .blockers
            .contains(&CompletionScmCaptureAdmissionBlocker::ReadinessUnsupported));
        assert!(no_source
            .blockers
            .contains(&CompletionScmCaptureAdmissionBlocker::SourceHistoryMissing));
        assert!(!unsupported.capture_admitted);
    }

    #[test]
    fn completion_scm_capture_authority_blocks_external_effect_requests() {
        let mut input = input(read_model(true, true), "readiness:1");
        input.capture_execution_requested = true;
        input.publish_requested = true;
        input.forge_change_request_requested = true;
        input.merge_requested = true;
        input.provider_write_requested = true;
        input.callback_response_requested = true;
        input.interruption_requested = true;
        input.recovery_requested = true;
        input.raw_material_requested = true;

        let record = completion_scm_capture_admission(input);

        assert!(record
            .blockers
            .contains(&CompletionScmCaptureAdmissionBlocker::CaptureExecutionRequested));
        assert!(record
            .blockers
            .contains(&CompletionScmCaptureAdmissionBlocker::ForgeChangeRequestRequested));
        assert!(record
            .blockers
            .contains(&CompletionScmCaptureAdmissionBlocker::RawMaterialRequested));
        assert!(!record.scm_capture_executed);
        assert!(!record.provider_write_executed);
        assert!(!record.raw_material_exposed);
    }

    fn input(
        read_model: CompletionScmReadModelRecord,
        readiness_id: &str,
    ) -> CompletionScmCaptureAdmissionInput {
        CompletionScmCaptureAdmissionInput {
            read_model,
            request_id: "request:1".to_owned(),
            readiness_id: readiness_id.to_owned(),
            candidate_id: "candidate:1".to_owned(),
            task_id: "task:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:capture".to_owned()],
            capture_execution_requested: false,
            publish_requested: false,
            forge_change_request_requested: false,
            merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            raw_material_requested: false,
        }
    }

    fn read_model(source_history_available: bool, ready: bool) -> CompletionScmReadModelRecord {
        CompletionScmReadModelRecord {
            read_model_id: "read-model:1".to_owned(),
            source_history_available,
            candidates: crate::CompletionScmPromotionCandidatesRecord {
                projection_id: "candidates".to_owned(),
                candidates: Vec::new(),
                skipped_history_entry_ids: Vec::new(),
                scm_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            mapping: crate::CompletionScmProviderNeutralMappingRecord {
                mapping_id: "mapping".to_owned(),
                readiness: vec![crate::CompletionScmProviderNeutralReadiness {
                    readiness_id: "readiness:1".to_owned(),
                    candidate_id: "candidate:1".to_owned(),
                    task_id: "task:1".to_owned(),
                    work_item_id: "work:1".to_owned(),
                    completion_id: "completion:1".to_owned(),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:readiness".to_owned()],
                    adapter_label: "adapter".to_owned(),
                    workflow_label: "workflow".to_owned(),
                    status: if ready {
                        CompletionScmProviderNeutralReadinessStatus::Ready
                    } else {
                        CompletionScmProviderNeutralReadinessStatus::Unsupported
                    },
                    blockers: Vec::new(),
                }],
                skipped_candidate_ids: Vec::new(),
                adapter_label: "adapter".to_owned(),
                workflow_label: "workflow".to_owned(),
                scm_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            diagnostics: crate::CompletionChangeRequestReadinessDiagnosticsRecord {
                diagnostics_id: "diagnostics".to_owned(),
                candidate_count: 1,
                skipped_candidate_count: 0,
                readiness_count: 1,
                ready_count: usize::from(ready),
                unsupported_count: usize::from(!ready),
                repair_required_count: 0,
                blocker_count: 0,
                scm_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            authority: crate::CompletionScmAuthorityRecord {
                authority_id: "authority".to_owned(),
                candidate_count: 1,
                readiness_count: 1,
                ready_count: usize::from(ready),
                scm_capture_started: false,
                scm_share_started: false,
                scm_publish_started: false,
                forge_change_request_started: false,
                forge_merge_started: false,
                provider_write_started: false,
                callback_response_started: false,
                interruption_started: false,
                recovery_started: false,
                raw_material_exposed: false,
            },
            scm_authority_granted: false,
            forge_authority_granted: false,
            provider_authority_granted: false,
            raw_material_exposed: false,
        }
    }
}
