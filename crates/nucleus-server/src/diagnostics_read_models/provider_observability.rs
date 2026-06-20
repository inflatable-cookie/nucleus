use crate::{
    ProviderBackpressureSummaryRecord, ProviderRetentionPolicyRecord, ProviderRuntimeRepairRecord,
    ProviderSupportBundleManifestRecord, ProviderTraceSpanRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderObservabilityDiagnosticsDto {
    pub traces: Vec<ProviderObservabilityTraceDto>,
    pub support_bundles: Vec<ProviderObservabilitySupportBundleDto>,
    pub repair_count: usize,
    pub backpressure_count: usize,
    pub retention_blocker_count: usize,
    pub health: ProviderObservabilityHealthDto,
    pub client_can_execute_provider_write: bool,
    pub client_can_mutate_task: bool,
    pub provider_material_exposed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderObservabilityTraceDto {
    pub span_id: String,
    pub provider_instance_id: String,
    pub component: String,
    pub status: String,
    pub duration_millis: u64,
    pub evidence_refs: Vec<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderObservabilitySupportBundleDto {
    pub bundle_id: String,
    pub provider_instance_id: String,
    pub evidence_refs: Vec<String>,
    pub missing_evidence_refs: Vec<String>,
    pub client_safe: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderObservabilityHealthDto {
    pub status: String,
    pub summary: String,
    pub next_action: String,
}

pub fn provider_observability_diagnostics(
    traces: &[ProviderTraceSpanRecord],
    bundles: &[ProviderSupportBundleManifestRecord],
    repairs: &[ProviderRuntimeRepairRecord],
    backpressure: &[ProviderBackpressureSummaryRecord],
    retention: &[ProviderRetentionPolicyRecord],
) -> ProviderObservabilityDiagnosticsDto {
    let retention_blocker_count = retention
        .iter()
        .filter(|record| !record.blockers.is_empty())
        .count();
    let health = health(repairs.len(), backpressure.len(), retention_blocker_count);

    ProviderObservabilityDiagnosticsDto {
        traces: traces
            .iter()
            .map(ProviderObservabilityTraceDto::from)
            .collect(),
        support_bundles: bundles
            .iter()
            .map(ProviderObservabilitySupportBundleDto::from)
            .collect(),
        repair_count: repairs.len(),
        backpressure_count: backpressure.len(),
        retention_blocker_count,
        health,
        client_can_execute_provider_write: false,
        client_can_mutate_task: false,
        provider_material_exposed: false,
    }
}

impl From<&ProviderTraceSpanRecord> for ProviderObservabilityTraceDto {
    fn from(record: &ProviderTraceSpanRecord) -> Self {
        Self {
            span_id: record.span_id.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            component: format!("{:?}", record.component),
            status: format!("{:?}", record.status),
            duration_millis: record.duration_millis,
            evidence_refs: record.evidence_refs.clone(),
            summary: record.summary.clone(),
        }
    }
}

impl From<&ProviderSupportBundleManifestRecord> for ProviderObservabilitySupportBundleDto {
    fn from(record: &ProviderSupportBundleManifestRecord) -> Self {
        Self {
            bundle_id: record.bundle_id.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            evidence_refs: record.evidence_refs.clone(),
            missing_evidence_refs: record.missing_evidence_refs.clone(),
            client_safe: record.client_safe,
        }
    }
}

fn health(
    repair_count: usize,
    backpressure_count: usize,
    retention_blocker_count: usize,
) -> ProviderObservabilityHealthDto {
    if retention_blocker_count > 0 {
        return ProviderObservabilityHealthDto {
            status: "blocked".to_owned(),
            summary: "provider retention policy blockers require repair".to_owned(),
            next_action: "inspect_retention_policy_blockers".to_owned(),
        };
    }
    if repair_count > 0 {
        return ProviderObservabilityHealthDto {
            status: "repair_required".to_owned(),
            summary: "provider runtime repair records are present".to_owned(),
            next_action: "inspect_provider_repair_records".to_owned(),
        };
    }
    if backpressure_count > 0 {
        return ProviderObservabilityHealthDto {
            status: "watch".to_owned(),
            summary: "provider backpressure summaries are present".to_owned(),
            next_action: "inspect_backpressure_summaries".to_owned(),
        };
    }
    ProviderObservabilityHealthDto {
        status: "healthy".to_owned(),
        summary: "provider observability records are sanitized".to_owned(),
        next_action: "inspect_trace_spans".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        provider_retention_policy, provider_trace_span_record, ProviderRetentionPolicyInput,
        ProviderTraceComponent, ProviderTraceSpanInput, ProviderTraceStatus,
    };

    #[test]
    fn provider_observability_diagnostics_are_read_only_and_sanitized() {
        let trace = provider_trace_span_record(ProviderTraceSpanInput {
            span_id: "span:1".to_owned(),
            parent_span_id: None,
            provider_instance_id: "codex:local-default".to_owned(),
            component: ProviderTraceComponent::TransportWrite,
            status: ProviderTraceStatus::Failed,
            duration_millis: 5,
            command_id: Some("command:1".to_owned()),
            dispatch_attempt_id: Some("dispatch:1".to_owned()),
            runtime_session_ref: Some("runtime-session:1".to_owned()),
            receipt_id: None,
            outcome_id: None,
            evidence_refs: vec!["evidence:trace:1".to_owned()],
            summary: "failed without raw payload".to_owned(),
            raw_provider_material_requested: false,
            raw_stream_requested: false,
            client_authority_requested: false,
        });
        let retention = provider_retention_policy(ProviderRetentionPolicyInput {
            record_ref: "record:1".to_owned(),
            evidence_refs: vec!["evidence:retention:1".to_owned()],
            artifact_refs: Vec::new(),
            raw_payload_present: true,
            raw_stream_present: false,
            secret_material_present: false,
            credential_material_present: false,
            unbounded_local_path_present: false,
            artifact_policy_approved: true,
            diagnostics_requested: true,
        });

        let dto = provider_observability_diagnostics(&[trace], &[], &[], &[], &[retention]);

        assert_eq!(dto.traces.len(), 1);
        assert_eq!(dto.health.status, "blocked");
        assert!(!dto.client_can_execute_provider_write);
        assert!(!dto.client_can_mutate_task);
        assert!(!dto.provider_material_exposed);
    }
}
