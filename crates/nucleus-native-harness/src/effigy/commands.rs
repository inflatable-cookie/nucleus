use super::health::{NativeEffigyHealthStatus, NativeEffigyHealthSummary};
use super::integration::NativeEffigyEvidenceRef;
use super::safety::contains_forbidden_effigy_term;
use super::validation::{NativeEffigyValidationPlanStatus, NativeEffigyValidationPlanSummary};

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
