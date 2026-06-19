use nucleus_scm_forge::{ForgeProviderKind, ScmBranchRef};

/// Neutral target for a future change request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestTarget {
    ForgeReview {
        provider: ForgeProviderKind,
        target_branch: Option<ScmBranchRef>,
    },
    ProviderPublication {
        publication_ref: Option<String>,
        gate_ref: Option<String>,
    },
    ProviderGate {
        gate_ref: Option<String>,
    },
    DirectAuthorityUpdate {
        target_ref: Option<String>,
    },
    ManualHandoff,
    Custom(String),
}

/// Publication state for a prep record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestPublicationState {
    NotRequested,
    WaitingForApproval,
    PublicationRequested,
    Published { provider_ref: String },
    Rejected(String),
    Unsupported(String),
}

/// Review policy expected before shared authority changes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestReviewPolicy {
    HumanReviewRequired,
    StewardMayPrepareOnly,
    DirectAuthorityUpdateAllowed,
    Unsupported,
}

/// Prep lifecycle before provider publication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestPrepStatus {
    Draft,
    Ready,
    Blocked(String),
    Superseded(String),
    Abandoned(String),
}
