use nucleus_projects::ProjectStorageRecord;
use nucleus_tasks::TaskStorageRecord;

use super::types::{
    ManagementProjectionEnvelope, ManagementProjectionExportEntry, ManagementProjectionExportPlan,
    ManagementProjectionFileRef, ManagementProjectionPayload, ManagementProjectionRecordId,
    ManagementProjectionRecordKind, ManagementProjectionRoot, ManagementProjectionSchemaVersion,
};

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
    }
}
