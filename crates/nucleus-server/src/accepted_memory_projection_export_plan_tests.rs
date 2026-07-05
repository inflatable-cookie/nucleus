use nucleus_memory::{
    AcceptedMemoryStorageActors, AcceptedMemoryStorageBody, AcceptedMemoryStorageRecord,
    AcceptedMemoryStorageReview, AcceptedMemoryStorageStatus,
    AcceptedMemorySupersessionStorageRefs, MemoryConfidenceStorage, MemoryLinkStorageRefs,
    MemoryProposalStorageKind, MemoryProposalStorageScope, MemoryRetentionStoragePosture,
    MemorySensitivityStorage, ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_export_plan::{
    accepted_memory_projection_export_entry, accepted_memory_projection_export_plan,
    accepted_memory_projection_file_ref, accepted_memory_projection_plan_ref,
    AcceptedMemoryProjectionExportBlocker, AcceptedMemoryProjectionExportStatus,
};
use crate::accepted_memory_projection_policy::{
    AcceptedMemoryProjectionPolicyBlocker, AcceptedMemoryProjectionPolicyStatus,
};

#[test]
fn projectable_memory_produces_stopped_stable_export_refs_without_effects() {
    let record = accepted_memory("memory:projectable");
    let entry =
        accepted_memory_projection_export_entry(&ProjectId("project:nucleus".to_owned()), &record);

    assert_eq!(entry.status, AcceptedMemoryProjectionExportStatus::Stopped);
    assert_eq!(
        entry.plan_ref,
        "accepted-memory-export-plan:memory:projectable"
    );
    assert_eq!(
        entry.file_ref.as_deref(),
        Some("nucleus/memory/memory:projectable.toml")
    );
    assert_eq!(
        entry.policy_status,
        AcceptedMemoryProjectionPolicyStatus::Projectable
    );
    assert!(entry.policy_blockers.is_empty());
    assert!(entry.export_blockers.is_empty());
    assert!(!entry.projection_write_performed);
    assert!(!entry.scm_effect_performed);
}

#[test]
fn blocked_policy_records_preserve_sanitized_blocker_diagnostics() {
    let mut record = accepted_memory("memory:private");
    record.sensitivity = MemorySensitivityStorage::Restricted;

    let entry =
        accepted_memory_projection_export_entry(&ProjectId("project:nucleus".to_owned()), &record);

    assert_eq!(entry.status, AcceptedMemoryProjectionExportStatus::Blocked);
    assert!(entry.file_ref.is_none());
    assert_eq!(
        entry.policy_status,
        AcceptedMemoryProjectionPolicyStatus::Blocked
    );
    assert!(entry
        .policy_blockers
        .contains(&AcceptedMemoryProjectionPolicyBlocker::RestrictedSensitivity));
    assert!(entry
        .export_blockers
        .contains(&AcceptedMemoryProjectionExportBlocker::PolicyDenied));
    assert!(!format!("{entry:?}").contains("Hidden accepted memory summary"));
}

#[test]
fn unsupported_schema_and_kind_block_export_refs() {
    let mut record = accepted_memory("memory:unsupported");
    record.schema_version = 999;
    record.kind = MemoryProposalStorageKind::Other {
        label: "provider_native_blob".to_owned(),
    };

    let entry =
        accepted_memory_projection_export_entry(&ProjectId("project:nucleus".to_owned()), &record);

    assert_eq!(entry.status, AcceptedMemoryProjectionExportStatus::Blocked);
    assert!(entry.file_ref.is_none());
    assert!(entry.export_blockers.contains(
        &AcceptedMemoryProjectionExportBlocker::UnsupportedSchema {
            schema_version: 999
        }
    ));
    assert!(entry.export_blockers.contains(
        &AcceptedMemoryProjectionExportBlocker::UnsupportedMemoryKind {
            kind: "provider_native_blob".to_owned()
        }
    ));
}

#[test]
fn unsafe_memory_id_is_blocked_before_projection_path_is_returned() {
    let entry = accepted_memory_projection_export_entry(
        &ProjectId("project:nucleus".to_owned()),
        &accepted_memory("../memory:bad"),
    );

    assert_eq!(entry.status, AcceptedMemoryProjectionExportStatus::Blocked);
    assert!(entry.file_ref.is_none());
    assert!(entry
        .export_blockers
        .contains(&AcceptedMemoryProjectionExportBlocker::PolicyDenied));
}

#[test]
fn export_plan_collects_entries_without_writes_or_scm_effects() {
    let plan = accepted_memory_projection_export_plan(
        ProjectId("project:nucleus".to_owned()),
        vec![accepted_memory("memory:one"), accepted_memory("memory:two")],
    );

    assert_eq!(plan.project_id.0, "project:nucleus");
    assert_eq!(plan.entries.len(), 2);
    assert!(plan
        .entries
        .iter()
        .all(|entry| entry.status == AcceptedMemoryProjectionExportStatus::Stopped));
    assert!(!plan.projection_write_performed);
    assert!(!plan.scm_effect_performed);
}

#[test]
fn path_and_plan_ref_helpers_are_deterministic_and_path_safe() {
    assert_eq!(
        accepted_memory_projection_file_ref("memory:1").as_deref(),
        Ok("nucleus/memory/memory:1.toml")
    );
    assert!(accepted_memory_projection_file_ref("../memory:1").is_err());
    assert_eq!(
        accepted_memory_projection_plan_ref("memory:1"),
        "accepted-memory-export-plan:memory:1"
    );
}

fn accepted_memory(memory_id: &str) -> AcceptedMemoryStorageRecord {
    AcceptedMemoryStorageRecord {
        schema_version: ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
        memory_id: memory_id.to_owned(),
        source_proposal_id: Some("memory-proposal:1".to_owned()),
        scope: MemoryProposalStorageScope::Project {
            project_ref: "project:nucleus".to_owned(),
        },
        kind: MemoryProposalStorageKind::Decision,
        status: AcceptedMemoryStorageStatus::Accepted,
        title: "Hidden accepted memory title".to_owned(),
        body: AcceptedMemoryStorageBody::Summary {
            summary: "Hidden accepted memory summary".to_owned(),
            detail: Some("Hidden accepted memory detail".to_owned()),
        },
        source_refs: Vec::new(),
        link_refs: MemoryLinkStorageRefs::default(),
        confidence: MemoryConfidenceStorage::High,
        sensitivity: MemorySensitivityStorage::InternalProject,
        retention: MemoryRetentionStoragePosture::ProjectContextCandidate,
        actors: AcceptedMemoryStorageActors {
            created_by_ref: "agent:steward".to_owned(),
            accepted_by_ref: "operator:tom".to_owned(),
        },
        review: AcceptedMemoryStorageReview {
            reviewer_ref: "operator:tom".to_owned(),
            note: Some("Reviewed for export plan.".to_owned()),
        },
        supersession: AcceptedMemorySupersessionStorageRefs::default(),
        created_at: Some("2026-07-05T00:00:00Z".to_owned()),
        accepted_at: Some("2026-07-05T00:00:00Z".to_owned()),
        updated_at: None,
    }
}
