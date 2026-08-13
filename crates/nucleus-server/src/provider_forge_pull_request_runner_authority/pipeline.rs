//! Delivery-pipeline helpers for the admitted per-delivery PR-creation lane:
//! the preflight set built from the pipeline's observed checks and the first
//! implementation's forge adapter route.
//!
//! The pipeline invokes `run_forge_pull_request_creation` only after the gated
//! push, under the confirmed delivery intent carrying PR-creation scope, and
//! only through this module's admitted adapter — never a bare forge call.

use crate::{
    ForgePullRequestCreationError, ForgePullRequestCreationScope,
    ForgePullRequestCreationTestDouble, ForgePullRequestExecutionPreflightBlocker,
    ForgePullRequestExecutionPreflightRecord, ForgePullRequestExecutionPreflightSet,
    ForgePullRequestExecutionPreflightStatus,
};

/// Build the admitted preflight set for one delivery PR-creation lane.
///
/// The checks are the pipeline's observed evidence: the run's own branch was
/// pushed (remote branch visible) and a ready forge credential is recorded.
/// The preflight refs mirror the confirmed scope so the authority chain's
/// scope-drift check passes; a failing check carries its blocker and keeps
/// the preflight blocked, preserving the branch-only delivery with an
/// explaining receipt.
pub fn delivery_pull_request_creation_preflights(
    operator_ref: &str,
    idempotency_key: &str,
    scope: &ForgePullRequestCreationScope,
    remote_branch_visible: bool,
    forge_credential_ready: bool,
) -> ForgePullRequestExecutionPreflightSet {
    let mut blockers = Vec::new();
    if !forge_credential_ready {
        blockers.push(ForgePullRequestExecutionPreflightBlocker::ForgeCredentialNotReady);
    }
    if !remote_branch_visible {
        blockers.push(ForgePullRequestExecutionPreflightBlocker::RemoteBranchNotVisible);
    }
    let ready = blockers.is_empty();
    ForgePullRequestExecutionPreflightSet {
        preflight_set_id: format!("preflight-set:{idempotency_key}"),
        preflights: vec![ForgePullRequestExecutionPreflightRecord {
            preflight_id: format!("preflight:{idempotency_key}"),
            admission_id: format!("admission:{idempotency_key}"),
            pr_evidence_id: format!("pr-evidence:{idempotency_key}"),
            pr_descriptor_id: format!("pr-descriptor:{idempotency_key}"),
            push_preflight_id: format!("push-preflight:{idempotency_key}"),
            request_id: format!("request:{idempotency_key}"),
            authority_id: format!("upstream-authority:{idempotency_key}"),
            git_plan_id: format!("git-plan:{idempotency_key}"),
            task_id: format!("task:{idempotency_key}"),
            repo_id: format!("repo:{idempotency_key}"),
            operator_ref: operator_ref.to_owned(),
            remote_target: None,
            forge_provider: Some(scope.forge_provider.clone()),
            base_branch: Some(scope.base_branch.clone()),
            head_branch: Some(scope.head_branch.clone()),
            title_source: Some(scope.title_source.clone()),
            body_source: Some(scope.body_source.clone()),
            status: if ready {
                ForgePullRequestExecutionPreflightStatus::Ready
            } else {
                ForgePullRequestExecutionPreflightStatus::Blocked
            },
            blockers,
            pull_request_created: false,
            forge_effect_executed: false,
            provider_effect_executed: false,
            raw_output_retained: false,
        }],
        skipped_admission_ids: if ready {
            Vec::new()
        } else {
            vec![format!("admission:{idempotency_key}")]
        },
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        raw_output_retained: false,
    }
}

/// The first implementation's admitted forge route for delivery PR creation:
/// the forge test double configured to report that no real provider route is
/// admitted yet. Real provider routes require their own explicit lane; until
/// then a confirmed PR-creation lane records an honest unavailable-route
/// outcome and the branch-only delivery stands.
pub fn admitted_delivery_forge_adapter() -> ForgePullRequestCreationTestDouble {
    ForgePullRequestCreationTestDouble::new(
        None,
        Err(ForgePullRequestCreationError::ProviderUnavailable {
            reason: "no admitted forge provider route; real provider routes require their own lane"
                .to_owned(),
        }),
    )
}

#[cfg(test)]
mod tests {
    use crate::{
        ForgePullRequestCreationAdapter, ForgePullRequestExecutionPreflightBlocker,
        ForgePullRequestExecutionPreflightStatus, ForgePullRequestProvider,
        ForgePullRequestTextSource,
    };

    use super::*;

    fn scope() -> ForgePullRequestCreationScope {
        ForgePullRequestCreationScope {
            forge_provider: ForgePullRequestProvider::GitHub,
            base_branch: "main".to_owned(),
            head_branch: "run/fixture".to_owned(),
            title_source: ForgePullRequestTextSource::GeneratedFromEvidence,
            body_source: ForgePullRequestTextSource::GeneratedFromEvidence,
        }
    }

    #[test]
    fn ready_when_credential_and_remote_branch_visible() {
        let set = delivery_pull_request_creation_preflights(
            "operator:tom",
            "fixture-ready",
            &scope(),
            true,
            true,
        );
        assert_eq!(set.preflights.len(), 1);
        assert_eq!(
            set.preflights[0].status,
            ForgePullRequestExecutionPreflightStatus::Ready
        );
        assert!(set.preflights[0].blockers.is_empty());
        assert!(set.skipped_admission_ids.is_empty());
        assert_eq!(
            set.preflights[0].forge_provider,
            Some(ForgePullRequestProvider::GitHub)
        );
        assert_eq!(set.preflights[0].head_branch.as_deref(), Some("run/fixture"));
    }

    #[test]
    fn missing_credential_blocks_with_explaining_blocker() {
        let set = delivery_pull_request_creation_preflights(
            "operator:tom",
            "fixture-no-credential",
            &scope(),
            true,
            false,
        );
        assert_eq!(
            set.preflights[0].status,
            ForgePullRequestExecutionPreflightStatus::Blocked
        );
        assert!(set.preflights[0]
            .blockers
            .contains(&ForgePullRequestExecutionPreflightBlocker::ForgeCredentialNotReady));
        assert_eq!(
            set.skipped_admission_ids,
            vec!["admission:fixture-no-credential".to_owned()]
        );
    }

    #[test]
    fn unpushed_branch_blocks_with_visibility_blocker() {
        let set = delivery_pull_request_creation_preflights(
            "operator:tom",
            "fixture-unpushed",
            &scope(),
            false,
            true,
        );
        assert_eq!(
            set.preflights[0].status,
            ForgePullRequestExecutionPreflightStatus::Blocked
        );
        assert!(set.preflights[0]
            .blockers
            .contains(&ForgePullRequestExecutionPreflightBlocker::RemoteBranchNotVisible));
    }

    #[test]
    fn admitted_default_adapter_reports_no_admitted_route() {
        let adapter = admitted_delivery_forge_adapter();
        let request = crate::ForgePullRequestCreationRequest {
            run_id: "run:fixture".to_owned(),
            remote_target: "origin".to_owned(),
            forge_provider: ForgePullRequestProvider::GitHub,
            base_branch: "main".to_owned(),
            head_branch: "run/fixture".to_owned(),
            title_source: ForgePullRequestTextSource::GeneratedFromEvidence,
            body_source: ForgePullRequestTextSource::GeneratedFromEvidence,
        };
        assert!(adapter
            .find_existing_pull_request(&request)
            .expect("reconcile")
            .is_none());
        let error = adapter.open_pull_request(&request).expect_err("no route");
        assert!(matches!(
            error,
            ForgePullRequestCreationError::ProviderUnavailable { .. }
        ));
    }
}
