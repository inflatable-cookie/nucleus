use std::path::{Component, Path, PathBuf};

use nucleus_engine::{
    decode_management_projection_file_document, validate_projection_file_document,
    ManagementProjectionFileRef, ManagementProjectionPayload, ManagementProjectionRecordId,
    ManagementProjectionRecordKind, ManagementProjectionValidationStatus,
};

use super::types::{
    PlanningProjectionImportScanBlocker, PlanningProjectionImportScanCandidate,
    PlanningProjectionImportScanCandidateStatus, PlanningProjectionImportScanReport,
    PlanningProjectionImportScanRequest,
};

pub fn scan_planning_projection_import_candidates(
    request: PlanningProjectionImportScanRequest,
) -> PlanningProjectionImportScanReport {
    let candidates = request
        .file_refs
        .iter()
        .map(|file_ref| scan_candidate(&request.repo_root, file_ref.clone()))
        .collect();

    PlanningProjectionImportScanReport {
        repo_root: request.repo_root,
        candidates,
        active_planning_mutation_performed: false,
        task_creation_performed: false,
        task_promotion_performed: false,
        agent_scheduling_performed: false,
        provider_execution_performed: false,
        scm_mutation_performed: false,
        forge_mutation_performed: false,
        raw_payload_retained: false,
        ui_apply_triggered: false,
    }
}

fn scan_candidate(
    repo_root: &Path,
    file_ref: ManagementProjectionFileRef,
) -> PlanningProjectionImportScanCandidate {
    let path = repo_root.join(Path::new(&file_ref.0));
    let expected_kind = match expected_planning_record_kind(&file_ref) {
        Ok(kind) => kind,
        Err(blocker) => return blocked_candidate(file_ref, path, None, None, blocker),
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return blocked_candidate(
                file_ref,
                path,
                None,
                Some(expected_kind),
                PlanningProjectionImportScanBlocker::ParseFailed {
                    summary: format!("read failed: {error}"),
                },
            );
        }
    };
    let document = match decode_management_projection_file_document(&bytes) {
        Ok(document) => document,
        Err(error) => {
            return blocked_candidate(
                file_ref,
                path,
                None,
                Some(expected_kind),
                PlanningProjectionImportScanBlocker::ParseFailed {
                    summary: format!("decode failed: {}", error.reason),
                },
            );
        }
    };
    let record_id = Some(document.envelope.record_id.clone());
    let record_kind = Some(document.envelope.record_kind.clone());

    if document.envelope.record_kind != expected_kind
        || !payload_matches(&expected_kind, &document.payload)
    {
        return blocked_candidate(
            file_ref,
            path,
            record_id,
            record_kind,
            PlanningProjectionImportScanBlocker::UnsupportedRecordKind {
                summary: "planning projection file ref does not match planning payload kind"
                    .to_owned(),
            },
        );
    }

    let validation = validate_projection_file_document(&document, &[]);
    match validation.status {
        ManagementProjectionValidationStatus::Valid
        | ManagementProjectionValidationStatus::ValidWithWarnings => {
            PlanningProjectionImportScanCandidate {
                candidate_id: candidate_id(&file_ref),
                evidence_refs: evidence_refs(&file_ref),
                file_ref,
                path,
                record_id,
                record_kind,
                status: PlanningProjectionImportScanCandidateStatus::Ready,
                blockers: Vec::new(),
            }
        }
        ManagementProjectionValidationStatus::UnsupportedSchema => blocked_candidate(
            file_ref,
            path,
            record_id,
            record_kind,
            PlanningProjectionImportScanBlocker::UnsupportedSchema {
                summary: validation_summary(&validation),
            },
        ),
        ManagementProjectionValidationStatus::Invalid => blocked_candidate(
            file_ref,
            path,
            record_id,
            record_kind,
            PlanningProjectionImportScanBlocker::ParseFailed {
                summary: validation_summary(&validation),
            },
        ),
    }
}

fn expected_planning_record_kind(
    file_ref: &ManagementProjectionFileRef,
) -> Result<ManagementProjectionRecordKind, PlanningProjectionImportScanBlocker> {
    if is_unsafe_ref(file_ref) {
        return Err(PlanningProjectionImportScanBlocker::UnsafePath {
            summary: "planning projection file ref must stay under nucleus/".to_owned(),
        });
    }

    let value = file_ref.0.as_str();
    if let Some(stem) = value
        .strip_prefix("nucleus/planning/task-seeds/")
        .and_then(|value| value.strip_suffix(".toml"))
    {
        return non_empty_single_segment(stem, ManagementProjectionRecordKind::PlanningTaskSeed);
    }
    if let Some(stem) = value
        .strip_prefix("nucleus/planning/")
        .and_then(|value| value.strip_suffix(".toml"))
    {
        return non_empty_single_segment(stem, ManagementProjectionRecordKind::PlanningArtifact);
    }

    Err(PlanningProjectionImportScanBlocker::UnsupportedRecordKind {
        summary: "planning projection import only supports nucleus/planning/*.toml and nucleus/planning/task-seeds/*.toml".to_owned(),
    })
}

fn non_empty_single_segment(
    stem: &str,
    kind: ManagementProjectionRecordKind,
) -> Result<ManagementProjectionRecordKind, PlanningProjectionImportScanBlocker> {
    if stem.is_empty() || stem.contains('/') {
        return Err(PlanningProjectionImportScanBlocker::UnsupportedRecordKind {
            summary: "planning projection file ref must name one record".to_owned(),
        });
    }
    Ok(kind)
}

fn is_unsafe_ref(file_ref: &ManagementProjectionFileRef) -> bool {
    let relative = Path::new(&file_ref.0);
    relative.is_absolute()
        || !file_ref.0.starts_with("nucleus/")
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

fn payload_matches(
    expected_kind: &ManagementProjectionRecordKind,
    payload: &ManagementProjectionPayload,
) -> bool {
    matches!(
        (expected_kind, payload),
        (
            ManagementProjectionRecordKind::PlanningArtifact,
            ManagementProjectionPayload::PlanningArtifact(_)
        ) | (
            ManagementProjectionRecordKind::PlanningTaskSeed,
            ManagementProjectionPayload::PlanningTaskSeed(_)
        )
    )
}

fn blocked_candidate(
    file_ref: ManagementProjectionFileRef,
    path: PathBuf,
    record_id: Option<ManagementProjectionRecordId>,
    record_kind: Option<ManagementProjectionRecordKind>,
    blocker: PlanningProjectionImportScanBlocker,
) -> PlanningProjectionImportScanCandidate {
    PlanningProjectionImportScanCandidate {
        candidate_id: candidate_id(&file_ref),
        evidence_refs: evidence_refs(&file_ref),
        file_ref,
        path,
        record_id,
        record_kind,
        status: PlanningProjectionImportScanCandidateStatus::Blocked,
        blockers: vec![blocker],
    }
}

fn candidate_id(file_ref: &ManagementProjectionFileRef) -> String {
    format!("planning-projection-import-candidate:{}", file_ref.0)
}

fn evidence_refs(file_ref: &ManagementProjectionFileRef) -> Vec<String> {
    vec![format!("management-file-ref:{}", file_ref.0)]
}

fn validation_summary(report: &nucleus_engine::ManagementProjectionValidationReport) -> String {
    report
        .issues
        .iter()
        .map(|issue| issue.summary.clone())
        .collect::<Vec<_>>()
        .join("; ")
}
