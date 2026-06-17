//! Effigy project integration records for native personas.
//!
//! These records describe discovered or configured Effigy surfaces. They do
//! not run Effigy, parse live command output, edit manifests, or execute
//! selectors.

use crate::steward::{
    NativeStewardEvidenceRef, NativeStewardEvidenceSource, NativeStewardProposal,
    NativeStewardProposalId, NativeStewardProposalKind, NativeStewardProposalReview,
    NativeStewardProposalTarget,
};
use crate::tools::{NativeRuntimeReceiptRef, NativeToolActionId};

/// Project-level Effigy integration record.
#[derive(Clone, Debug, Eq, PartialEq)]
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

/// Sanitized evidence reference.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeEffigyEvidenceRef(pub String);

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

/// Sanitized result of a read-only Effigy doctor command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyDoctorCommandSummary {
    pub status: NativeEffigyDoctorCommandStatus,
    pub health: NativeEffigyHealthSummary,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeEffigyDoctorCommandSummary {
    pub fn from_health(health: NativeEffigyHealthSummary) -> Self {
        let status = match health.status {
            NativeEffigyHealthStatus::Ok => NativeEffigyDoctorCommandStatus::Summarized,
            NativeEffigyHealthStatus::Warning => NativeEffigyDoctorCommandStatus::Summarized,
            NativeEffigyHealthStatus::Error => NativeEffigyDoctorCommandStatus::Summarized,
            NativeEffigyHealthStatus::Blocked => NativeEffigyDoctorCommandStatus::Blocked,
            NativeEffigyHealthStatus::Unknown => NativeEffigyDoctorCommandStatus::Unknown,
        };
        Self {
            status,
            health,
            evidence_refs: Vec::new(),
            summary: None,
        }
    }

    pub fn uses_sanitized_refs(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_effigy_term(summary))
            .unwrap_or(true)
            && self.health.uses_sanitized_refs()
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
    }

    pub fn mutates_project(&self) -> bool {
        false
    }
}

/// Doctor command summary status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyDoctorCommandStatus {
    Summarized,
    Blocked,
    Unsupported(String),
    Unknown,
}

/// Sanitized result of a read-only `effigy test --plan` command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyTestPlanCommandSummary {
    pub status: NativeEffigyTestPlanCommandStatus,
    pub validation_plan: NativeEffigyValidationPlanSummary,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeEffigyTestPlanCommandSummary {
    pub fn from_validation_plan(validation_plan: NativeEffigyValidationPlanSummary) -> Self {
        let status = match validation_plan.status {
            NativeEffigyValidationPlanStatus::PlannedOnly => {
                NativeEffigyTestPlanCommandStatus::Summarized
            }
            NativeEffigyValidationPlanStatus::Executed => {
                NativeEffigyTestPlanCommandStatus::ExecutionOutOfScope
            }
            NativeEffigyValidationPlanStatus::Unsupported => {
                NativeEffigyTestPlanCommandStatus::Unsupported("validation plan unsupported".into())
            }
            NativeEffigyValidationPlanStatus::Blocked => NativeEffigyTestPlanCommandStatus::Blocked,
            NativeEffigyValidationPlanStatus::Unknown => NativeEffigyTestPlanCommandStatus::Unknown,
        };
        Self {
            status,
            validation_plan,
            evidence_refs: Vec::new(),
            summary: None,
        }
    }

    pub fn claims_test_execution(&self) -> bool {
        self.status == NativeEffigyTestPlanCommandStatus::ExecutionOutOfScope
            || self.validation_plan.claims_execution()
    }

    pub fn uses_sanitized_refs(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_effigy_term(summary))
            .unwrap_or(true)
            && self.validation_plan.uses_sanitized_refs()
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
    }
}

/// Test-plan command summary status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyTestPlanCommandStatus {
    Summarized,
    Blocked,
    Unsupported(String),
    ExecutionOutOfScope,
    Unknown,
}

/// Sanitized summary of an Effigy health check such as `effigy doctor`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyHealthSummary {
    pub status: NativeEffigyHealthStatus,
    pub scope: NativeEffigyScope,
    pub tool_action_id: Option<NativeToolActionId>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub repair_hints: Vec<NativeEffigyRepairHint>,
    pub summary: Option<String>,
}

impl NativeEffigyHealthSummary {
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
                .repair_hints
                .iter()
                .all(NativeEffigyRepairHint::uses_sanitized_refs)
    }

    pub fn needs_repair(&self) -> bool {
        matches!(
            self.status,
            NativeEffigyHealthStatus::Warning
                | NativeEffigyHealthStatus::Error
                | NativeEffigyHealthStatus::Blocked
        ) || !self.repair_hints.is_empty()
    }
}

/// Health state summarized from an Effigy inspection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyHealthStatus {
    Ok,
    Warning,
    Error,
    Blocked,
    Unknown,
}

/// Sanitized `effigy test --plan` summary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyValidationPlanSummary {
    pub status: NativeEffigyValidationPlanStatus,
    pub scope: NativeEffigyScope,
    pub tool_action_id: Option<NativeToolActionId>,
    pub planned_selectors: Vec<NativeEffigyPlannedSelector>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub repair_hints: Vec<NativeEffigyRepairHint>,
    pub summary: Option<String>,
}

impl NativeEffigyValidationPlanSummary {
    pub fn planned_only(
        scope: NativeEffigyScope,
        planned_selectors: Vec<NativeEffigyPlannedSelector>,
    ) -> Self {
        Self {
            status: NativeEffigyValidationPlanStatus::PlannedOnly,
            scope,
            tool_action_id: None,
            planned_selectors,
            receipt_refs: Vec::new(),
            evidence_refs: Vec::new(),
            repair_hints: Vec::new(),
            summary: None,
        }
    }

    pub fn claims_execution(&self) -> bool {
        self.status == NativeEffigyValidationPlanStatus::Executed
    }

    pub fn uses_sanitized_refs(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_effigy_term(summary))
            .unwrap_or(true)
            && self
                .planned_selectors
                .iter()
                .all(NativeEffigyPlannedSelector::uses_sanitized_refs)
            && self
                .receipt_refs
                .iter()
                .all(|receipt_ref| !contains_forbidden_effigy_term(&receipt_ref.0))
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
            && self
                .repair_hints
                .iter()
                .all(NativeEffigyRepairHint::uses_sanitized_refs)
    }
}

/// Validation-plan state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyValidationPlanStatus {
    PlannedOnly,
    Executed,
    Unsupported,
    Blocked,
    Unknown,
}

/// One selector named by a validation plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyPlannedSelector {
    pub selector_ref: NativeEffigySelectorRef,
    pub purpose: NativeEffigyValidationPurpose,
    pub command_scope_hint: NativeEffigyCommandScopeHint,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
}

impl NativeEffigyPlannedSelector {
    pub fn uses_sanitized_refs(&self) -> bool {
        !contains_forbidden_effigy_term(&self.selector_ref.0)
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
    }
}

/// Reason a selector appears in a validation plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyValidationPurpose {
    Setup,
    Validation,
    Health,
    Check,
    ReleaseGate,
    Custom(String),
}

/// Sanitized repair hint derived from Effigy evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyRepairHint {
    pub kind: NativeEffigyRepairHintKind,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeEffigyRepairHint {
    pub fn uses_sanitized_refs(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_effigy_term(summary))
            .unwrap_or(true)
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
    }
}

/// Repair hint category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyRepairHintKind {
    MissingManifest,
    MissingSelector,
    DoctorWarning,
    DoctorError,
    PlanUnavailable,
    PolicyBlocked,
    Custom(String),
}

/// Synthesis of Effigy findings into repair hints and steward proposals.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeEffigyRepairSynthesis {
    pub source: NativeEffigyRepairSource,
    pub status: NativeEffigyRepairSynthesisStatus,
    pub repair_hints: Vec<NativeEffigyRepairHint>,
    pub evidence_refs: Vec<NativeEffigyEvidenceRef>,
    pub summary: Option<String>,
}

impl NativeEffigyRepairSynthesis {
    pub fn from_repair_hints(
        source: NativeEffigyRepairSource,
        repair_hints: Vec<NativeEffigyRepairHint>,
    ) -> Self {
        let status = if repair_hints.is_empty() {
            NativeEffigyRepairSynthesisStatus::NoRepairNeeded
        } else {
            NativeEffigyRepairSynthesisStatus::ProposalReady
        };
        Self {
            source,
            status,
            repair_hints,
            evidence_refs: Vec::new(),
            summary: None,
        }
    }

    pub fn to_steward_proposal(
        &self,
        id: NativeStewardProposalId,
        target: NativeStewardProposalTarget,
    ) -> Option<NativeStewardProposal> {
        if self.status != NativeEffigyRepairSynthesisStatus::ProposalReady
            || !self.uses_sanitized_refs()
        {
            return None;
        }

        Some(NativeStewardProposal {
            id,
            persona_id: None,
            target,
            kind: NativeStewardProposalKind::ProjectOrganizationHint,
            review: NativeStewardProposalReview::NeedsHumanApproval,
            proposed_changes: Vec::new(),
            evidence_refs: self
                .evidence_refs
                .iter()
                .map(|evidence_ref| NativeStewardEvidenceRef {
                    source: NativeStewardEvidenceSource::Effigy,
                    ref_id: evidence_ref.0.clone(),
                })
                .collect(),
            tool_action_id: None,
            receipt_refs: Vec::new(),
            summary: self.summary.clone(),
        })
    }

    pub fn mutates_manifest_or_scripts(&self) -> bool {
        false
    }

    pub fn uses_sanitized_refs(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_effigy_term(summary))
            .unwrap_or(true)
            && self
                .repair_hints
                .iter()
                .all(NativeEffigyRepairHint::uses_sanitized_refs)
            && self
                .evidence_refs
                .iter()
                .all(|evidence_ref| !contains_forbidden_effigy_term(&evidence_ref.0))
    }
}

/// Effigy inspection source for repair synthesis.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyRepairSource {
    SelectorRefresh,
    Doctor,
    TestPlan,
    Custom(String),
}

/// Repair synthesis state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeEffigyRepairSynthesisStatus {
    NoRepairNeeded,
    ProposalReady,
    Blocked(String),
    Unsupported(String),
    Unknown,
}

fn contains_forbidden_effigy_term(value: &str) -> bool {
    [
        "raw_stdout",
        "raw_stderr",
        "secret",
        "credential",
        "token",
        "local cache",
        "provider transcript",
    ]
    .iter()
    .any(|term| value.to_lowercase().contains(term))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selector(selector: &str, scope: NativeEffigyScope) -> NativeEffigySelectorRecord {
        NativeEffigySelectorRecord {
            selector_ref: NativeEffigySelectorRef(selector.to_owned()),
            kind: NativeEffigySelectorKind::Validation,
            scope,
            command_scope_hint: NativeEffigyCommandScopeHint::Validation,
            purpose: Some("validation selector".to_owned()),
            evidence_refs: vec![NativeEffigyEvidenceRef("evidence:selector".to_owned())],
        }
    }

    #[test]
    fn project_can_represent_effigy_disabled() {
        let integration = NativeEffigyProjectIntegration::disabled("no Effigy manifest detected");

        assert_eq!(integration.status, NativeEffigyIntegrationStatus::Disabled);
        assert!(integration.selectors.is_empty());
        assert!(integration.uses_sanitized_refs());
        assert!(!integration.supports_steward_recommendations());
    }

    #[test]
    fn project_can_represent_root_effigy_selector_inventory() {
        let integration = NativeEffigyProjectIntegration {
            status: NativeEffigyIntegrationStatus::Enabled,
            scope: NativeEffigyScope::ProjectRoot,
            manifest_ref: Some(NativeEffigyManifestRef("manifest:root-effigy".to_owned())),
            selectors: vec![selector("qa:docs", NativeEffigyScope::ProjectRoot)],
            evidence_refs: vec![NativeEffigyEvidenceRef("evidence:effigy-tasks".to_owned())],
            summary: Some("root Effigy selectors discovered".to_owned()),
        };

        assert_eq!(integration.selectors.len(), 1);
        assert!(integration.uses_sanitized_refs());
        assert!(integration.supports_steward_recommendations());
    }

    #[test]
    fn project_can_represent_repo_scoped_effigy_selectors() {
        let repo_scope = NativeEffigyScope::Repo {
            repo_membership_ref: "repo:api".to_owned(),
            subsystem: Some("api".to_owned()),
        };
        let integration = NativeEffigyProjectIntegration {
            status: NativeEffigyIntegrationStatus::Enabled,
            scope: repo_scope.clone(),
            manifest_ref: Some(NativeEffigyManifestRef("manifest:repo-api".to_owned())),
            selectors: vec![selector("api/test", repo_scope.clone())],
            evidence_refs: Vec::new(),
            summary: Some("repo scoped selectors discovered".to_owned()),
        };

        assert!(matches!(
            integration.scope,
            NativeEffigyScope::Repo {
                ref repo_membership_ref,
                ..
            } if repo_membership_ref == "repo:api"
        ));
        assert_eq!(integration.selectors[0].scope, repo_scope);
        assert!(integration.uses_sanitized_refs());
    }

    #[test]
    fn selector_inventory_rejects_raw_or_secret_refs() {
        let integration = NativeEffigyProjectIntegration {
            status: NativeEffigyIntegrationStatus::Enabled,
            scope: NativeEffigyScope::ProjectRoot,
            manifest_ref: Some(NativeEffigyManifestRef("secret:path".to_owned())),
            selectors: vec![selector("qa:docs", NativeEffigyScope::ProjectRoot)],
            evidence_refs: Vec::new(),
            summary: None,
        };

        assert!(!integration.uses_sanitized_refs());
    }

    #[test]
    fn effigy_selector_refresh_updates_inventory_from_sanitized_evidence() {
        let mut refresh = NativeEffigySelectorRefreshSummary::refreshed(
            NativeEffigyScope::ProjectRoot,
            vec![selector("qa:docs", NativeEffigyScope::ProjectRoot)],
        );
        refresh.tool_action_id = Some(NativeToolActionId("tool:effigy-tasks".to_owned()));
        refresh
            .receipt_refs
            .push(NativeRuntimeReceiptRef("receipt:effigy:tasks".to_owned()));
        refresh
            .evidence_refs
            .push(NativeEffigyEvidenceRef("evidence:effigy-tasks".to_owned()));
        refresh.summary = Some("selector inventory refreshed".to_owned());

        let integration = refresh.apply_to_integration(NativeEffigyProjectIntegration {
            status: NativeEffigyIntegrationStatus::Detected,
            scope: NativeEffigyScope::ProjectRoot,
            manifest_ref: Some(NativeEffigyManifestRef("manifest:root-effigy".to_owned())),
            selectors: Vec::new(),
            evidence_refs: Vec::new(),
            summary: None,
        });

        assert!(refresh.can_update_inventory());
        assert!(!refresh.executes_selectors());
        assert_eq!(integration.status, NativeEffigyIntegrationStatus::Enabled);
        assert_eq!(integration.selectors.len(), 1);
        assert_eq!(
            integration.selectors[0].selector_ref,
            NativeEffigySelectorRef("qa:docs".to_owned())
        );
        assert!(integration.uses_sanitized_refs());
    }

    #[test]
    fn effigy_selector_refresh_preserves_scoped_selector_refs() {
        let repo_scope = NativeEffigyScope::Repo {
            repo_membership_ref: "repo:docs".to_owned(),
            subsystem: Some("docs".to_owned()),
        };
        let refresh = NativeEffigySelectorRefreshSummary::refreshed(
            repo_scope.clone(),
            vec![selector("docs/qa", repo_scope.clone())],
        );

        assert!(refresh.can_update_inventory());
        assert_eq!(refresh.selectors[0].scope, repo_scope);
        assert_eq!(
            refresh.selectors[0].command_scope_hint,
            NativeEffigyCommandScopeHint::Validation
        );
    }

    #[test]
    fn effigy_selector_refresh_rejects_raw_command_output_terms() {
        let mut refresh =
            NativeEffigySelectorRefreshSummary::refreshed(NativeEffigyScope::ProjectRoot, vec![]);
        refresh.summary = Some("raw_stdout should not be retained".to_owned());

        assert!(!refresh.uses_sanitized_refs());
        assert!(!refresh.can_update_inventory());
    }

    #[test]
    fn effigy_health_summary_represents_all_health_states() {
        let statuses = vec![
            NativeEffigyHealthStatus::Ok,
            NativeEffigyHealthStatus::Warning,
            NativeEffigyHealthStatus::Error,
            NativeEffigyHealthStatus::Blocked,
            NativeEffigyHealthStatus::Unknown,
        ];

        for status in statuses {
            let summary = NativeEffigyHealthSummary {
                status: status.clone(),
                scope: NativeEffigyScope::ProjectRoot,
                tool_action_id: Some(NativeToolActionId("tool:effigy-doctor".to_owned())),
                receipt_refs: vec![NativeRuntimeReceiptRef("receipt:effigy:doctor".to_owned())],
                evidence_refs: vec![NativeEffigyEvidenceRef(
                    "evidence:doctor-summary".to_owned(),
                )],
                repair_hints: Vec::new(),
                summary: Some("sanitized doctor summary".to_owned()),
            };

            assert_eq!(summary.status, status);
            assert!(summary.uses_sanitized_refs());
        }
    }

    #[test]
    fn effigy_health_summary_can_carry_repair_hints_without_raw_output() {
        let summary = NativeEffigyHealthSummary {
            status: NativeEffigyHealthStatus::Warning,
            scope: NativeEffigyScope::ProjectRoot,
            tool_action_id: None,
            receipt_refs: Vec::new(),
            evidence_refs: vec![NativeEffigyEvidenceRef(
                "evidence:doctor-warning".to_owned(),
            )],
            repair_hints: vec![NativeEffigyRepairHint {
                kind: NativeEffigyRepairHintKind::DoctorWarning,
                evidence_refs: vec![NativeEffigyEvidenceRef("evidence:repair-hint".to_owned())],
                summary: Some("manifest has a missing health selector".to_owned()),
            }],
            summary: Some("health warning summary".to_owned()),
        };

        assert!(summary.needs_repair());
        assert!(summary.uses_sanitized_refs());
    }

    #[test]
    fn effigy_doctor_command_summary_wraps_health_without_mutation() {
        let health = NativeEffigyHealthSummary {
            status: NativeEffigyHealthStatus::Warning,
            scope: NativeEffigyScope::ProjectRoot,
            tool_action_id: Some(NativeToolActionId("tool:effigy-doctor".to_owned())),
            receipt_refs: vec![NativeRuntimeReceiptRef("receipt:effigy:doctor".to_owned())],
            evidence_refs: vec![NativeEffigyEvidenceRef("evidence:doctor".to_owned())],
            repair_hints: vec![NativeEffigyRepairHint {
                kind: NativeEffigyRepairHintKind::DoctorWarning,
                evidence_refs: vec![NativeEffigyEvidenceRef(
                    "evidence:doctor-warning".to_owned(),
                )],
                summary: Some("doctor reported warning".to_owned()),
            }],
            summary: Some("doctor warning summary".to_owned()),
        };
        let mut doctor = NativeEffigyDoctorCommandSummary::from_health(health);
        doctor.evidence_refs.push(NativeEffigyEvidenceRef(
            "evidence:doctor-command".to_owned(),
        ));
        doctor.summary = Some("doctor command summarized".to_owned());

        assert_eq!(doctor.status, NativeEffigyDoctorCommandStatus::Summarized);
        assert!(doctor.health.needs_repair());
        assert!(!doctor.mutates_project());
        assert!(doctor.uses_sanitized_refs());
    }

    #[test]
    fn effigy_doctor_command_summary_rejects_raw_output_terms() {
        let health = NativeEffigyHealthSummary {
            status: NativeEffigyHealthStatus::Ok,
            scope: NativeEffigyScope::ProjectRoot,
            tool_action_id: None,
            receipt_refs: Vec::new(),
            evidence_refs: Vec::new(),
            repair_hints: Vec::new(),
            summary: Some("raw_stderr should not be retained".to_owned()),
        };
        let doctor = NativeEffigyDoctorCommandSummary::from_health(health);

        assert!(!doctor.uses_sanitized_refs());
    }

    #[test]
    fn effigy_validation_plan_describes_selectors_without_claiming_execution() {
        let mut plan = NativeEffigyValidationPlanSummary::planned_only(
            NativeEffigyScope::ProjectRoot,
            vec![NativeEffigyPlannedSelector {
                selector_ref: NativeEffigySelectorRef("test:rust".to_owned()),
                purpose: NativeEffigyValidationPurpose::Validation,
                command_scope_hint: NativeEffigyCommandScopeHint::Validation,
                evidence_refs: vec![NativeEffigyEvidenceRef("evidence:test-plan".to_owned())],
            }],
        );
        plan.tool_action_id = Some(NativeToolActionId("tool:effigy-test-plan".to_owned()));
        plan.receipt_refs
            .push(NativeRuntimeReceiptRef("receipt:effigy:plan".to_owned()));
        plan.summary = Some("planned rust validation selector".to_owned());

        assert_eq!(plan.status, NativeEffigyValidationPlanStatus::PlannedOnly);
        assert_eq!(plan.planned_selectors.len(), 1);
        assert!(!plan.claims_execution());
        assert!(plan.uses_sanitized_refs());
    }

    #[test]
    fn effigy_test_plan_command_summary_preserves_planned_only_semantics() {
        let mut plan = NativeEffigyValidationPlanSummary::planned_only(
            NativeEffigyScope::ProjectRoot,
            vec![NativeEffigyPlannedSelector {
                selector_ref: NativeEffigySelectorRef("qa:docs".to_owned()),
                purpose: NativeEffigyValidationPurpose::Validation,
                command_scope_hint: NativeEffigyCommandScopeHint::Validation,
                evidence_refs: vec![NativeEffigyEvidenceRef("evidence:plan-selector".to_owned())],
            }],
        );
        plan.tool_action_id = Some(NativeToolActionId("tool:effigy-test-plan".to_owned()));
        plan.receipt_refs.push(NativeRuntimeReceiptRef(
            "receipt:effigy:test-plan".to_owned(),
        ));
        let mut command = NativeEffigyTestPlanCommandSummary::from_validation_plan(plan);
        command.evidence_refs.push(NativeEffigyEvidenceRef(
            "evidence:test-plan-command".to_owned(),
        ));
        command.summary = Some("test plan summarized".to_owned());

        assert_eq!(
            command.status,
            NativeEffigyTestPlanCommandStatus::Summarized
        );
        assert!(!command.claims_test_execution());
        assert_eq!(command.validation_plan.planned_selectors.len(), 1);
        assert!(command.uses_sanitized_refs());
    }

    #[test]
    fn effigy_test_plan_command_summary_rejects_execution_claims() {
        let plan = NativeEffigyValidationPlanSummary {
            status: NativeEffigyValidationPlanStatus::Executed,
            scope: NativeEffigyScope::ProjectRoot,
            tool_action_id: None,
            planned_selectors: Vec::new(),
            receipt_refs: Vec::new(),
            evidence_refs: Vec::new(),
            repair_hints: Vec::new(),
            summary: Some("execution should be separate".to_owned()),
        };
        let command = NativeEffigyTestPlanCommandSummary::from_validation_plan(plan);

        assert_eq!(
            command.status,
            NativeEffigyTestPlanCommandStatus::ExecutionOutOfScope
        );
        assert!(command.claims_test_execution());
    }

    #[test]
    fn effigy_repair_synthesis_creates_review_only_steward_proposal() {
        let mut synthesis = NativeEffigyRepairSynthesis::from_repair_hints(
            NativeEffigyRepairSource::Doctor,
            vec![NativeEffigyRepairHint {
                kind: NativeEffigyRepairHintKind::DoctorWarning,
                evidence_refs: vec![NativeEffigyEvidenceRef(
                    "evidence:doctor-warning".to_owned(),
                )],
                summary: Some("doctor warning needs review".to_owned()),
            }],
        );
        synthesis.evidence_refs.push(NativeEffigyEvidenceRef(
            "evidence:doctor-warning".to_owned(),
        ));
        synthesis.summary = Some("prepare Effigy repair proposal".to_owned());

        let proposal = synthesis
            .to_steward_proposal(
                NativeStewardProposalId("proposal:effigy-repair".to_owned()),
                NativeStewardProposalTarget::ManagementProjection {
                    projection_ref: "projection:effigy".to_owned(),
                },
            )
            .expect("repair proposal");

        assert_eq!(
            synthesis.status,
            NativeEffigyRepairSynthesisStatus::ProposalReady
        );
        assert!(!synthesis.mutates_manifest_or_scripts());
        assert!(synthesis.uses_sanitized_refs());
        assert_eq!(
            proposal.review,
            NativeStewardProposalReview::NeedsHumanApproval
        );
        assert!(!proposal.has_applied_mutation_state());
        assert_eq!(proposal.evidence_refs.len(), 1);
    }

    #[test]
    fn effigy_repair_synthesis_without_hints_does_not_create_proposal() {
        let synthesis = NativeEffigyRepairSynthesis::from_repair_hints(
            NativeEffigyRepairSource::SelectorRefresh,
            Vec::new(),
        );

        assert_eq!(
            synthesis.status,
            NativeEffigyRepairSynthesisStatus::NoRepairNeeded
        );
        assert!(synthesis
            .to_steward_proposal(
                NativeStewardProposalId("proposal:none".to_owned()),
                NativeStewardProposalTarget::Custom("none".to_owned()),
            )
            .is_none());
    }

    #[test]
    fn effigy_repair_synthesis_rejects_raw_refs() {
        let mut synthesis = NativeEffigyRepairSynthesis::from_repair_hints(
            NativeEffigyRepairSource::TestPlan,
            vec![NativeEffigyRepairHint {
                kind: NativeEffigyRepairHintKind::PlanUnavailable,
                evidence_refs: Vec::new(),
                summary: Some("raw_stdout should not be retained".to_owned()),
            }],
        );
        synthesis
            .evidence_refs
            .push(NativeEffigyEvidenceRef("evidence:plan".to_owned()));

        assert!(!synthesis.uses_sanitized_refs());
        assert!(synthesis
            .to_steward_proposal(
                NativeStewardProposalId("proposal:raw".to_owned()),
                NativeStewardProposalTarget::Custom("raw".to_owned()),
            )
            .is_none());
    }

    #[test]
    fn effigy_validation_plan_rejects_raw_output_refs() {
        let mut plan =
            NativeEffigyValidationPlanSummary::planned_only(NativeEffigyScope::ProjectRoot, vec![]);
        plan.summary = Some("raw_stderr should not be persisted".to_owned());

        assert!(!plan.uses_sanitized_refs());
    }
}
