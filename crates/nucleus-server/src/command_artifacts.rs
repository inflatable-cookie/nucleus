//! Server-owned command artifact envelope vocabulary.
//!
//! These records bind command artifact descriptors to server command ids. They
//! do not implement artifact storage, backend selection, scanning, redaction,
//! payload reads, payload writes, or UI rendering.

use nucleus_command_policy::{
    CommandArtifactDescriptor, CommandArtifactRef, CommandArtifactResolutionStatus,
    CommandRequestId,
};

use crate::ids::ServerCommandId;

/// Server envelope for retained command artifact metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerCommandArtifactRecord {
    pub server_command_id: ServerCommandId,
    pub command_request_id: CommandRequestId,
    pub descriptor: CommandArtifactDescriptor,
}

/// Server response when resolving a command artifact ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerCommandArtifactResolution {
    pub artifact_ref: CommandArtifactRef,
    pub status: CommandArtifactResolutionStatus,
    pub summary: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_command_policy::{
        CommandArtifactApprovalRequirement, CommandArtifactPayloadClass,
        CommandArtifactRedactionStatus, CommandArtifactRetentionPolicy,
        CommandArtifactSecretScanStatus, CommandOutputRetention,
    };

    #[test]
    fn server_artifact_record_wraps_descriptor_without_payload() {
        let command_request_id = CommandRequestId("command:artifact".to_owned());
        let descriptor = CommandArtifactDescriptor {
            artifact_ref: CommandArtifactRef("artifact:stdout".to_owned()),
            command_request_id: command_request_id.clone(),
            payload_class: CommandArtifactPayloadClass::Stdout,
            retention_policy: CommandArtifactRetentionPolicy {
                retention: CommandOutputRetention::ArtifactReference,
                approval: CommandArtifactApprovalRequirement::NotRequired,
                secret_scan: CommandArtifactSecretScanStatus::NotRequired,
                redaction: CommandArtifactRedactionStatus::NotRequired,
            },
            resolution: CommandArtifactResolutionStatus::Resolvable,
            summary: Some("stdout retained as symbolic artifact".to_owned()),
        };

        let record = ServerCommandArtifactRecord {
            server_command_id: ServerCommandId("server-command:artifact".to_owned()),
            command_request_id,
            descriptor,
        };

        assert!(record.descriptor.is_resolvable_under_policy());
        assert_eq!(
            record.descriptor.artifact_ref,
            CommandArtifactRef("artifact:stdout".to_owned())
        );
    }
}
