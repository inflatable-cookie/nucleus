use nucleus_memory::{
    AcceptedMemoryStorageStatus, MemoryProposalStorageKind, MemoryProposalStorageScope,
    MemoryRetentionStoragePosture, MemorySensitivityStorage,
};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_import_admission::{
    accepted_memory_projection_import_admissions, AcceptedMemoryProjectionImportAdmissionStatus,
    AcceptedMemoryProjectionImportCandidateBlocker, AcceptedMemoryProjectionImportCandidateStatus,
    AcceptedMemoryProjectionImportInput,
};
use crate::accepted_memory_projection_payload::{
    encode_accepted_memory_projection_payload, AcceptedMemoryProjectionPayload,
};
use crate::accepted_memory_projection_test_fixtures::accepted_memory;

#[test]
fn reviewed_projected_memory_is_ready_and_admitted_without_effects() {
    let set = accepted_memory_projection_import_admissions(
        ProjectId("project:nucleus".to_owned()),
        vec![projection_input("memory:import-ready")],
    );

    assert_eq!(set.counts.inputs, 1);
    assert_eq!(set.counts.ready_candidates, 1);
    assert_eq!(set.counts.admitted_imports, 1);
    assert!(!set.active_memory_apply_performed);
    assert!(!set.scm_effect_performed);
    assert!(!set.embedding_available);
    assert!(!set.provider_sync_available);
    assert!(!set.task_mutation_performed);
    assert!(!set.ui_effect_performed);
    assert_eq!(
        set.candidates[0].status,
        AcceptedMemoryProjectionImportCandidateStatus::Ready
    );
    assert_eq!(
        set.admissions[0].status,
        AcceptedMemoryProjectionImportAdmissionStatus::Admitted
    );
}

#[test]
fn unsafe_decode_and_future_schema_candidates_are_blocked() {
    let future_schema = future_schema_input("memory:future");
    let set = accepted_memory_projection_import_admissions(
        ProjectId("project:nucleus".to_owned()),
        vec![
            AcceptedMemoryProjectionImportInput {
                file_ref: "../outside.toml".to_owned(),
                bytes: b"not toml".to_vec(),
            },
            future_schema,
        ],
    );

    assert_eq!(set.counts.blocked_candidates, 2);
    assert_eq!(set.counts.unsafe_file_refs, 1);
    assert_eq!(set.counts.decode_failures, 1);
    assert_eq!(set.counts.unsupported_schemas, 1);
    assert!(set.candidates[0].blockers.iter().any(|blocker| matches!(
        blocker,
        AcceptedMemoryProjectionImportCandidateBlocker::UnsafeFileRef { .. }
    )));
    assert!(set.candidates[1].blockers.iter().any(|blocker| matches!(
        blocker,
        AcceptedMemoryProjectionImportCandidateBlocker::UnsupportedSchema {
            schema_version: 999
        }
    )));
}

#[test]
fn project_scope_policy_retention_and_review_gaps_are_blocked() {
    let mut out_of_scope = projection_payload("memory:out-of-scope");
    out_of_scope.scope = MemoryProposalStorageScope::Project {
        project_ref: "project:other".to_owned(),
    };
    let mut user_private = projection_payload("memory:private");
    user_private.sensitivity = MemorySensitivityStorage::UserPrivate;
    let mut local_only = projection_payload("memory:local-only");
    local_only.retention = MemoryRetentionStoragePosture::LocalOnly;
    let mut unreviewed = projection_payload("memory:unreviewed");
    unreviewed.accepted_by_ref.clear();
    unreviewed.review.reviewer_ref.clear();
    unreviewed.accepted_at = None;

    let set = accepted_memory_projection_import_admissions(
        ProjectId("project:nucleus".to_owned()),
        vec![
            input_from_payload(out_of_scope),
            input_from_payload(user_private),
            input_from_payload(local_only),
            input_from_payload(unreviewed),
        ],
    );

    assert_eq!(set.counts.blocked_candidates, 4);
    assert_eq!(set.counts.policy_blockers, 3);
    assert_eq!(set.counts.review_blockers, 3);
    assert!(set.candidates[0].blockers.iter().any(|blocker| matches!(
        blocker,
        AcceptedMemoryProjectionImportCandidateBlocker::OutOfScopeProject { .. }
    )));
    assert!(set.candidates[1].blockers.iter().any(|blocker| {
        matches!(
            blocker,
            AcceptedMemoryProjectionImportCandidateBlocker::UserPrivateSensitivity
        )
    }));
    assert!(set.candidates[2].blockers.iter().any(|blocker| {
        matches!(
            blocker,
            AcceptedMemoryProjectionImportCandidateBlocker::LocalOnlyRetention
        )
    }));
    assert!(set.candidates[3].blockers.iter().any(|blocker| {
        matches!(
            blocker,
            AcceptedMemoryProjectionImportCandidateBlocker::MissingAcceptedByRef
        )
    }));
}

#[test]
fn unsupported_kind_non_accepted_status_and_path_mismatch_are_blocked() {
    let mut other_kind = projection_payload("memory:other-kind");
    other_kind.kind = MemoryProposalStorageKind::Other {
        label: "provider_native_blob".to_owned(),
    };
    let mut stale = projection_payload("memory:stale");
    stale.status = AcceptedMemoryStorageStatus::Stale;
    let mut mismatch = projection_payload("memory:path-mismatch");
    mismatch.memory_id = "memory:different".to_owned();

    let set = accepted_memory_projection_import_admissions(
        ProjectId("project:nucleus".to_owned()),
        vec![
            input_from_payload(other_kind),
            input_from_payload(stale),
            AcceptedMemoryProjectionImportInput {
                file_ref: "nucleus/memory/memory:path-mismatch.toml".to_owned(),
                bytes: encode_accepted_memory_projection_payload(&mismatch).expect("encode"),
            },
        ],
    );

    assert_eq!(set.counts.blocked_candidates, 3);
    assert!(set.candidates[0].blockers.iter().any(|blocker| matches!(
        blocker,
        AcceptedMemoryProjectionImportCandidateBlocker::UnsupportedMemoryKind { .. }
    )));
    assert!(set.candidates[1].blockers.iter().any(|blocker| matches!(
        blocker,
        AcceptedMemoryProjectionImportCandidateBlocker::NonAcceptedStatus { .. }
    )));
    assert!(set.candidates[2].blockers.iter().any(|blocker| matches!(
        blocker,
        AcceptedMemoryProjectionImportCandidateBlocker::MemoryIdFileRefMismatch { .. }
    )));
}

#[test]
fn duplicate_candidate_states_are_blocked_without_applying_memory() {
    let set = accepted_memory_projection_import_admissions(
        ProjectId("project:nucleus".to_owned()),
        vec![
            projection_input("memory:duplicate"),
            projection_input("memory:duplicate"),
        ],
    );

    assert_eq!(set.counts.duplicate_candidates, 4);
    assert_eq!(set.counts.admitted_imports, 0);
    assert_eq!(set.counts.blocked_imports, 2);
    assert!(set.candidates.iter().all(|candidate| {
        candidate
            .blockers
            .contains(&AcceptedMemoryProjectionImportCandidateBlocker::DuplicateFileRef)
            && candidate
                .blockers
                .contains(&AcceptedMemoryProjectionImportCandidateBlocker::DuplicateMemoryId)
    }));
    assert!(!set.active_memory_apply_performed);
}

#[test]
fn import_records_do_not_retain_raw_sensitive_artifacts() {
    let set = accepted_memory_projection_import_admissions(
        ProjectId("project:nucleus".to_owned()),
        vec![projection_input("memory:sanitized")],
    );
    let rendered = format!("{set:?}");

    for forbidden in [
        "raw_transcript",
        "provider_payload",
        "terminal_stream",
        "private_note",
        "credential",
        "secret_value",
    ] {
        assert!(
            !rendered.contains(forbidden),
            "import diagnostics leaked {forbidden}"
        );
    }
}

fn projection_input(memory_id: &str) -> AcceptedMemoryProjectionImportInput {
    input_from_payload(projection_payload(memory_id))
}

fn projection_payload(memory_id: &str) -> AcceptedMemoryProjectionPayload {
    AcceptedMemoryProjectionPayload::from_accepted_memory_record(&accepted_memory(memory_id))
        .expect("projection payload")
}

fn input_from_payload(
    payload: AcceptedMemoryProjectionPayload,
) -> AcceptedMemoryProjectionImportInput {
    AcceptedMemoryProjectionImportInput {
        file_ref: format!("nucleus/memory/{}.toml", payload.memory_id),
        bytes: encode_accepted_memory_projection_payload(&payload).expect("encode"),
    }
}

fn future_schema_input(memory_id: &str) -> AcceptedMemoryProjectionImportInput {
    let mut payload = projection_payload(memory_id);
    payload.schema_version = 999;
    AcceptedMemoryProjectionImportInput {
        file_ref: format!("nucleus/memory/{memory_id}.toml"),
        bytes: encode_accepted_memory_projection_payload(&payload).expect("encode"),
    }
}
