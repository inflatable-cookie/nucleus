//! Codex recovery outcome and receipt records.
//!
//! Outcome records summarize recovery admission/envelope state. They do not
//! send provider messages, retain raw payloads, or mutate task state.

use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};

use super::recovery_admission::{
    CodexAppServerRecoveryAdmission, CodexAppServerRecoveryAdmissionBlocker,
    CodexAppServerRecoveryAdmissionStatus,
};
use super::recovery_envelope::CodexAppServerRecoveryEnvelopeRecord;
use super::recovery_need::CodexAppServerRecoveryNeedRecord;

/// Stable id for one recovery outcome record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerRecoveryOutcomeId(pub String);

/// Sanitized recovery outcome record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryOutcomeRecord {
    pub outcome_id: CodexAppServerRecoveryOutcomeId,
    pub need_id: String,
    pub admission_id: Option<String>,
    pub envelope_id: Option<String>,
    pub provider_thread_id: Option<String>,
    pub replacement_thread_id: Option<String>,
    pub status: CodexAppServerRecoveryOutcomeStatus,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub task_mutation_permitted: bool,
    pub summary: String,
}

/// Recovery outcome status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryOutcomeStatus {
    ResumeAccepted,
    Blocked(String),
    RepairRequired(String),
    ReplacementThreadObserved(String),
    Failed(String),
    Unsupported(String),
}

/// Build a recovery outcome from admission before envelope mapping.
pub fn codex_recovery_outcome_from_admission(
    admission: &CodexAppServerRecoveryAdmission,
) -> CodexAppServerRecoveryOutcomeRecord {
    let status = match &admission.status {
        CodexAppServerRecoveryAdmissionStatus::Accepted => {
            CodexAppServerRecoveryOutcomeStatus::ResumeAccepted
        }
        CodexAppServerRecoveryAdmissionStatus::Blocked(reason) => {
            CodexAppServerRecoveryOutcomeStatus::Blocked(reason.clone())
        }
        CodexAppServerRecoveryAdmissionStatus::Unsupported(reason)
            if admission.blockers.iter().any(is_repair_only) =>
        {
            CodexAppServerRecoveryOutcomeStatus::RepairRequired(reason.clone())
        }
        CodexAppServerRecoveryAdmissionStatus::Unsupported(reason) => {
            CodexAppServerRecoveryOutcomeStatus::Unsupported(reason.clone())
        }
    };

    outcome_record(
        &admission.need_id,
        Some(admission.admission_id.0.clone()),
        None,
        admission.provider_thread_id.clone(),
        None,
        status,
        admission.evidence_refs.clone(),
    )
}

/// Build a recovery outcome from a sanitized envelope record.
pub fn codex_recovery_outcome_from_envelope(
    envelope: &CodexAppServerRecoveryEnvelopeRecord,
) -> CodexAppServerRecoveryOutcomeRecord {
    outcome_record(
        &envelope.need_id,
        Some(envelope.admission_id.clone()),
        Some(envelope.envelope_id.0.clone()),
        Some(envelope.provider_thread_id.clone()),
        None,
        CodexAppServerRecoveryOutcomeStatus::ResumeAccepted,
        envelope.evidence_refs.clone(),
    )
}

/// Build a failed recovery outcome without retaining provider payloads.
pub fn codex_recovery_failed_outcome(
    need: &CodexAppServerRecoveryNeedRecord,
    reason: String,
    evidence_refs: Vec<String>,
) -> CodexAppServerRecoveryOutcomeRecord {
    outcome_record(
        &need.need_id.0,
        None,
        None,
        need.provider_thread_id.clone(),
        None,
        CodexAppServerRecoveryOutcomeStatus::Failed(reason),
        evidence_refs,
    )
}

/// Build an explicit replacement-thread recovery outcome.
pub fn codex_recovery_replacement_thread_outcome(
    envelope: &CodexAppServerRecoveryEnvelopeRecord,
    replacement_thread_id: String,
    reason: String,
    evidence_refs: Vec<String>,
) -> CodexAppServerRecoveryOutcomeRecord {
    let mut refs = envelope.evidence_refs.clone();
    refs.extend(evidence_refs);
    outcome_record(
        &envelope.need_id,
        Some(envelope.admission_id.clone()),
        Some(envelope.envelope_id.0.clone()),
        Some(envelope.provider_thread_id.clone()),
        Some(replacement_thread_id),
        CodexAppServerRecoveryOutcomeStatus::ReplacementThreadObserved(reason),
        refs,
    )
}

/// Convert a recovery outcome into a runtime receipt.
pub fn codex_receipt_from_recovery_outcome(
    outcome: &CodexAppServerRecoveryOutcomeRecord,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:{}:recovery",
            outcome.outcome_id.0
        )),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: receipt_status(&outcome.status),
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(outcome.need_id.clone())),
        evidence_refs: outcome
            .evidence_refs
            .iter()
            .map(|value| EngineRuntimeReceiptRef::Custom(value.clone()))
            .collect(),
        artifact_refs: Vec::new(),
        summary: Some(outcome.summary.clone()),
    }
}

fn outcome_record(
    need_id: &str,
    admission_id: Option<String>,
    envelope_id: Option<String>,
    provider_thread_id: Option<String>,
    replacement_thread_id: Option<String>,
    status: CodexAppServerRecoveryOutcomeStatus,
    evidence_refs: Vec<String>,
) -> CodexAppServerRecoveryOutcomeRecord {
    let label = status_label(&status);
    CodexAppServerRecoveryOutcomeRecord {
        outcome_id: CodexAppServerRecoveryOutcomeId(format!(
            "codex-recovery-outcome:{need_id}:{label}"
        )),
        need_id: need_id.to_owned(),
        admission_id,
        envelope_id,
        provider_thread_id,
        replacement_thread_id,
        summary: outcome_summary(&status),
        status,
        evidence_refs,
        raw_payload_retained: false,
        task_mutation_permitted: false,
    }
}

fn is_repair_only(blocker: &CodexAppServerRecoveryAdmissionBlocker) -> bool {
    matches!(
        blocker,
        CodexAppServerRecoveryAdmissionBlocker::RepairOnly(_)
    )
}

fn receipt_status(status: &CodexAppServerRecoveryOutcomeStatus) -> EngineRuntimeReceiptStatus {
    match status {
        CodexAppServerRecoveryOutcomeStatus::ResumeAccepted => EngineRuntimeReceiptStatus::Accepted,
        CodexAppServerRecoveryOutcomeStatus::Blocked(_) => EngineRuntimeReceiptStatus::Blocked,
        CodexAppServerRecoveryOutcomeStatus::RepairRequired(_)
        | CodexAppServerRecoveryOutcomeStatus::ReplacementThreadObserved(_) => {
            EngineRuntimeReceiptStatus::RecoveryRequired
        }
        CodexAppServerRecoveryOutcomeStatus::Failed(_) => EngineRuntimeReceiptStatus::Failed,
        CodexAppServerRecoveryOutcomeStatus::Unsupported(_) => EngineRuntimeReceiptStatus::Blocked,
    }
}

fn status_label(status: &CodexAppServerRecoveryOutcomeStatus) -> &'static str {
    match status {
        CodexAppServerRecoveryOutcomeStatus::ResumeAccepted => "resume-accepted",
        CodexAppServerRecoveryOutcomeStatus::Blocked(_) => "blocked",
        CodexAppServerRecoveryOutcomeStatus::RepairRequired(_) => "repair-required",
        CodexAppServerRecoveryOutcomeStatus::ReplacementThreadObserved(_) => {
            "replacement-thread-observed"
        }
        CodexAppServerRecoveryOutcomeStatus::Failed(_) => "failed",
        CodexAppServerRecoveryOutcomeStatus::Unsupported(_) => "unsupported",
    }
}

fn outcome_summary(status: &CodexAppServerRecoveryOutcomeStatus) -> String {
    match status {
        CodexAppServerRecoveryOutcomeStatus::ResumeAccepted => {
            "Codex recovery resume accepted before provider send".to_owned()
        }
        CodexAppServerRecoveryOutcomeStatus::Blocked(reason) => {
            format!("Codex recovery blocked: {reason}")
        }
        CodexAppServerRecoveryOutcomeStatus::RepairRequired(reason) => {
            format!("Codex recovery requires repair: {reason}")
        }
        CodexAppServerRecoveryOutcomeStatus::ReplacementThreadObserved(reason) => {
            format!("Codex recovery observed replacement thread: {reason}")
        }
        CodexAppServerRecoveryOutcomeStatus::Failed(reason) => {
            format!("Codex recovery failed: {reason}")
        }
        CodexAppServerRecoveryOutcomeStatus::Unsupported(reason) => {
            format!("Codex recovery unsupported: {reason}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_recovery, codex_recovery_envelope, codex_recovery_need_record,
        test_support::{metadata_only, runtime, session_binding, task_id, work_item_id},
        CodexAppServerRecoveryAdmissionInput, CodexAppServerRecoveryCapability,
        CodexAppServerRecoverySummaryRef, CodexAppServerRecoveryTrigger,
    };

    fn summary_ref() -> CodexAppServerRecoverySummaryRef {
        CodexAppServerRecoverySummaryRef {
            summary_ref: "recovery-summary:1".to_owned(),
            summary: "Codex process exited while a task-backed turn was active".to_owned(),
        }
    }

    fn need() -> CodexAppServerRecoveryNeedRecord {
        codex_recovery_need_record(
            &runtime(),
            &session_binding(),
            Some("turn:provider:1".to_owned()),
            Some("request:provider:1".to_owned()),
            task_id(),
            work_item_id(),
            CodexAppServerRecoveryTrigger::ProcessExit {
                exit_summary: "process exited before terminal turn event".to_owned(),
            },
            summary_ref(),
            metadata_only(),
        )
        .expect("recovery need")
    }

    fn admission(
        need: CodexAppServerRecoveryNeedRecord,
        capability: CodexAppServerRecoveryCapability,
        authority: bool,
    ) -> CodexAppServerRecoveryAdmission {
        admit_codex_recovery(CodexAppServerRecoveryAdmissionInput {
            need,
            recovery_authority_confirmed: authority,
            runtime_ready_evidence_refs: vec!["evidence:runtime-ready".to_owned()],
            provider_identity_evidence_refs: vec!["evidence:provider-thread".to_owned()],
            resume_capability: capability,
            replacement_thread_observed: false,
            raw_payload_policy_confirmed: true,
        })
    }

    #[test]
    fn recovery_outcome_from_envelope_receipts_are_sanitized_resume_intent() {
        let need = need();
        let admission = admission(
            need.clone(),
            CodexAppServerRecoveryCapability::ThreadResumeSupported,
            true,
        );
        let envelope = codex_recovery_envelope(&need, &admission).expect("envelope");
        let outcome = codex_recovery_outcome_from_envelope(&envelope);
        let receipt = codex_receipt_from_recovery_outcome(&outcome);

        assert_eq!(
            outcome.status,
            CodexAppServerRecoveryOutcomeStatus::ResumeAccepted
        );
        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Accepted);
        assert_eq!(
            outcome.provider_thread_id,
            Some("thread:provider:1".to_owned())
        );
        assert!(outcome.envelope_id.is_some());
        assert!(!outcome.raw_payload_retained);
        assert!(!outcome.task_mutation_permitted);
        assert!(receipt.artifact_refs.is_empty());
    }

    #[test]
    fn recovery_outcome_maps_blocked_repair_unsupported_and_failed_states() {
        let need = need();
        let blocked = admission(
            need.clone(),
            CodexAppServerRecoveryCapability::ThreadResumeSupported,
            false,
        );
        let blocked_outcome = codex_recovery_outcome_from_admission(&blocked);
        let blocked_receipt = codex_receipt_from_recovery_outcome(&blocked_outcome);
        assert_eq!(blocked_receipt.status, EngineRuntimeReceiptStatus::Blocked);

        let repair = admission(
            need.clone(),
            CodexAppServerRecoveryCapability::RepairOnly(
                "provider thread missing; manual repair required".to_owned(),
            ),
            true,
        );
        let repair_outcome = codex_recovery_outcome_from_admission(&repair);
        let repair_receipt = codex_receipt_from_recovery_outcome(&repair_outcome);
        assert!(matches!(
            repair_outcome.status,
            CodexAppServerRecoveryOutcomeStatus::RepairRequired(_)
        ));
        assert_eq!(
            repair_receipt.status,
            EngineRuntimeReceiptStatus::RecoveryRequired
        );

        let unsupported = admission(
            need.clone(),
            CodexAppServerRecoveryCapability::Unsupported("thread/resume unavailable".to_owned()),
            true,
        );
        let unsupported_outcome = codex_recovery_outcome_from_admission(&unsupported);
        assert!(matches!(
            unsupported_outcome.status,
            CodexAppServerRecoveryOutcomeStatus::Unsupported(_)
        ));

        let failed_outcome = codex_recovery_failed_outcome(
            &need,
            "provider write failed".to_owned(),
            vec!["evidence:write".to_owned()],
        );
        let failed_receipt = codex_receipt_from_recovery_outcome(&failed_outcome);
        assert_eq!(failed_receipt.status, EngineRuntimeReceiptStatus::Failed);
        assert!(!failed_outcome.raw_payload_retained);
    }

    #[test]
    fn replacement_thread_outcome_stays_recovery_required() {
        let need = need();
        let admission = admission(
            need.clone(),
            CodexAppServerRecoveryCapability::ThreadResumeSupported,
            true,
        );
        let envelope = codex_recovery_envelope(&need, &admission).expect("envelope");
        let outcome = codex_recovery_replacement_thread_outcome(
            &envelope,
            "thread:replacement".to_owned(),
            "thread/resume produced a replacement thread".to_owned(),
            vec!["evidence:replacement".to_owned()],
        );
        let receipt = codex_receipt_from_recovery_outcome(&outcome);

        assert!(matches!(
            outcome.status,
            CodexAppServerRecoveryOutcomeStatus::ReplacementThreadObserved(_)
        ));
        assert_eq!(
            outcome.replacement_thread_id,
            Some("thread:replacement".to_owned())
        );
        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::RecoveryRequired);
        assert!(!outcome.task_mutation_permitted);
    }
}
