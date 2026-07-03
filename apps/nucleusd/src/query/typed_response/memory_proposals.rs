use nucleus_server::{
    ControlMemoryProposalRetentionCountDto, ControlMemoryProposalScopeCountDto,
    ControlMemoryProposalSensitivityCountDto, ControlMemoryProposalSourceCountsDto,
    ControlMemoryProposalStatusCountDto, ControlMemoryProposalSummaryDto,
};

pub(crate) fn memory_proposals_response_lines(
    label: &str,
    project_id: String,
    proposals: Vec<ControlMemoryProposalSummaryDto>,
    status_counts: Vec<ControlMemoryProposalStatusCountDto>,
    scope_counts: Vec<ControlMemoryProposalScopeCountDto>,
    sensitivity_counts: Vec<ControlMemoryProposalSensitivityCountDto>,
    retention_counts: Vec<ControlMemoryProposalRetentionCountDto>,
    source_counts: ControlMemoryProposalSourceCountsDto,
    client_can_mutate: bool,
    provider_execution_available: bool,
) -> Vec<String> {
    let mut lines = vec![
        format!("domain={label}"),
        format!("project_id={project_id}"),
        format!("proposals={}", proposals.len()),
        format!(
            "source_counts proposal_records={} source_refs={} link_refs={} supersession_refs={}",
            source_counts.proposal_records,
            source_counts.source_refs,
            source_counts.link_refs,
            source_counts.supersession_refs
        ),
        format!("client_can_mutate={client_can_mutate}"),
        format!("provider_execution_available={provider_execution_available}"),
    ];
    lines.extend(
        status_counts
            .into_iter()
            .map(|count| format!("status state={} count={}", count.status, count.count)),
    );
    lines.extend(
        scope_counts
            .into_iter()
            .map(|count| format!("scope name={} count={}", count.scope, count.count)),
    );
    lines.extend(sensitivity_counts.into_iter().map(|count| {
        format!(
            "sensitivity name={} count={}",
            count.sensitivity, count.count
        )
    }));
    lines.extend(
        retention_counts
            .into_iter()
            .map(|count| format!("retention name={} count={}", count.retention, count.count)),
    );
    lines.extend(proposals.into_iter().map(|proposal| {
        format!(
            "proposal proposal_id={} scope={} kind={} status={} review_status={} sensitivity={} retention={} source_refs={} link_refs={} supersedes={} superseded_by={}",
            proposal.proposal_id,
            proposal.scope,
            proposal.kind,
            proposal.status,
            proposal.review_status,
            proposal.sensitivity,
            proposal.retention,
            proposal.source_ref_count,
            proposal.link_ref_count,
            proposal.supersedes_count,
            proposal.superseded_by_count
        )
    }));
    lines
}
