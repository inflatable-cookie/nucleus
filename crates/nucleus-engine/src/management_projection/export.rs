use nucleus_projects::ProjectStorageRecord;
use nucleus_tasks::TaskStorageRecord;

use super::types::{
    ManagementProjectionEnvelope, ManagementProjectionExportEntry, ManagementProjectionExportIssue,
    ManagementProjectionExportIssueKind, ManagementProjectionExportPlan,
    ManagementProjectionFileRef, ManagementProjectionFileRefError, ManagementProjectionPayload,
    ManagementProjectionPlanningArtifactRecord, ManagementProjectionPlanningExportDiagnostics,
    ManagementProjectionPlanningTaskSeedRecord, ManagementProjectionRecordId,
    ManagementProjectionRecordKind, ManagementProjectionRoot, ManagementProjectionSchemaVersion,
};
use crate::{EnginePlanningArtifactRecord, EngineTaskSeedCandidateRecord};

pub fn export_project_task_projection(
    projects: &[ProjectStorageRecord],
    tasks: &[TaskStorageRecord],
) -> ManagementProjectionExportPlan {
    let mut entries = Vec::new();

    for project in projects {
        entries.push(ManagementProjectionExportEntry {
            envelope: ManagementProjectionEnvelope {
                schema_version: ManagementProjectionSchemaVersion::current(),
                record_id: ManagementProjectionRecordId(project.project_id.clone()),
                record_kind: ManagementProjectionRecordKind::Project,
                file_ref: ManagementProjectionFileRef::project(),
            },
            payload: ManagementProjectionPayload::Project(project.clone()),
        });
    }

    for task in tasks {
        entries.push(ManagementProjectionExportEntry {
            envelope: ManagementProjectionEnvelope {
                schema_version: ManagementProjectionSchemaVersion::current(),
                record_id: ManagementProjectionRecordId(task.task_id.clone()),
                record_kind: ManagementProjectionRecordKind::Task,
                file_ref: ManagementProjectionFileRef::task(&task.task_id),
            },
            payload: ManagementProjectionPayload::Task(task.clone()),
        });
    }
    entries.sort_by(|left, right| {
        left.envelope
            .file_ref
            .0
            .cmp(&right.envelope.file_ref.0)
            .then_with(|| left.envelope.record_id.0.cmp(&right.envelope.record_id.0))
    });

    ManagementProjectionExportPlan {
        root: ManagementProjectionRoot::default(),
        entries,
        issues: Vec::new(),
    }
}

pub fn export_project_planning_projection(
    artifacts: &[EnginePlanningArtifactRecord],
    task_seeds: &[EngineTaskSeedCandidateRecord],
) -> ManagementProjectionExportPlan {
    let mut entries = Vec::new();
    let mut issues = Vec::new();

    for artifact in artifacts {
        match ManagementProjectionFileRef::try_planning_artifact(&artifact.artifact_id.0) {
            Ok(file_ref) => entries.push(ManagementProjectionExportEntry {
                envelope: ManagementProjectionEnvelope {
                    schema_version: ManagementProjectionSchemaVersion::current(),
                    record_id: ManagementProjectionRecordId(artifact.artifact_id.0.clone()),
                    record_kind: ManagementProjectionRecordKind::PlanningArtifact,
                    file_ref,
                },
                payload: ManagementProjectionPayload::PlanningArtifact(
                    ManagementProjectionPlanningArtifactRecord::from(artifact),
                ),
            }),
            Err(error) => issues.push(invalid_file_ref_issue(
                &artifact.artifact_id.0,
                "artifact_id",
                error,
            )),
        }
    }

    for task_seed in task_seeds {
        match ManagementProjectionFileRef::try_planning_task_seed(&task_seed.seed_id.0) {
            Ok(file_ref) => entries.push(ManagementProjectionExportEntry {
                envelope: ManagementProjectionEnvelope {
                    schema_version: ManagementProjectionSchemaVersion::current(),
                    record_id: ManagementProjectionRecordId(task_seed.seed_id.0.clone()),
                    record_kind: ManagementProjectionRecordKind::PlanningTaskSeed,
                    file_ref,
                },
                payload: ManagementProjectionPayload::PlanningTaskSeed(
                    ManagementProjectionPlanningTaskSeedRecord::from(task_seed),
                ),
            }),
            Err(error) => issues.push(invalid_file_ref_issue(
                &task_seed.seed_id.0,
                "seed_id",
                error,
            )),
        }
    }

    entries.sort_by(|left, right| {
        left.envelope
            .file_ref
            .0
            .cmp(&right.envelope.file_ref.0)
            .then_with(|| left.envelope.record_id.0.cmp(&right.envelope.record_id.0))
    });
    issues.sort_by(|left, right| {
        left.record_id
            .as_ref()
            .map(|record_id| record_id.0.as_str())
            .cmp(
                &right
                    .record_id
                    .as_ref()
                    .map(|record_id| record_id.0.as_str()),
            )
            .then_with(|| left.summary.cmp(&right.summary))
    });

    ManagementProjectionExportPlan {
        root: ManagementProjectionRoot::default(),
        entries,
        issues,
    }
}

pub fn planning_projection_export_diagnostics(
    plan: &ManagementProjectionExportPlan,
) -> ManagementProjectionPlanningExportDiagnostics {
    let exportable_planning_artifacts = plan
        .entries
        .iter()
        .filter(|entry| {
            entry.envelope.record_kind == ManagementProjectionRecordKind::PlanningArtifact
        })
        .count();
    let exportable_planning_task_seeds = plan
        .entries
        .iter()
        .filter(|entry| {
            entry.envelope.record_kind == ManagementProjectionRecordKind::PlanningTaskSeed
        })
        .count();
    let unsupported_records = plan
        .issues
        .iter()
        .filter(|issue| issue.kind == ManagementProjectionExportIssueKind::UnsupportedRecord)
        .count();
    let decode_failed_records = plan
        .issues
        .iter()
        .filter(|issue| issue.kind == ManagementProjectionExportIssueKind::DecodeFailed)
        .count();

    ManagementProjectionPlanningExportDiagnostics {
        exportable_planning_artifacts,
        exportable_planning_task_seeds,
        blocked_records: plan.issues.len(),
        unsupported_records,
        decode_failed_records,
        file_write_authority: false,
        scm_mutation_authority: false,
    }
}

fn invalid_file_ref_issue(
    record_id: &str,
    field: &str,
    error: ManagementProjectionFileRefError,
) -> ManagementProjectionExportIssue {
    ManagementProjectionExportIssue {
        kind: ManagementProjectionExportIssueKind::InvalidFileRef,
        record_id: Some(ManagementProjectionRecordId(record_id.to_owned())),
        field: Some(field.to_owned()),
        summary: error.reason,
    }
}
