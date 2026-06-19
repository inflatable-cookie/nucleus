//! Engine-owned change-request preparation records.
//!
//! These records describe the handoff Nucleus may later publish through an SCM
//! or forge adapter. They do not create pull requests, publish snapshots,
//! merge, push, promote, resolve credentials, or call remote APIs.

mod candidate;
mod descriptor;
mod evidence_package;
mod prep;
mod target;

pub use candidate::{
    EngineChangeRequestCandidateAdmission, EngineChangeRequestCandidateAdmissionStatus,
    EngineChangeRequestCandidateId, EngineChangeRequestCandidateRecord,
    EngineChangeRequestCandidateStatus, EngineChangeRequestEvidenceRef,
    EngineChangeRequestPolicyGate,
};
pub use descriptor::EngineGitHubReviewBoundaryDescriptor;
pub use evidence_package::EngineChangeRequestEvidencePackage;
pub use prep::{EngineChangeRequestPrepId, EngineChangeRequestPrepRecord};
pub use target::{
    EngineChangeRequestPrepStatus, EngineChangeRequestPublicationState,
    EngineChangeRequestReviewPolicy, EngineChangeRequestTarget,
};

#[cfg(test)]
mod tests;
