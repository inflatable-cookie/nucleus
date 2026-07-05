use nucleus_memory::MemorySensitivityStorage;
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_export_plan::accepted_memory_projection_export_entry;
use crate::accepted_memory_projection_file_materialization::{
    materialize_accepted_memory_projection_files, AcceptedMemoryProjectionMaterializationBlocker,
    AcceptedMemoryProjectionMaterializationInput, AcceptedMemoryProjectionMaterializationStatus,
};
use crate::accepted_memory_projection_payload::{
    decode_accepted_memory_projection_payload, AcceptedMemoryProjectionPayload,
};
use crate::accepted_memory_projection_test_fixtures::accepted_memory;
use crate::accepted_memory_projection_write_admission::{
    accepted_memory_projection_write_admission, AcceptedMemoryProjectionWriteAdmissionStatus,
};

#[test]
fn admitted_projection_payload_is_materialized_under_memory_root() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let input = materialization_input(accepted_memory("memory:write"));

    let report = materialize_accepted_memory_projection_files(temp_dir.path(), vec![input]);
    let file_path = temp_dir.path().join("nucleus/memory/memory:write.toml");

    assert_eq!(report.counts.records, 1);
    assert_eq!(report.counts.materialized_files, 1);
    assert!(report.projection_write_performed);
    assert!(!report.scm_effect_performed);
    assert!(!report.import_or_apply_performed);
    assert!(!report.embedding_available);
    assert!(!report.provider_sync_available);
    assert!(!report.task_mutation_performed);
    assert!(!report.ui_effect_performed);
    assert!(file_path.exists());

    let bytes = std::fs::read(file_path).expect("read projection");
    let decoded = decode_accepted_memory_projection_payload(&bytes).expect("decode projection");
    assert_eq!(decoded.memory_id, "memory:write");
}

#[test]
fn blocked_admission_is_skipped_without_writing_file() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let mut record = accepted_memory("memory:blocked");
    record.sensitivity = MemorySensitivityStorage::Restricted;

    let report = materialize_accepted_memory_projection_files(
        temp_dir.path(),
        vec![materialization_input(record)],
    );

    assert_eq!(report.counts.records, 1);
    assert_eq!(report.counts.materialized_files, 0);
    assert_eq!(report.counts.skipped_records, 1);
    assert_eq!(report.counts.blocked_records, 1);
    assert!(!report.projection_write_performed);
    assert_eq!(
        report.outcomes[0].status,
        AcceptedMemoryProjectionMaterializationStatus::Skipped
    );
    assert!(report.outcomes[0]
        .blockers
        .contains(&AcceptedMemoryProjectionMaterializationBlocker::AdmissionNotAdmitted));
    assert!(!temp_dir
        .path()
        .join("nucleus/memory/memory:blocked.toml")
        .exists());
}

#[test]
fn unsafe_file_ref_is_skipped_without_escaping_root() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let mut input = materialization_input(accepted_memory("memory:unsafe"));
    input.admission.file_ref = Some("../outside.toml".to_owned());

    let report = materialize_accepted_memory_projection_files(temp_dir.path(), vec![input]);

    assert_eq!(report.counts.materialized_files, 0);
    assert_eq!(report.counts.skipped_records, 1);
    assert_eq!(report.counts.unsafe_path_count, 1);
    assert!(report.outcomes[0].blockers.iter().any(|blocker| {
        matches!(
            blocker,
            AcceptedMemoryProjectionMaterializationBlocker::UnsafePath { .. }
        )
    }));
    assert!(!temp_dir.path().join("../outside.toml").exists());
}

#[test]
fn payload_memory_mismatch_is_skipped() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let mut input = materialization_input(accepted_memory("memory:admission"));
    input.payload.memory_id = "memory:payload".to_owned();

    let report = materialize_accepted_memory_projection_files(temp_dir.path(), vec![input]);

    assert_eq!(report.counts.materialized_files, 0);
    assert_eq!(report.counts.skipped_records, 1);
    assert!(report.outcomes[0]
        .blockers
        .contains(&AcceptedMemoryProjectionMaterializationBlocker::PayloadMemoryMismatch));
}

fn materialization_input(
    record: nucleus_memory::AcceptedMemoryStorageRecord,
) -> AcceptedMemoryProjectionMaterializationInput {
    let entry =
        accepted_memory_projection_export_entry(&ProjectId("project:nucleus".to_owned()), &record);
    let admission = accepted_memory_projection_write_admission(entry);
    let payload = AcceptedMemoryProjectionPayload::from_accepted_memory_record(&record)
        .expect("projection payload");

    if record.sensitivity != MemorySensitivityStorage::Restricted {
        assert_eq!(
            admission.status,
            AcceptedMemoryProjectionWriteAdmissionStatus::Admitted
        );
    }

    AcceptedMemoryProjectionMaterializationInput { admission, payload }
}
