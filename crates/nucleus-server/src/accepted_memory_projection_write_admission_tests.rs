use nucleus_memory::{MemoryProposalStorageKind, MemorySensitivityStorage};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_export_plan::{
    accepted_memory_projection_export_entry, accepted_memory_projection_export_plan,
    AcceptedMemoryProjectionExportStatus,
};
use crate::accepted_memory_projection_policy::AcceptedMemoryProjectionPolicyStatus;
use crate::accepted_memory_projection_test_fixtures::accepted_memory;
use crate::accepted_memory_projection_write_admission::{
    accepted_memory_projection_write_admission, accepted_memory_projection_write_admissions,
    AcceptedMemoryProjectionWriteAdmissionBlocker, AcceptedMemoryProjectionWriteAdmissionStatus,
};

#[test]
fn projectable_export_entry_is_admitted_without_effects() {
    let entry = accepted_memory_projection_export_entry(
        &ProjectId("project:nucleus".to_owned()),
        &accepted_memory("memory:admitted"),
    );

    let admission = accepted_memory_projection_write_admission(entry);

    assert_eq!(
        admission.status,
        AcceptedMemoryProjectionWriteAdmissionStatus::Admitted
    );
    assert_eq!(admission.memory_id, "memory:admitted");
    assert_eq!(
        admission.file_ref.as_deref(),
        Some("nucleus/memory/memory:admitted.toml")
    );
    assert!(admission.admission_blockers.is_empty());
    assert!(!admission.projection_write_performed);
    assert!(!admission.scm_effect_performed);
    assert!(!admission.import_or_apply_performed);
    assert!(!admission.embedding_available);
    assert!(!admission.provider_sync_available);
    assert!(!admission.task_mutation_performed);
    assert!(!admission.ui_effect_performed);
}

#[test]
fn non_projectable_and_unsupported_records_are_blocked_before_write_admission() {
    let mut restricted = accepted_memory("memory:restricted");
    restricted.sensitivity = MemorySensitivityStorage::Restricted;

    let mut unsupported = accepted_memory("memory:unsupported");
    unsupported.kind = MemoryProposalStorageKind::Other {
        label: "provider_native_blob".to_owned(),
    };

    for record in [restricted, unsupported] {
        let admission =
            accepted_memory_projection_write_admission(accepted_memory_projection_export_entry(
                &ProjectId("project:nucleus".to_owned()),
                &record,
            ));

        assert_eq!(
            admission.status,
            AcceptedMemoryProjectionWriteAdmissionStatus::Blocked
        );
        assert!(admission.admission_blockers.iter().any(|blocker| matches!(
            blocker,
            AcceptedMemoryProjectionWriteAdmissionBlocker::PolicyNotProjectable { .. }
                | AcceptedMemoryProjectionWriteAdmissionBlocker::ExportBlockersPresent
        )));
        assert!(!admission.projection_write_performed);
        assert!(!admission.scm_effect_performed);
    }
}

#[test]
fn tampered_refs_and_prior_effects_block_write_admission() {
    let mut entry = accepted_memory_projection_export_entry(
        &ProjectId("project:nucleus".to_owned()),
        &accepted_memory("memory:tampered"),
    );
    entry.plan_ref = "accepted-memory-export-plan:other".to_owned();
    entry.file_ref = Some("nucleus/other/memory:tampered.toml".to_owned());
    entry.projection_write_performed = true;
    entry.scm_effect_performed = true;

    let admission = accepted_memory_projection_write_admission(entry);

    assert_eq!(
        admission.status,
        AcceptedMemoryProjectionWriteAdmissionStatus::Blocked
    );
    assert!(admission.admission_blockers.contains(
        &AcceptedMemoryProjectionWriteAdmissionBlocker::PlanRefMismatch {
            expected: "accepted-memory-export-plan:memory:tampered".to_owned()
        }
    ));
    assert!(admission.admission_blockers.contains(
        &AcceptedMemoryProjectionWriteAdmissionBlocker::UnsafeFileRef {
            reason: "file ref is outside nucleus/memory projection root".to_owned()
        }
    ));
    assert!(admission
        .admission_blockers
        .contains(&AcceptedMemoryProjectionWriteAdmissionBlocker::PriorProjectionWriteObserved));
    assert!(admission
        .admission_blockers
        .contains(&AcceptedMemoryProjectionWriteAdmissionBlocker::PriorScmEffectObserved));
}

#[test]
fn write_admission_set_counts_admitted_and_blocked_entries_without_effects() {
    let mut blocked = accepted_memory("memory:blocked");
    blocked.sensitivity = MemorySensitivityStorage::Restricted;

    let plan = accepted_memory_projection_export_plan(
        ProjectId("project:nucleus".to_owned()),
        vec![accepted_memory("memory:ready"), blocked],
    );

    let set = accepted_memory_projection_write_admissions(plan);

    assert_eq!(set.project_id.0, "project:nucleus");
    assert_eq!(set.counts.entries, 2);
    assert_eq!(set.counts.admitted_writes, 1);
    assert_eq!(set.counts.blocked_writes, 1);
    assert!(!set.projection_write_performed);
    assert!(!set.scm_effect_performed);
    assert!(!set.import_or_apply_performed);
    assert!(!set.embedding_available);
    assert!(!set.provider_sync_available);
    assert!(!set.task_mutation_performed);
    assert!(!set.ui_effect_performed);
    assert!(set.admissions.iter().any(|admission| {
        admission.export_status == AcceptedMemoryProjectionExportStatus::Stopped
            && admission.policy_status == AcceptedMemoryProjectionPolicyStatus::Projectable
    }));
}
