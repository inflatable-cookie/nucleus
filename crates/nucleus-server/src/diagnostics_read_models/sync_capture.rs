use serde::{Deserialize, Serialize};

use nucleus_engine::{
    ManagementProjectionCaptureAdmission, ManagementProjectionCapturePrepRecord,
    ManagementProjectionCaptureShareReadiness,
};

use super::helpers::{source_status, source_summary};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncCaptureReviewModelDto {
    pub capture_preps: Vec<SyncCapturePrepReviewDto>,
    pub admissions: Vec<SyncCaptureAdmissionReviewDto>,
    pub client_can_mutate: bool,
    pub client_can_mutate_provider: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncCapturePrepReviewDto {
    pub prep_id: String,
    pub plan_id: String,
    pub status: String,
    pub share_readiness: String,
    pub file_refs: Vec<String>,
    pub receipt_ids: Vec<String>,
    pub review_summary_refs: Vec<String>,
    pub next_actions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncCaptureAdmissionReviewDto {
    pub command_id: String,
    pub status: String,
    pub admitted_file_refs: Vec<String>,
    pub evidence_file_refs: Vec<String>,
    pub evidence_receipt_ids: Vec<String>,
    pub blocked_reasons: Vec<String>,
    pub provider_mutation_allowed: bool,
}

pub fn management_capture_review_model(
    capture_preps: &[ManagementProjectionCapturePrepRecord],
    admissions: &[ManagementProjectionCaptureAdmission],
) -> SyncCaptureReviewModelDto {
    let record_count = capture_preps.len() + admissions.len();
    SyncCaptureReviewModelDto {
        capture_preps: capture_preps
            .iter()
            .map(SyncCapturePrepReviewDto::from)
            .collect(),
        admissions: admissions
            .iter()
            .map(SyncCaptureAdmissionReviewDto::from)
            .collect(),
        client_can_mutate: false,
        client_can_mutate_provider: false,
        source_status: source_status(record_count),
        source_summary: Some(source_summary(
            record_count,
            "management capture review state is empty",
            "management capture review state loaded from capture prep records",
        )),
    }
}

impl From<&ManagementProjectionCapturePrepRecord> for SyncCapturePrepReviewDto {
    fn from(prep: &ManagementProjectionCapturePrepRecord) -> Self {
        let share_readiness = prep.share_readiness();
        Self {
            prep_id: prep.prep_id.0.clone(),
            plan_id: prep.plan_id.0.clone(),
            status: format!("{:?}", prep.status),
            share_readiness: format!("{share_readiness:?}"),
            file_refs: prep.file_refs.iter().map(|file| file.0.clone()).collect(),
            receipt_ids: prep
                .receipt_ids
                .iter()
                .map(|receipt| receipt.0.clone())
                .collect(),
            review_summary_refs: prep.assistance_refs.clone(),
            next_actions: next_actions(&share_readiness),
        }
    }
}

impl From<&ManagementProjectionCaptureAdmission> for SyncCaptureAdmissionReviewDto {
    fn from(admission: &ManagementProjectionCaptureAdmission) -> Self {
        Self {
            command_id: admission.command_id.0.clone(),
            status: format!("{:?}", admission.status),
            admitted_file_refs: admission
                .admitted_file_refs
                .iter()
                .map(|file| file.0.clone())
                .collect(),
            evidence_file_refs: admission
                .evidence
                .projection_file_refs
                .iter()
                .map(|file| file.0.clone())
                .collect(),
            evidence_receipt_ids: admission
                .evidence
                .apply_receipt_ids
                .iter()
                .map(|receipt| receipt.0.clone())
                .collect(),
            blocked_reasons: admission.evidence.blocked_reasons.clone(),
            provider_mutation_allowed: admission.provider_mutation_allowed,
        }
    }
}

fn next_actions(readiness: &ManagementProjectionCaptureShareReadiness) -> Vec<String> {
    match readiness {
        ManagementProjectionCaptureShareReadiness::ReadyForReviewBoundary => {
            vec!["review_capture_evidence".to_owned()]
        }
        ManagementProjectionCaptureShareReadiness::NeedsReview => {
            vec!["complete_capture_review".to_owned()]
        }
        ManagementProjectionCaptureShareReadiness::Blocked(_) => {
            vec!["resolve_capture_blockers".to_owned()]
        }
    }
}
