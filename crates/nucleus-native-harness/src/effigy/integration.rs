use std::fmt;

use super::safety::contains_forbidden_effigy_term;
use crate::tools::{NativeRuntimeReceiptRef, NativeToolActionId};

/// Project-level Effigy integration record.
pub struct NativeEffigyProjectIntegration {
    pub status: NativeEffigyIntegrationStatus,
    pub scope: NativeEffigyScope,
    pub manifest_ref: Option<NativeEffigyManifestRef>,
    pub selectors: Vec<NativeEffigySelectorRecord>,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeEffigyProjectIntegration {
    pub fn disabled(summary: impl Into<String>) -> Self {
        Self {
            status: NativeEffigyIntegrationStatus::Disabled,
            scope: NativeEffigyScope::ProjectRoot,
            manifest_ref: None,
            selectors: Vec::new(),
            evidence_refs: Vec::new(),
            summary: Some(summary.into()),
        }
    }

    pub fn uses_sanitized_refs(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_effigy_term(summary))
            .unwrap_or(true)
            && self
                .manifest_ref
                .as_ref()
                .map(|manifest| !contains_forbidden_effigy_term(&manifest.0))
                .unwrap_or(true)
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
            && self
                .selectors
                .iter()
                .all(NativeEffigySelectorRecord::uses_sanitized_refs)
    }

    pub fn supports_steward_recommendations(&self) -> bool {
        self.status == NativeEffigyIntegrationStatus::Enabled && !self.selectors.is_empty()
    }
}

/// Redacted `Debug`: shape, counts, presence, and the sanitization verdict.
///
/// `manifest_ref`, `selectors`, `evidence_refs`, `summary`, and the string
/// payloads inside `scope` are unconstrained caller input. `uses_sanitized_refs`
/// is a predicate callers check, not an invariant construction enforces, so
/// `disabled(summary)` and direct struct literals can hold forbidden terms
/// (`secret`, `credential`, `token`, `raw_stderr`, provider transcript text).
/// A derived `Debug` would print that material before anything checks it, so
/// this implementation renders structure instead of content.
impl fmt::Debug for NativeEffigyProjectIntegration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeEffigyProjectIntegration")
            .field("status", &self.status)
            .field("scope", &scope_shape(&self.scope))
            .field("manifest_ref_present", &self.manifest_ref.is_some())
            .field("selector_count", &self.selectors.len())
            .field("evidence_ref_count", &self.evidence_refs.len())
            .field("summary_present", &self.summary.is_some())
            .field("uses_sanitized_refs", &self.uses_sanitized_refs())
            .field(
                "supports_steward_recommendations",
                &self.supports_steward_recommendations(),
            )
            .finish()
    }
}

/// Scope variant label without its caller-supplied string payload.
fn scope_shape(scope: &NativeEffigyScope) -> &'static str {
    match scope {
        NativeEffigyScope::ProjectRoot => "project_root",
        NativeEffigyScope::Repo { .. } => "repo",
        NativeEffigyScope::Custom(_) => "custom",
    }
}

/// Effigy enablement status for a project or repo scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyIntegrationStatus {
    Disabled,
    Detected,
    Enabled,
    MissingManifest,
    Unknown,
}

/// Effigy scope inside a Nucleus project.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyScope {
    ProjectRoot,
    Repo {
        repo_membership_ref: String,
        subsystem: Option<String>,
    },
    Custom(String),
}

/// Sanitized manifest reference.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeEffigyManifestRef(pub String);

/// Sanitized evidence reference (shared core type).
pub use nucleus_core::EvidenceRef as NativeEffigyEvidenceRef;

/// One Effigy selector known to Nucleus.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigySelectorRecord {
    pub selector_ref: NativeEffigySelectorRef,
    pub kind: NativeEffigySelectorKind,
    pub scope: NativeEffigyScope,
    pub command_scope_hint: NativeEffigyCommandScopeHint,
    pub purpose: Option<String>,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
}

impl NativeEffigySelectorRecord {
    pub fn uses_sanitized_refs(&self) -> bool {
        !contains_forbidden_effigy_term(&self.selector_ref.0)
            && self
                .purpose
                .as_ref()
                .map(|purpose| !contains_forbidden_effigy_term(purpose))
                .unwrap_or(true)
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
    }
}

/// Stable selector reference.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeEffigySelectorRef(pub String);

/// Selector kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigySelectorKind {
    Task,
    Health,
    Validation,
    Setup,
    ReleaseGate,
    Dev,
    Query,
    Custom(String),
}

/// Command-scope hint for later command authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyCommandScopeHint {
    ReadOnly,
    Validation,
    ManagementStateWrite,
    SourceWrite,
    Release,
    Unknown,
}

/// Sanitized result of a read-only Effigy selector refresh.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigySelectorRefreshSummary {
    pub status: NativeEffigySelectorRefreshStatus,
    pub scope: NativeEffigyScope,
    pub tool_action_id: Option<NativeToolActionId>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub selectors: Vec<NativeEffigySelectorRecord>,
    pub summary: Option<String>,
}

impl NativeEffigySelectorRefreshSummary {
    pub fn refreshed(scope: NativeEffigyScope, selectors: Vec<NativeEffigySelectorRecord>) -> Self {
        Self {
            status: NativeEffigySelectorRefreshStatus::Refreshed,
            scope,
            tool_action_id: None,
            receipt_refs: Vec::new(),
            evidence_refs: Vec::new(),
            selectors,
            summary: None,
        }
    }

    pub fn can_update_inventory(&self) -> bool {
        self.status == NativeEffigySelectorRefreshStatus::Refreshed
            && self.uses_sanitized_refs()
            && !self.selectors.is_empty()
    }

    pub fn apply_to_integration(
        &self,
        mut integration: NativeEffigyProjectIntegration,
    ) -> NativeEffigyProjectIntegration {
        if self.can_update_inventory() {
            integration.scope = self.scope.clone();
            integration.selectors = self.selectors.clone();
            integration.evidence_refs = self.evidence_refs.clone();
            integration.status = NativeEffigyIntegrationStatus::Enabled;
            integration.summary = self.summary.clone();
        }
        integration
    }

    pub fn uses_sanitized_refs(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_effigy_term(summary))
            .unwrap_or(true)
            && self
                .receipt_refs
                .iter()
                .all(|receipt_ref| !contains_forbidden_effigy_term(&receipt_ref.0))
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
            && self
                .selectors
                .iter()
                .all(NativeEffigySelectorRecord::uses_sanitized_refs)
    }

    pub fn executes_selectors(&self) -> bool {
        false
    }
}

/// Selector refresh state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigySelectorRefreshStatus {
    Refreshed,
    NoSelectors,
    Blocked(String),
    Unsupported(String),
    Unknown,
}
