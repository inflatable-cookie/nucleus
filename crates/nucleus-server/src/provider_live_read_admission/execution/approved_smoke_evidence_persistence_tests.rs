use nucleus_local_store::SqliteBackend;

use super::*;
use crate::ServerStateService;

#[test]
fn persists_promoted_approved_smoke_evidence_without_raw_payloads() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));
    let evidence = promoted_evidence();

    let set = persist_provider_live_read_approved_smoke_evidence_records(
        &state,
        persistence_input(vec![evidence.clone()], false),
    )
    .expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_provider_live_read_approved_smoke_evidence_records(&reopened).expect("read");
    let json = serde_json::to_string(&records[0]).expect("json");

    assert_eq!(records, set.records);
    assert_eq!(
        records[0].persistence_status,
        ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::Persisted
    );
    assert_eq!(
        records[0].name_with_owner,
        Some("octocat/Hello-World".to_owned())
    );
    assert!(records[0].provider_network_call_performed);
    assert!(!records[0].provider_write_executed);
    assert!(!records[0].raw_provider_payload_retained);
    assert_sanitized_json(&json);
}

#[test]
fn represents_duplicate_noop_without_rewriting_store() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let evidence = promoted_evidence();

    let first = persist_provider_live_read_approved_smoke_evidence_records(
        &state,
        persistence_input(vec![evidence.clone()], false),
    )
    .expect("first");
    let duplicate = persist_provider_live_read_approved_smoke_evidence_records(
        &state,
        ProviderLiveReadApprovedSmokeEvidencePersistenceInput {
            existing_persisted_evidence_ids: vec![first.records[0].persisted_evidence_id.clone()],
            ..persistence_input(vec![evidence], false)
        },
    )
    .expect("duplicate");

    assert_eq!(
        duplicate.records[0].persistence_status,
        ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::DuplicateNoop
    );
    assert!(duplicate.records[0].duplicate_evidence_detected);
    assert!(!duplicate.records[0].smoke_evidence_persisted);
}

#[test]
fn blocks_unpromoted_evidence_and_effect_flags() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut evidence = promoted_evidence();
    evidence.status = ProviderLiveReadApprovedSmokeEvidenceStatus::RepairRequired;

    let set = persist_provider_live_read_approved_smoke_evidence_records(
        &state,
        persistence_input(vec![evidence], true),
    )
    .expect("blocked");
    let record = &set.records[0];

    assert_eq!(
        record.persistence_status,
        ProviderLiveReadApprovedSmokeEvidencePersistenceStatus::Blocked
    );
    assert!(record
        .persistence_blockers
        .contains(&ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker::EvidenceNotPromoted));
    assert!(record
        .persistence_blockers
        .contains(&ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker::ProviderWriteExecuted));
    assert!(record.persistence_blockers.contains(
        &ProviderLiveReadApprovedSmokeEvidencePersistenceBlocker::RawProviderPayloadRetained
    ));
    assert!(!record.smoke_evidence_persisted);
}

fn persistence_input(
    evidence_records: Vec<ProviderLiveReadApprovedSmokeEvidenceRecord>,
    forbidden: bool,
) -> ProviderLiveReadApprovedSmokeEvidencePersistenceInput {
    ProviderLiveReadApprovedSmokeEvidencePersistenceInput {
        evidence_records,
        persistence_evidence_refs: vec![
            "evidence:provider-live-read-approved-smoke-evidence-persistence".to_owned(),
        ],
        existing_persisted_evidence_ids: Vec::new(),
        provider_write_executed: forbidden,
        callback_effect_executed: forbidden,
        interruption_effect_executed: forbidden,
        recovery_effect_executed: forbidden,
        task_mutation_executed: forbidden,
        raw_provider_payload_retained: forbidden,
    }
}

fn promoted_evidence() -> ProviderLiveReadApprovedSmokeEvidenceRecord {
    ProviderLiveReadApprovedSmokeEvidenceRecord {
        evidence_id:
            "provider-live-read-approved-smoke-evidence:command-smoke-request:repo-metadata"
                .to_owned(),
        evidence_ref: Some("evidence:provider-live-read-approved-smoke".to_owned()),
        command_smoke_request_id: "command-smoke-request:repo-metadata".to_owned(),
        handoff_id: "command-handoff:repo-metadata".to_owned(),
        command_descriptor_id: "command-descriptor:repo-metadata".to_owned(),
        executor_request_id: "executor-request:repo-metadata".to_owned(),
        output_record_id: "sanitized-output:repo-metadata".to_owned(),
        receipt_id: "receipt:repo-metadata".to_owned(),
        name_with_owner: Some("octocat/Hello-World".to_owned()),
        default_branch: Some("master".to_owned()),
        is_private: Some(false),
        visibility: Some("PUBLIC".to_owned()),
        url: Some("https://github.com/octocat/Hello-World".to_owned()),
        viewer_permission: Some("READ".to_owned()),
        pushed_at: Some("2024-08-20T23:54:42Z".to_owned()),
        updated_at: Some("2026-06-22T20:17:08Z".to_owned()),
        status: ProviderLiveReadApprovedSmokeEvidenceStatus::Promoted,
        blockers: Vec::new(),
        duplicate_evidence_detected: false,
        provider_network_call_performed: true,
        provider_write_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn assert_sanitized_json(json: &str) {
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("raw_stdout"));
    assert!(!json.contains("raw_stderr"));
    assert!(!json.contains("credential_material"));
    assert!(!json.contains("private_key"));
}
