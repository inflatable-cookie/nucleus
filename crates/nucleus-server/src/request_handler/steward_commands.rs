use nucleus_native_harness::{
    NativePersonaPolicy, NativeStewardCommandAdmissionStatus, NativeStewardCommandRequest,
    NativeSyncAuthority,
};

use crate::control_api::{ServerCommandReceiptStatus, ServerControlError};

pub(crate) fn handle_steward_command(
    command: &NativeStewardCommandRequest,
) -> ServerCommandReceiptStatus {
    let policy =
        NativePersonaPolicy::project_steward(NativeSyncAuthority::ProposeOnly, true, false);
    let admission = command.admit_with_policy(&policy);

    match admission.status {
        NativeStewardCommandAdmissionStatus::Accepted => {
            ServerCommandReceiptStatus::AcceptedForNativeStewardCommand
        }
        NativeStewardCommandAdmissionStatus::RequiresApproval => {
            ServerCommandReceiptStatus::WaitingForApproval
        }
        NativeStewardCommandAdmissionStatus::Rejected(reason) => {
            ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest { reason })
        }
        NativeStewardCommandAdmissionStatus::Blocked(reason) => {
            ServerCommandReceiptStatus::Rejected(ServerControlError::Deferred { reason })
        }
        NativeStewardCommandAdmissionStatus::Unsupported => {
            ServerCommandReceiptStatus::Rejected(ServerControlError::Unsupported {
                reason: "native steward command is unsupported".to_owned(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_native_harness::{
        NativePersonaId, NativeStewardCommandId, NativeStewardCommandKind,
        NativeStewardCommandScope, NativeStewardCommandTarget,
    };

    fn command(scope: NativeStewardCommandScope) -> NativeStewardCommandRequest {
        NativeStewardCommandRequest {
            id: NativeStewardCommandId("steward-command:server".to_owned()),
            persona_id: NativePersonaId("persona:steward".to_owned()),
            kind: NativeStewardCommandKind::ReadOnlyInspection,
            scope,
            target: NativeStewardCommandTarget::Project {
                project_ref: "project:nucleus".to_owned(),
            },
            tool_action_id: None,
            evidence_refs: Vec::new(),
            summary: Some("server steward command admission".to_owned()),
        }
    }

    #[test]
    fn server_accepts_read_only_steward_command_shape() {
        let status = handle_steward_command(&command(NativeStewardCommandScope::ReadOnly));

        assert_eq!(
            status,
            ServerCommandReceiptStatus::AcceptedForNativeStewardCommand
        );
    }

    #[test]
    fn server_rejects_unsupported_steward_command_scope() {
        let status = handle_steward_command(&command(NativeStewardCommandScope::Unsupported));

        assert!(matches!(
            status,
            ServerCommandReceiptStatus::Rejected(ServerControlError::InvalidRequest { .. })
        ));
    }
}
