//! Read-only query composition for approved provider live-read smoke evidence.

use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

use crate::{
    provider_live_read_approved_smoke_evidence_diagnostics,
    read_provider_live_read_approved_smoke_evidence_records,
    ProviderLiveReadApprovedSmokeEvidenceDiagnostics,
    ProviderLiveReadApprovedSmokeEvidencePersistenceRecord,
    ProviderLiveReadApprovedSmokeEvidenceRecord, ProviderLiveReadApprovedSmokeEvidenceStatus,
    ServerStateService,
};

pub fn query_provider_live_read_smoke_evidence_diagnostics<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<ProviderLiveReadApprovedSmokeEvidenceDiagnostics>
where
    B: LocalStoreBackend,
{
    let records = read_provider_live_read_approved_smoke_evidence_records(state)?
        .into_iter()
        .map(approved_smoke_record_from_persistence)
        .collect::<Vec<_>>();

    Ok(provider_live_read_approved_smoke_evidence_diagnostics(
        records,
    ))
}

pub fn approved_provider_live_read_smoke_evidence_fixture(
) -> ProviderLiveReadApprovedSmokeEvidenceRecord {
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

fn approved_smoke_record_from_persistence(
    record: ProviderLiveReadApprovedSmokeEvidencePersistenceRecord,
) -> ProviderLiveReadApprovedSmokeEvidenceRecord {
    ProviderLiveReadApprovedSmokeEvidenceRecord {
        evidence_id: record.evidence_id,
        evidence_ref: record.evidence_ref,
        command_smoke_request_id: record.command_smoke_request_id,
        handoff_id: record.handoff_id,
        command_descriptor_id: "command-descriptor:unknown".to_owned(),
        executor_request_id: "executor-request:unknown".to_owned(),
        output_record_id: record.output_record_id,
        receipt_id: record.receipt_id,
        name_with_owner: record.name_with_owner,
        default_branch: None,
        is_private: None,
        visibility: None,
        url: None,
        viewer_permission: None,
        pushed_at: None,
        updated_at: None,
        status: record.evidence_status,
        blockers: record.evidence_blockers,
        duplicate_evidence_detected: record.duplicate_evidence_detected,
        provider_network_call_performed: record.provider_network_call_performed,
        provider_write_executed: record.provider_write_executed,
        callback_effect_executed: record.callback_effect_executed,
        interruption_effect_executed: record.interruption_effect_executed,
        recovery_effect_executed: record.recovery_effect_executed,
        task_mutation_executed: record.task_mutation_executed,
        raw_provider_payload_retained: record.raw_provider_payload_retained,
    }
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::SqliteBackend;

    use super::*;
    use crate::{
        persist_provider_live_read_approved_smoke_evidence_records,
        ProviderLiveReadApprovedSmokeEvidencePersistenceInput,
    };

    #[test]
    fn smoke_evidence_query_returns_empty_diagnostics_for_empty_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        let diagnostics =
            query_provider_live_read_smoke_evidence_diagnostics(&state).expect("query diagnostics");

        assert_eq!(diagnostics.evidence_count, 0);
        assert_eq!(diagnostics.promoted_count, 0);
        assert_eq!(diagnostics.provider_network_read_performed_count, 0);
        assert!(!diagnostics.provider_write_executed);
        assert!(!diagnostics.raw_provider_payload_retained);
    }

    #[test]
    fn smoke_evidence_query_reads_promoted_persisted_evidence_without_effects() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        persist_provider_live_read_approved_smoke_evidence_records(
            &state,
            ProviderLiveReadApprovedSmokeEvidencePersistenceInput {
                evidence_records: vec![approved_provider_live_read_smoke_evidence_fixture()],
                persistence_evidence_refs: vec![
                    "evidence:provider-live-read-approved-smoke-evidence-persistence".to_owned(),
                ],
                existing_persisted_evidence_ids: Vec::new(),
                provider_write_executed: false,
                callback_effect_executed: false,
                interruption_effect_executed: false,
                recovery_effect_executed: false,
                task_mutation_executed: false,
                raw_provider_payload_retained: false,
            },
        )
        .expect("persist evidence");

        let diagnostics =
            query_provider_live_read_smoke_evidence_diagnostics(&state).expect("query diagnostics");

        assert_eq!(diagnostics.evidence_count, 1);
        assert_eq!(diagnostics.promoted_count, 1);
        assert_eq!(diagnostics.provider_network_read_performed_count, 1);
        assert!(!diagnostics.provider_write_executed);
        assert!(!diagnostics.callback_effect_executed);
        assert!(!diagnostics.interruption_effect_executed);
        assert!(!diagnostics.recovery_effect_executed);
        assert!(!diagnostics.task_mutation_executed);
        assert!(!diagnostics.raw_provider_payload_retained);
    }
}
