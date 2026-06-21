use super::*;
use crate::ProviderRetentionPolicyStatus;
use crate::{
    durable_codex_live_smoke_dispatch_run, read_codex_live_executor_outcome_records,
    DurableCodexLiveSmokeDispatchRunInput, DurableCodexLiveSmokeIntent, ServerStateService,
};
use nucleus_local_store::SqliteBackend;

#[test]
fn durable_codex_live_smoke_persistence_survives_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let record = persist_durable_codex_live_smoke_evidence(&state, input()).expect("persist smoke");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_durable_codex_live_smoke_evidence_records(&reopened).expect("read smoke");
    let outcomes = read_codex_live_executor_outcome_records(&reopened).expect("read outcomes");

    assert_eq!(records, vec![record]);
    assert_eq!(outcomes.len(), 1);
    assert!(records[0].runtime_receipt_id.is_some());
    assert_eq!(records[0].method_sequence_count, 1);
    assert!(!records[0].raw_provider_material_retained);
    assert!(!records[0].raw_stream_retained);
}

#[test]
fn durable_codex_live_smoke_persistence_duplicate_write_attempt_is_noop() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut input = input();
    input
        .existing_write_attempt_ids
        .push(input.run.boundary.write_attempt_id.clone());

    let record = persist_durable_codex_live_smoke_evidence(&state, input).expect("duplicate noop");
    let records = read_durable_codex_live_smoke_evidence_records(&state).expect("read smoke");

    assert_eq!(
        record.status,
        DurableCodexLiveSmokeEvidenceStatus::DuplicateWriteAttemptNoop
    );
    assert!(record.duplicate_write_attempt_detected);
    assert!(records.is_empty());
    assert!(!record.provider_write_executed);
}

#[test]
fn durable_codex_live_smoke_persistence_blocks_raw_material() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut input = input();
    input.raw_provider_material_present = true;
    input.raw_stream_present = true;

    let record =
        persist_durable_codex_live_smoke_evidence(&state, input).expect("blocked evidence");

    assert!(matches!(
        record.status,
        DurableCodexLiveSmokeEvidenceStatus::Blocked(_)
    ));
    assert_eq!(
        record.retention_status,
        ProviderRetentionPolicyStatus::Blocked
    );
    assert!(record.runtime_receipt_id.is_none());
    assert!(!record.raw_provider_material_retained);
    assert!(!record.raw_stream_retained);
}

fn input() -> DurableCodexLiveSmokeEvidencePersistenceInput {
    DurableCodexLiveSmokeEvidencePersistenceInput {
        run: durable_codex_live_smoke_dispatch_run(DurableCodexLiveSmokeDispatchRunInput {
            intent: DurableCodexLiveSmokeIntent::DryRunOnly,
            run_id: "persistence".to_owned(),
            provider_instance_id: "codex:persistence".to_owned(),
            runtime_session_ref: "runtime-session:persistence".to_owned(),
            task_id: "task:persistence".to_owned(),
            work_item_id: "work:persistence".to_owned(),
            operator_confirmation_ref: "operator-confirmation:persistence".to_owned(),
            evidence_refs: vec!["evidence:persistence:command".to_owned()],
        }),
        live_outcome: None,
        existing_write_attempt_ids: Vec::new(),
        persistence_evidence_refs: vec!["evidence:persistence".to_owned()],
        artifact_refs: vec!["artifact:persistence-summary".to_owned()],
        raw_provider_material_present: false,
        raw_stream_present: false,
        secret_material_present: false,
        credential_material_present: false,
        unbounded_local_path_present: false,
    }
}
