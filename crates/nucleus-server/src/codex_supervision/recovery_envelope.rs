//! Codex recovery provider envelope records.
//!
//! Envelope records describe a future `thread/resume` send. They do not write
//! to stdio, resume Codex, retain raw payloads, or mutate task state.

use super::recovery_admission::{
    CodexAppServerRecoveryAdmission, CodexAppServerRecoveryAdmissionStatus,
};
use super::recovery_need::CodexAppServerRecoveryNeedRecord;

/// Stable id for one recovery provider envelope record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerRecoveryEnvelopeId(pub String);

/// Sanitized provider envelope record for a future Codex thread resume.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRecoveryEnvelopeRecord {
    pub envelope_id: CodexAppServerRecoveryEnvelopeId,
    pub admission_id: String,
    pub need_id: String,
    pub method: String,
    pub runtime_instance_id: String,
    pub session_id: String,
    pub provider_thread_id: String,
    pub provider_turn_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub task_id: String,
    pub work_item_id: String,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub provider_send_started: bool,
    pub replacement_thread_allowed: bool,
    pub task_mutation_permitted: bool,
}

/// Rejection before a recovery envelope can exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRecoveryEnvelopeRejection {
    AdmissionNotAccepted(String),
    AdmissionNeedMismatch {
        need_id: String,
        admission_need_id: String,
    },
    MissingProviderThreadId,
}

/// Build a sanitized provider envelope for an accepted recovery admission.
pub fn codex_recovery_envelope(
    need: &CodexAppServerRecoveryNeedRecord,
    admission: &CodexAppServerRecoveryAdmission,
) -> Result<CodexAppServerRecoveryEnvelopeRecord, CodexAppServerRecoveryEnvelopeRejection> {
    if need.need_id.0 != admission.need_id {
        return Err(
            CodexAppServerRecoveryEnvelopeRejection::AdmissionNeedMismatch {
                need_id: need.need_id.0.clone(),
                admission_need_id: admission.need_id.clone(),
            },
        );
    }

    match &admission.status {
        CodexAppServerRecoveryAdmissionStatus::Accepted => {}
        CodexAppServerRecoveryAdmissionStatus::Blocked(reason)
        | CodexAppServerRecoveryAdmissionStatus::Unsupported(reason) => {
            return Err(
                CodexAppServerRecoveryEnvelopeRejection::AdmissionNotAccepted(reason.clone()),
            );
        }
    }

    let provider_thread_id = need
        .provider_thread_id
        .clone()
        .ok_or(CodexAppServerRecoveryEnvelopeRejection::MissingProviderThreadId)?;

    Ok(CodexAppServerRecoveryEnvelopeRecord {
        envelope_id: CodexAppServerRecoveryEnvelopeId(format!(
            "codex-recovery-envelope:{}",
            need.need_id.0
        )),
        admission_id: admission.admission_id.0.clone(),
        need_id: need.need_id.0.clone(),
        method: "thread/resume".to_owned(),
        runtime_instance_id: need.runtime_instance_id.clone(),
        session_id: need.session_id.0.clone(),
        provider_thread_id,
        provider_turn_id: need.provider_turn_id.clone(),
        provider_request_id: need.provider_request_id.clone(),
        task_id: need.task_id.0.clone(),
        work_item_id: need.work_item_id.0.clone(),
        evidence_refs: admission.evidence_refs.clone(),
        raw_payload_retained: false,
        provider_send_started: false,
        replacement_thread_allowed: false,
        task_mutation_permitted: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_recovery, codex_recovery_need_record,
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

    fn accepted_admission(
        need: CodexAppServerRecoveryNeedRecord,
    ) -> CodexAppServerRecoveryAdmission {
        admit_codex_recovery(CodexAppServerRecoveryAdmissionInput {
            need,
            recovery_authority_confirmed: true,
            runtime_ready_evidence_refs: vec!["evidence:runtime-ready".to_owned()],
            provider_identity_evidence_refs: vec!["evidence:provider-thread".to_owned()],
            resume_capability: CodexAppServerRecoveryCapability::ThreadResumeSupported,
            replacement_thread_observed: false,
            raw_payload_policy_confirmed: true,
        })
    }

    #[test]
    fn recovery_envelope_maps_accepted_admission_without_provider_send() {
        let need = need();
        let admission = accepted_admission(need.clone());
        let envelope = codex_recovery_envelope(&need, &admission).expect("envelope");

        assert_eq!(envelope.method, "thread/resume");
        assert_eq!(envelope.need_id, need.need_id.0);
        assert_eq!(envelope.admission_id, admission.admission_id.0);
        assert_eq!(envelope.session_id, "session:1");
        assert_eq!(envelope.provider_thread_id, "thread:provider:1");
        assert_eq!(
            envelope.provider_turn_id.as_deref(),
            Some("turn:provider:1")
        );
        assert_eq!(
            envelope.provider_request_id.as_deref(),
            Some("request:provider:1")
        );
        assert_eq!(envelope.task_id, "task:1");
        assert_eq!(envelope.work_item_id, "work:1");
        assert!(!envelope.raw_payload_retained);
        assert!(!envelope.provider_send_started);
        assert!(!envelope.replacement_thread_allowed);
        assert!(!envelope.task_mutation_permitted);
    }

    #[test]
    fn recovery_envelope_rejects_blocked_or_mismatched_admission() {
        let need = need();
        let blocked = admit_codex_recovery(CodexAppServerRecoveryAdmissionInput {
            need: need.clone(),
            recovery_authority_confirmed: false,
            runtime_ready_evidence_refs: vec!["evidence:runtime-ready".to_owned()],
            provider_identity_evidence_refs: vec!["evidence:provider-thread".to_owned()],
            resume_capability: CodexAppServerRecoveryCapability::ThreadResumeSupported,
            replacement_thread_observed: false,
            raw_payload_policy_confirmed: true,
        });

        let rejection = codex_recovery_envelope(&need, &blocked).expect_err("blocked");
        assert!(matches!(
            rejection,
            CodexAppServerRecoveryEnvelopeRejection::AdmissionNotAccepted(_)
        ));

        let other_need = codex_recovery_need_record(
            &runtime(),
            &session_binding(),
            None,
            None,
            task_id(),
            work_item_id(),
            CodexAppServerRecoveryTrigger::ServerRestart {
                restart_summary: "server restarted".to_owned(),
            },
            summary_ref(),
            metadata_only(),
        )
        .expect("other need");
        let accepted = accepted_admission(other_need);
        let rejection = codex_recovery_envelope(&need, &accepted).expect_err("mismatch");
        assert!(matches!(
            rejection,
            CodexAppServerRecoveryEnvelopeRejection::AdmissionNeedMismatch { .. }
        ));
    }
}
