use crate::personas::{
    NativeActionApproval, NativePersonaId, NativePersonaPolicy, NativePrivilegedAction,
};
use crate::steward::NativeStewardEvidenceRef;
use crate::tools::NativeToolActionId;

use super::admission::{NativeStewardCommandAdmission, NativeStewardCommandAdmissionStatus};
use super::records::{
    NativeStewardCommandId, NativeStewardCommandKind, NativeStewardCommandScope,
    NativeStewardCommandTarget,
};
use super::safety::contains_forbidden_steward_command_term;

/// Stable native steward command id.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardCommandRequest {
    pub id: NativeStewardCommandId,
    pub persona_id: NativePersonaId,
    pub kind: NativeStewardCommandKind,
    pub scope: NativeStewardCommandScope,
    pub target: NativeStewardCommandTarget,
    pub tool_action_id: Option<NativeToolActionId>,
    pub evidence_refs: Vec<NativeStewardEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeStewardCommandRequest {
    pub fn is_record_only(&self) -> bool {
        true
    }

    pub fn is_read_only(&self) -> bool {
        self.scope == NativeStewardCommandScope::ReadOnly
    }

    pub fn requires_approval(&self) -> bool {
        matches!(
            self.scope,
            NativeStewardCommandScope::ApprovalRequired | NativeStewardCommandScope::Unsupported
        )
    }

    pub fn can_imply_provider_authority(&self) -> bool {
        false
    }

    pub fn uses_reference_only_evidence(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_steward_command_term(summary))
            .unwrap_or(true)
            && self
                .evidence_refs
                .iter()
                .all(NativeStewardEvidenceRef::uses_reference_only_evidence)
    }

    pub fn admit_with_policy(&self, policy: &NativePersonaPolicy) -> NativeStewardCommandAdmission {
        let approval = policy.approval_for_action(self.privileged_action());
        let status = match (&self.scope, approval.clone()) {
            (NativeStewardCommandScope::Unsupported, _) => {
                NativeStewardCommandAdmissionStatus::Rejected(
                    "unsupported command scope".to_owned(),
                )
            }
            (_, NativeActionApproval::BlockedByPolicy) => {
                NativeStewardCommandAdmissionStatus::Rejected(
                    "blocked by persona policy".to_owned(),
                )
            }
            (NativeStewardCommandScope::ApprovalRequired, NativeActionApproval::Required) => {
                NativeStewardCommandAdmissionStatus::RequiresApproval
            }
            (_, NativeActionApproval::Required) => {
                NativeStewardCommandAdmissionStatus::RequiresApproval
            }
            (NativeStewardCommandScope::Unknown, _) => {
                NativeStewardCommandAdmissionStatus::Blocked("unknown command authority".to_owned())
            }
            _ => NativeStewardCommandAdmissionStatus::Accepted,
        };

        NativeStewardCommandAdmission {
            command_id: self.id.clone(),
            status,
            approval,
            reason: None,
        }
    }

    fn privileged_action(&self) -> NativePrivilegedAction {
        match self.scope {
            NativeStewardCommandScope::ReadOnly => NativePrivilegedAction::ReadOnlyInspection,
            NativeStewardCommandScope::ProposalOnly => {
                NativePrivilegedAction::ProposeManagementStateEdit
            }
            NativeStewardCommandScope::ApprovalRequired => match self.kind {
                NativeStewardCommandKind::ManagementCapturePreparation => {
                    NativePrivilegedAction::PrepareManagementCapture
                }
                _ => NativePrivilegedAction::ProposeManagementStateEdit,
            },
            NativeStewardCommandScope::Unsupported | NativeStewardCommandScope::Unknown => {
                NativePrivilegedAction::ChangeSyncPolicy
            }
        }
    }
}
