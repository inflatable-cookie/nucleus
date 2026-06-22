//! Read-only query composition for approved provider live-read smoke evidence.

use crate::{
    provider_live_read_approved_smoke_evidence_diagnostics,
    ProviderLiveReadApprovedSmokeEvidenceDiagnostics, ProviderLiveReadApprovedSmokeEvidenceRecord,
    ProviderLiveReadApprovedSmokeEvidenceStatus,
};

pub fn query_provider_live_read_smoke_evidence_diagnostics(
) -> ProviderLiveReadApprovedSmokeEvidenceDiagnostics {
    provider_live_read_approved_smoke_evidence_diagnostics(vec![approved_smoke_record()])
}

fn approved_smoke_record() -> ProviderLiveReadApprovedSmokeEvidenceRecord {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke_evidence_query_returns_promoted_historical_read_without_effects() {
        let diagnostics = query_provider_live_read_smoke_evidence_diagnostics();

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
