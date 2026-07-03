use crate::{
    PlanningCapturePublicationAdapterFamily, PlanningCapturePublicationOperation,
    PlanningCapturePublicationStoppedRequestStatus,
};

use super::types::{
    PlanningCapturePublicationStoppedRequestDiagnosticBucket,
    PlanningCapturePublicationStoppedRequestDiagnostics,
    PlanningCapturePublicationStoppedRequestRecord,
};

pub fn planning_capture_publication_stopped_request_diagnostics(
    records: Vec<PlanningCapturePublicationStoppedRequestRecord>,
) -> PlanningCapturePublicationStoppedRequestDiagnostics {
    PlanningCapturePublicationStoppedRequestDiagnostics {
        diagnostics_id: "planning-capture-publication-stopped-request-diagnostics".to_owned(),
        request_count: records.len(),
        persisted_request_count: status_count(
            &records,
            PlanningCapturePublicationStoppedRequestStatus::Persisted,
        ),
        duplicate_request_count: status_count(
            &records,
            PlanningCapturePublicationStoppedRequestStatus::DuplicateNoop,
        ),
        blocked_request_count: status_count(
            &records,
            PlanningCapturePublicationStoppedRequestStatus::Blocked,
        ),
        blocker_count: records.iter().map(|record| record.blockers.len()).sum(),
        adapter_family_buckets: adapter_family_buckets(&records),
        operation_buckets: operation_buckets(&records),
        evidence_ref_count: records
            .iter()
            .map(|record| record.evidence_refs.len())
            .sum(),
        management_file_ref_count: records
            .iter()
            .map(|record| record.management_file_refs.len())
            .sum(),
        command_execution_permitted: false,
        runner_handoff_permitted: false,
        commit_permitted: false,
        snapshot_permitted: false,
        publish_permitted: false,
        push_permitted: false,
        forge_share_permitted: false,
        provider_write_permitted: false,
        projection_import_permitted: false,
        task_promotion_permitted: false,
        callback_response_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_payload_retained: false,
    }
}

fn status_count(
    records: &[PlanningCapturePublicationStoppedRequestRecord],
    status: PlanningCapturePublicationStoppedRequestStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

fn adapter_family_buckets(
    records: &[PlanningCapturePublicationStoppedRequestRecord],
) -> Vec<PlanningCapturePublicationStoppedRequestDiagnosticBucket> {
    let mut buckets = records
        .iter()
        .map(|record| label_for_adapter_family(&record.adapter_family))
        .fold(Vec::new(), add_bucket);
    buckets.sort_by(|left, right| left.label.cmp(&right.label));
    buckets
}

fn operation_buckets(
    records: &[PlanningCapturePublicationStoppedRequestRecord],
) -> Vec<PlanningCapturePublicationStoppedRequestDiagnosticBucket> {
    let mut buckets = records
        .iter()
        .map(|record| label_for_operation(&record.operation))
        .fold(Vec::new(), add_bucket);
    buckets.sort_by(|left, right| left.label.cmp(&right.label));
    buckets
}

fn add_bucket(
    mut buckets: Vec<PlanningCapturePublicationStoppedRequestDiagnosticBucket>,
    label: String,
) -> Vec<PlanningCapturePublicationStoppedRequestDiagnosticBucket> {
    if let Some(bucket) = buckets.iter_mut().find(|bucket| bucket.label == label) {
        bucket.count += 1;
    } else {
        buckets.push(PlanningCapturePublicationStoppedRequestDiagnosticBucket { label, count: 1 });
    }
    buckets
}

fn label_for_adapter_family(family: &PlanningCapturePublicationAdapterFamily) -> String {
    match family {
        PlanningCapturePublicationAdapterFamily::GitLike => "git_like".to_owned(),
        PlanningCapturePublicationAdapterFamily::SnapshotPublicationLike => {
            "snapshot_publication_like".to_owned()
        }
        PlanningCapturePublicationAdapterFamily::ForgeReviewLike => "forge_review_like".to_owned(),
        PlanningCapturePublicationAdapterFamily::Manual => "manual".to_owned(),
        PlanningCapturePublicationAdapterFamily::Custom(value) => format!("custom:{value}"),
    }
}

fn label_for_operation(operation: &PlanningCapturePublicationOperation) -> String {
    match operation {
        PlanningCapturePublicationOperation::Commit => "commit".to_owned(),
        PlanningCapturePublicationOperation::Snapshot => "snapshot".to_owned(),
        PlanningCapturePublicationOperation::Publish => "publish".to_owned(),
        PlanningCapturePublicationOperation::Push => "push".to_owned(),
        PlanningCapturePublicationOperation::ForgeShare => "forge_share".to_owned(),
        PlanningCapturePublicationOperation::ManualShare => "manual_share".to_owned(),
        PlanningCapturePublicationOperation::Custom(value) => format!("custom:{value}"),
    }
}
