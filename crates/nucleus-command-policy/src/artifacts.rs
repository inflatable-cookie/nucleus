//! Compile-only command artifact and output-retention vocabulary.
//!
//! These records describe artifact refs, retention, redaction, secret scanning,
//! and resolution posture only. They do not store raw output, select an
//! artifact backend, run scanners, redact payloads, or render artifacts.

use crate::evidence::CommandOutputRetention;
use crate::ids::CommandRequestId;
use crate::runtime_events::CommandArtifactRef;

/// Kind of command payload an artifact ref represents.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandArtifactPayloadClass {
    Stdout,
    Stderr,
    CombinedOutput,
    TerminalTranscript,
    ValidationReport,
    SanitizedSummary,
    Custom(String),
}

/// Approval posture for retaining a command artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandArtifactApprovalRequirement {
    NotRequired,
    Required,
    Satisfied(String),
    Missing,
}

/// Secret scanning status for a command artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandArtifactSecretScanStatus {
    NotRequired,
    RequiredNotRun,
    Passed,
    FindingsRedacted,
    FindingsBlocked,
    Unsupported,
}

/// Redaction status for a command artifact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandArtifactRedactionStatus {
    NotRequired,
    Pending,
    Applied,
    Failed,
    Unsupported,
}

/// Whether an artifact ref can still be resolved.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandArtifactResolutionStatus {
    Resolvable,
    Missing,
    Expired,
    Redacted,
    CompactedToSummary,
    Unsupported,
}

/// Retention and safety policy for a command artifact ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandArtifactRetentionPolicy {
    pub retention: CommandOutputRetention,
    pub approval: CommandArtifactApprovalRequirement,
    pub secret_scan: CommandArtifactSecretScanStatus,
    pub redaction: CommandArtifactRedactionStatus,
}

/// Metadata for a retained command artifact ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandArtifactDescriptor {
    pub artifact_ref: CommandArtifactRef,
    pub command_request_id: CommandRequestId,
    pub payload_class: CommandArtifactPayloadClass,
    pub retention_policy: CommandArtifactRetentionPolicy,
    pub resolution: CommandArtifactResolutionStatus,
    pub summary: Option<String>,
}

impl CommandArtifactRetentionPolicy {
    /// Returns true when policy permits a full-output artifact ref.
    pub fn permits_full_output_ref(&self) -> bool {
        self.retention == CommandOutputRetention::FullArtifactWithApproval
            && matches!(
                self.approval,
                CommandArtifactApprovalRequirement::Satisfied(_)
            )
            && matches!(
                self.secret_scan,
                CommandArtifactSecretScanStatus::Passed
                    | CommandArtifactSecretScanStatus::FindingsRedacted
            )
            && matches!(
                self.redaction,
                CommandArtifactRedactionStatus::Applied
                    | CommandArtifactRedactionStatus::NotRequired
            )
    }
}

impl CommandArtifactDescriptor {
    /// Returns true when the ref can be resolved under the current policy.
    pub fn is_resolvable_under_policy(&self) -> bool {
        self.resolution == CommandArtifactResolutionStatus::Resolvable
            && (self.retention_policy.retention != CommandOutputRetention::FullArtifactWithApproval
                || self.retention_policy.permits_full_output_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_output_artifact_requires_approval_scan_and_redaction_policy() {
        let missing_approval = CommandArtifactRetentionPolicy {
            retention: CommandOutputRetention::FullArtifactWithApproval,
            approval: CommandArtifactApprovalRequirement::Missing,
            secret_scan: CommandArtifactSecretScanStatus::Passed,
            redaction: CommandArtifactRedactionStatus::Applied,
        };
        let permitted = CommandArtifactRetentionPolicy {
            retention: CommandOutputRetention::FullArtifactWithApproval,
            approval: CommandArtifactApprovalRequirement::Satisfied("approval:1".to_owned()),
            secret_scan: CommandArtifactSecretScanStatus::FindingsRedacted,
            redaction: CommandArtifactRedactionStatus::Applied,
        };

        assert!(!missing_approval.permits_full_output_ref());
        assert!(permitted.permits_full_output_ref());
    }

    #[test]
    fn artifact_descriptor_does_not_treat_refs_as_always_resolvable() {
        let descriptor = CommandArtifactDescriptor {
            artifact_ref: CommandArtifactRef("artifact:stdout".to_owned()),
            command_request_id: CommandRequestId("command:stdout".to_owned()),
            payload_class: CommandArtifactPayloadClass::Stdout,
            retention_policy: CommandArtifactRetentionPolicy {
                retention: CommandOutputRetention::ArtifactReference,
                approval: CommandArtifactApprovalRequirement::NotRequired,
                secret_scan: CommandArtifactSecretScanStatus::NotRequired,
                redaction: CommandArtifactRedactionStatus::NotRequired,
            },
            resolution: CommandArtifactResolutionStatus::Expired,
            summary: Some("artifact expired under retention policy".to_owned()),
        };

        assert!(!descriptor.is_resolvable_under_policy());
        assert_eq!(
            descriptor.resolution,
            CommandArtifactResolutionStatus::Expired
        );
    }
}
