//! Nucleus-owned native harness boundary types.
//!
//! This crate names app-owned persona, session, event, tool, approval, model
//! backend, and audit surfaces. It does not implement agent execution, model
//! inference, Git sync, or steward behavior yet.

pub mod audit;
pub mod backends;
pub mod effigy;
pub mod events;
pub mod personas;
pub mod sessions;
pub mod steward;
pub mod steward_commands;
pub mod tools;

pub use audit::{NativeAuditEvent, NativeAuditEventId, NativeAuditEventKind};
pub use backends::{
    NativeModelBackend, NativeModelBackendDeployment, NativeModelBackendId, NativeModelBackendKind,
    NativeModelBackendStatus, NativeModelBackendSuitability, NativeModelBackendUse,
};
pub use effigy::{
    NativeEffigyCommandScopeHint, NativeEffigyDoctorCommandStatus,
    NativeEffigyDoctorCommandSummary, NativeEffigyEvidenceRef, NativeEffigyHealthStatus,
    NativeEffigyHealthSummary, NativeEffigyIntegrationStatus, NativeEffigyManifestRef,
    NativeEffigyPlannedSelector, NativeEffigyProjectIntegration, NativeEffigyRepairHint,
    NativeEffigyRepairHintKind, NativeEffigyRepairSource, NativeEffigyRepairSynthesis,
    NativeEffigyRepairSynthesisStatus, NativeEffigyScope, NativeEffigySelectorKind,
    NativeEffigySelectorRecord, NativeEffigySelectorRef, NativeEffigySelectorRefreshStatus,
    NativeEffigySelectorRefreshSummary, NativeEffigyTestPlanCommandStatus,
    NativeEffigyTestPlanCommandSummary, NativeEffigyValidationPlanStatus,
    NativeEffigyValidationPlanSummary, NativeEffigyValidationPurpose,
};
pub use events::{NativeEventId, NativeEventKind, NativeHarnessEvent};
pub use personas::{
    NativeActionApproval, NativePersona, NativePersonaCapability, NativePersonaId,
    NativePersonaPolicy, NativePersonaRole, NativePrivilegedAction, NativeSyncAuthority,
};
pub use sessions::{NativeHarnessSession, NativeSessionId, NativeSessionState};
pub use steward::{
    NativeStewardChangeField, NativeStewardChangeSemantic, NativeStewardEvidenceRef,
    NativeStewardEvidenceSource, NativeStewardManagementCapturePlan,
    NativeStewardManagementCapturePlanStatus, NativeStewardManagementCaptureScope,
    NativeStewardProposal, NativeStewardProposalId, NativeStewardProposalKind,
    NativeStewardProposalReview, NativeStewardProposalTarget, NativeStewardProposedChange,
    NativeStewardSyncAssistance, NativeStewardSyncAssistanceId, NativeStewardSyncAssistanceKind,
    NativeStewardSyncAssistanceLinks,
};
pub use steward_commands::{
    NativeStewardCommandAdmission, NativeStewardCommandAdmissionStatus, NativeStewardCommandId,
    NativeStewardCommandKind, NativeStewardCommandOutcome, NativeStewardCommandReceiptLink,
    NativeStewardCommandRequest, NativeStewardCommandScope, NativeStewardCommandStatus,
    NativeStewardCommandTarget,
};
pub use tools::{
    NativeApprovalPolicy, NativeApprovalRequest, NativeApprovalRequestId, NativeRuntimeReceiptRef,
    NativeToolAction, NativeToolActionId, NativeToolActionState, NativeToolCapability,
    NativeToolEvidenceRef, NativeToolPolicy,
};
