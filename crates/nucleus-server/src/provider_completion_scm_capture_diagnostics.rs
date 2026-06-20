//! Read-only diagnostics for completion SCM capture admissions.

use serde::{Deserialize, Serialize};

use crate::{
    CompletionScmCaptureAdmissionBlocker, CompletionScmCaptureAdmissionRecord,
    CompletionScmCaptureAdmissionStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmCaptureAdmissionDiagnosticsInput {
    pub admissions: Vec<CompletionScmCaptureAdmissionRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmCaptureAdmissionDiagnosticsRecord {
    pub diagnostics_id: String,
    pub admission_count: usize,
    pub admitted_count: usize,
    pub blocked_count: usize,
    pub blocker_count: usize,
    pub external_effect_blocker_count: usize,
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

pub fn completion_scm_capture_admission_diagnostics(
    input: CompletionScmCaptureAdmissionDiagnosticsInput,
) -> CompletionScmCaptureAdmissionDiagnosticsRecord {
    let admitted_count = input
        .admissions
        .iter()
        .filter(|admission| admission.status == CompletionScmCaptureAdmissionStatus::Admitted)
        .count();
    let blocker_count = input
        .admissions
        .iter()
        .map(|admission| admission.blockers.len())
        .sum();
    let external_effect_blocker_count = input
        .admissions
        .iter()
        .flat_map(|admission| admission.blockers.iter())
        .filter(|blocker| is_external_effect_blocker(blocker))
        .count();

    CompletionScmCaptureAdmissionDiagnosticsRecord {
        diagnostics_id: "completion-scm-capture-admission-diagnostics".to_owned(),
        admission_count: input.admissions.len(),
        admitted_count,
        blocked_count: input.admissions.len() - admitted_count,
        blocker_count,
        external_effect_blocker_count,
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

fn is_external_effect_blocker(blocker: &CompletionScmCaptureAdmissionBlocker) -> bool {
    matches!(
        blocker,
        CompletionScmCaptureAdmissionBlocker::CaptureExecutionRequested
            | CompletionScmCaptureAdmissionBlocker::PublishRequested
            | CompletionScmCaptureAdmissionBlocker::ForgeChangeRequestRequested
            | CompletionScmCaptureAdmissionBlocker::MergeRequested
            | CompletionScmCaptureAdmissionBlocker::ProviderWriteRequested
            | CompletionScmCaptureAdmissionBlocker::CallbackResponseRequested
            | CompletionScmCaptureAdmissionBlocker::InterruptionRequested
            | CompletionScmCaptureAdmissionBlocker::RecoveryRequested
            | CompletionScmCaptureAdmissionBlocker::RawMaterialRequested
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_scm_capture_admission_diagnostics_summarize_admissions() {
        let diagnostics = completion_scm_capture_admission_diagnostics(
            CompletionScmCaptureAdmissionDiagnosticsInput {
                admissions: vec![
                    admission(CompletionScmCaptureAdmissionStatus::Admitted, Vec::new()),
                    admission(
                        CompletionScmCaptureAdmissionStatus::Blocked,
                        vec![
                            CompletionScmCaptureAdmissionBlocker::ReadinessUnsupported,
                            CompletionScmCaptureAdmissionBlocker::CaptureExecutionRequested,
                        ],
                    ),
                ],
            },
        );

        assert_eq!(diagnostics.admission_count, 2);
        assert_eq!(diagnostics.admitted_count, 1);
        assert_eq!(diagnostics.blocked_count, 1);
        assert_eq!(diagnostics.blocker_count, 2);
        assert_eq!(diagnostics.external_effect_blocker_count, 1);
        assert!(!diagnostics.scm_capture_executed);
        assert!(!diagnostics.raw_material_exposed);
    }

    fn admission(
        status: CompletionScmCaptureAdmissionStatus,
        blockers: Vec<CompletionScmCaptureAdmissionBlocker>,
    ) -> CompletionScmCaptureAdmissionRecord {
        CompletionScmCaptureAdmissionRecord {
            admission_id: "admission:1".to_owned(),
            request_id: "request:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            candidate_id: "candidate:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:capture".to_owned()],
            capture_admitted: status == CompletionScmCaptureAdmissionStatus::Admitted,
            status,
            blockers,
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
}
