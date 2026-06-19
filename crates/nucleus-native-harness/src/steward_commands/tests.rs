use super::*;
use crate::personas::{NativeActionApproval, NativePersonaId, NativePersonaPolicy};
use crate::steward::{
    NativeStewardEvidenceRef, NativeStewardEvidenceSource, NativeStewardProposalId,
    NativeStewardSyncAssistanceId,
};
use crate::tools::{NativeRuntimeReceiptRef, NativeToolActionId};
use crate::NativeSyncAuthority;

fn command(kind: NativeStewardCommandKind) -> NativeStewardCommandRequest {
    NativeStewardCommandRequest {
        id: NativeStewardCommandId("steward-command:1".to_owned()),
        persona_id: NativePersonaId("persona:steward".to_owned()),
        kind,
        scope: NativeStewardCommandScope::ReadOnly,
        target: NativeStewardCommandTarget::Project {
            project_ref: "project:nucleus".to_owned(),
        },
        tool_action_id: Some(NativeToolActionId("tool:steward-command:1".to_owned())),
        evidence_refs: vec![NativeStewardEvidenceRef {
            source: NativeStewardEvidenceSource::Task,
            ref_id: "task:index".to_owned(),
        }],
        summary: Some("sanitized steward command request".to_owned()),
    }
}

#[test]
fn steward_command_requests_cover_first_command_kinds() {
    let kinds = vec![
        NativeStewardCommandKind::ReadOnlyInspection,
        NativeStewardCommandKind::ProposalDrafting,
        NativeStewardCommandKind::ManagementCapturePreparation,
        NativeStewardCommandKind::SyncAssistance,
        NativeStewardCommandKind::EffigyInspection,
    ];

    for kind in kinds {
        let command = command(kind);
        assert!(command.is_record_only());
        assert!(command.is_read_only());
        assert!(!command.can_imply_provider_authority());
        assert!(command.uses_reference_only_evidence());
    }
}

#[test]
fn steward_command_outcomes_are_distinct_from_mutations() {
    let outcome = NativeStewardCommandOutcome {
        command_id: NativeStewardCommandId("steward-command:1".to_owned()),
        status: NativeStewardCommandStatus::Completed,
        proposal_refs: vec![NativeStewardProposalId("proposal:1".to_owned())],
        sync_assistance_refs: vec![NativeStewardSyncAssistanceId("sync-assist:1".to_owned())],
        tool_action_id: Some(NativeToolActionId("tool:steward-command:1".to_owned())),
        receipt_refs: vec![NativeRuntimeReceiptRef(
            "receipt:steward-command:1".to_owned(),
        )],
        evidence_refs: vec![NativeStewardEvidenceRef {
            source: NativeStewardEvidenceSource::RuntimeReceipt,
            ref_id: "receipt:steward-command:1".to_owned(),
        }],
        summary: Some("completed command with proposal refs".to_owned()),
    };

    assert!(outcome.is_terminal());
    assert!(outcome.is_distinct_from_mutation());
    assert!(!outcome.can_imply_provider_authority());
    assert!(outcome.uses_reference_only_evidence());
}

#[test]
fn steward_command_statuses_cover_admission_and_terminal_paths() {
    let statuses = vec![
        NativeStewardCommandStatus::Accepted,
        NativeStewardCommandStatus::Rejected("unsupported".to_owned()),
        NativeStewardCommandStatus::Blocked("policy".to_owned()),
        NativeStewardCommandStatus::Completed,
        NativeStewardCommandStatus::CompletedWithWarnings,
        NativeStewardCommandStatus::Unknown,
    ];

    assert_eq!(statuses.len(), 6);
    assert!(statuses.contains(&NativeStewardCommandStatus::Accepted));
    assert!(statuses.contains(&NativeStewardCommandStatus::Completed));
    assert!(statuses.contains(&NativeStewardCommandStatus::Unknown));
}

#[test]
fn steward_command_records_reject_provider_authority_terms() {
    let mut command = command(NativeStewardCommandKind::SyncAssistance);
    command.summary = Some("prepare push to remote".to_owned());

    assert!(!command.uses_reference_only_evidence());
    assert!(!command.can_imply_provider_authority());
}

#[test]
fn steward_command_receipt_link_attaches_receipts_without_payloads() {
    let outcome = NativeStewardCommandOutcome {
        command_id: NativeStewardCommandId("steward-command:1".to_owned()),
        status: NativeStewardCommandStatus::Completed,
        proposal_refs: Vec::new(),
        sync_assistance_refs: Vec::new(),
        tool_action_id: None,
        receipt_refs: Vec::new(),
        evidence_refs: Vec::new(),
        summary: Some("completed command".to_owned()),
    };
    let link = NativeStewardCommandReceiptLink {
        command_id: NativeStewardCommandId("steward-command:1".to_owned()),
        tool_action_id: Some(NativeToolActionId("tool:steward-command:1".to_owned())),
        receipt_refs: vec![NativeRuntimeReceiptRef("receipt:command:1".to_owned())],
        evidence_refs: vec![NativeStewardEvidenceRef {
            source: NativeStewardEvidenceSource::RuntimeReceipt,
            ref_id: "receipt:command:1".to_owned(),
        }],
        summary: Some("sanitized receipt link".to_owned()),
    };

    let linked = outcome.with_receipt_link(&link);

    assert!(link.links_command(&NativeStewardCommandId("steward-command:1".to_owned())));
    assert_eq!(linked.receipt_refs.len(), 1);
    assert_eq!(linked.evidence_refs.len(), 1);
    assert!(linked.uses_reference_only_evidence());
    assert!(link.uses_reference_only_evidence());
}

#[test]
fn steward_command_receipt_link_rejects_raw_payload_terms() {
    let link = NativeStewardCommandReceiptLink {
        command_id: NativeStewardCommandId("steward-command:1".to_owned()),
        tool_action_id: None,
        receipt_refs: vec![NativeRuntimeReceiptRef("raw_stdout:command".to_owned())],
        evidence_refs: Vec::new(),
        summary: None,
    };

    assert!(!link.uses_reference_only_evidence());
}

#[test]
fn steward_command_admission_accepts_read_only_without_approval() {
    let policy =
        NativePersonaPolicy::project_steward(NativeSyncAuthority::ProposeOnly, true, false);
    let command = command(NativeStewardCommandKind::ReadOnlyInspection);

    let admission = command.admit_with_policy(&policy);

    assert_eq!(
        admission.status,
        NativeStewardCommandAdmissionStatus::Accepted
    );
    assert!(admission.can_run_without_approval());
}

#[test]
fn steward_command_admission_requires_approval_for_capture_prep() {
    let policy = NativePersonaPolicy::project_steward(
        NativeSyncAuthority::PrepareManagementCapture,
        true,
        false,
    );
    let mut command = command(NativeStewardCommandKind::ManagementCapturePreparation);
    command.scope = NativeStewardCommandScope::ApprovalRequired;

    let admission = command.admit_with_policy(&policy);

    assert_eq!(
        admission.status,
        NativeStewardCommandAdmissionStatus::RequiresApproval
    );
    assert_eq!(admission.approval, NativeActionApproval::Required);
}

#[test]
fn steward_command_admission_rejects_unsupported_escalation() {
    let policy = NativePersonaPolicy::project_steward(NativeSyncAuthority::None, true, false);
    let mut command = command(NativeStewardCommandKind::SyncAssistance);
    command.scope = NativeStewardCommandScope::Unsupported;

    let admission = command.admit_with_policy(&policy);

    assert!(admission.is_rejected_or_blocked());
    assert!(matches!(
        admission.status,
        NativeStewardCommandAdmissionStatus::Rejected(_)
    ));
}

#[test]
fn steward_command_admission_blocks_proposal_when_policy_has_no_sync_authority() {
    let policy = NativePersonaPolicy::project_steward(NativeSyncAuthority::None, true, false);
    let mut command = command(NativeStewardCommandKind::ProposalDrafting);
    command.scope = NativeStewardCommandScope::ProposalOnly;

    let admission = command.admit_with_policy(&policy);

    assert!(admission.is_rejected_or_blocked());
    assert_eq!(admission.approval, NativeActionApproval::BlockedByPolicy);
}
