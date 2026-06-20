//! Provider trace span records.
//!
//! These records describe provider runtime operations with sanitized refs and
//! summaries. They do not retain raw provider payloads or grant client
//! authority.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderTraceSpanInput {
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub provider_instance_id: String,
    pub component: ProviderTraceComponent,
    pub status: ProviderTraceStatus,
    pub duration_millis: u64,
    pub command_id: Option<String>,
    pub dispatch_attempt_id: Option<String>,
    pub runtime_session_ref: Option<String>,
    pub receipt_id: Option<String>,
    pub outcome_id: Option<String>,
    pub evidence_refs: Vec<String>,
    pub summary: String,
    pub raw_provider_material_requested: bool,
    pub raw_stream_requested: bool,
    pub client_authority_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderTraceComponent {
    CommandAdmission,
    Dispatch,
    TransportWrite,
    ObservationIngestion,
    Recovery,
    Repair,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderTraceStatus {
    Started,
    Completed,
    Failed,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderTraceSpanRecord {
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub provider_instance_id: String,
    pub component: ProviderTraceComponent,
    pub status: ProviderTraceStatus,
    pub duration_millis: u64,
    pub command_id: Option<String>,
    pub dispatch_attempt_id: Option<String>,
    pub runtime_session_ref: Option<String>,
    pub receipt_id: Option<String>,
    pub outcome_id: Option<String>,
    pub evidence_refs: Vec<String>,
    pub summary: String,
    pub raw_provider_material_retained: bool,
    pub raw_stream_retained: bool,
    pub client_authority_granted: bool,
}

pub fn provider_trace_span_record(input: ProviderTraceSpanInput) -> ProviderTraceSpanRecord {
    assert_trace_input(&input);
    ProviderTraceSpanRecord {
        span_id: input.span_id,
        parent_span_id: input.parent_span_id,
        provider_instance_id: input.provider_instance_id,
        component: input.component,
        status: input.status,
        duration_millis: input.duration_millis,
        command_id: input.command_id,
        dispatch_attempt_id: input.dispatch_attempt_id,
        runtime_session_ref: input.runtime_session_ref,
        receipt_id: input.receipt_id,
        outcome_id: input.outcome_id,
        evidence_refs: unique_sorted(input.evidence_refs),
        summary: input.summary,
        raw_provider_material_retained: false,
        raw_stream_retained: false,
        client_authority_granted: false,
    }
}

fn assert_trace_input(input: &ProviderTraceSpanInput) {
    assert!(!input.span_id.trim().is_empty(), "span id is required");
    assert!(
        !input.provider_instance_id.trim().is_empty(),
        "provider instance id is required"
    );
    assert!(!input.summary.trim().is_empty(), "summary is required");
    assert!(
        !input.evidence_refs.is_empty(),
        "evidence refs are required"
    );
    assert!(
        !input.raw_provider_material_requested
            && !input.raw_stream_requested
            && !input.client_authority_requested,
        "trace spans cannot request raw material or authority"
    );
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_trace_span_records_successful_and_failed_effects() {
        let success = provider_trace_span_record(input(ProviderTraceStatus::Completed));
        let failed = provider_trace_span_record(input(ProviderTraceStatus::Failed));

        assert_eq!(success.status, ProviderTraceStatus::Completed);
        assert_eq!(failed.status, ProviderTraceStatus::Failed);
        assert_eq!(success.receipt_id, Some("receipt:1".to_owned()));
        assert!(!success.raw_provider_material_retained);
        assert!(!success.client_authority_granted);
    }

    #[test]
    #[should_panic(expected = "trace spans cannot request raw material or authority")]
    fn provider_trace_span_records_reject_raw_material_requests() {
        let mut input = input(ProviderTraceStatus::Completed);
        input.raw_stream_requested = true;
        let _ = provider_trace_span_record(input);
    }

    fn input(status: ProviderTraceStatus) -> ProviderTraceSpanInput {
        ProviderTraceSpanInput {
            span_id: format!("span:{status:?}"),
            parent_span_id: None,
            provider_instance_id: "codex:local-default".to_owned(),
            component: ProviderTraceComponent::TransportWrite,
            status,
            duration_millis: 42,
            command_id: Some("command:1".to_owned()),
            dispatch_attempt_id: Some("dispatch:1".to_owned()),
            runtime_session_ref: Some("runtime-session:1".to_owned()),
            receipt_id: Some("receipt:1".to_owned()),
            outcome_id: Some("outcome:1".to_owned()),
            evidence_refs: vec!["evidence:trace:1".to_owned()],
            summary: "provider write reached terminal state".to_owned(),
            raw_provider_material_requested: false,
            raw_stream_requested: false,
            client_authority_requested: false,
        }
    }
}
