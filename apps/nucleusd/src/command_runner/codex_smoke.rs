use crate::cli::CliCodexTurnStartRealWriteSmoke;

mod fixtures;
mod labels;
mod live;

use fixtures::{authority, envelope, execution};
use labels::{blocker_label, boundary_status_label};
use nucleus_server::{
    codex_transport_executor_diagnostics, codex_turn_start_executor_smoke_boundary,
    CodexAppServerTransportExecutorConfirmationScope,
    CodexAppServerTransportExecutorOperatorConfirmation,
    CodexAppServerTurnStartExecutorSmokeBoundaryInput,
    CodexAppServerTurnStartExecutorSmokeBoundaryRecord,
    CodexAppServerTurnStartExecutorSmokeBoundaryStatus, CodexAppServerTurnStartExecutorSmokeIntent,
};

pub(crate) fn print_codex_turn_start_real_write_smoke(
    command: CliCodexTurnStartRealWriteSmoke,
) -> Result<(), String> {
    let boundary = build_codex_turn_start_real_write_smoke_boundary(command.confirm_real_write);

    println!("codex_turn_start_real_write_smoke=boundary");
    println!("confirm_real_write={}", command.confirm_real_write);
    println!("status={}", boundary_status_label(&boundary.status));
    println!(
        "boundary_provider_write_executed={}",
        boundary.provider_write_executed
    );
    println!("raw_payload_retained={}", boundary.raw_payload_retained);
    println!("raw_stream_retained={}", boundary.raw_stream_retained);
    println!(
        "task_mutation_permitted={}",
        boundary.task_mutation_permitted
    );
    println!("write_attempt_id={}", boundary.write_attempt_id);
    println!("receipt_id={}", boundary.receipt_id);
    println!("evidence_refs={}", boundary.evidence_refs.len());
    if let CodexAppServerTurnStartExecutorSmokeBoundaryStatus::Blocked(blockers) = &boundary.status
    {
        println!("blockers={}", blockers.len());
        for blocker in blockers {
            println!("blocker={}", blocker_label(blocker));
        }
    }
    if command.execute_provider_write {
        println!("execute_provider_write=true");
        let outcome = live::run_live_codex_turn_start_smoke(&boundary)?;
        println!("live_smoke_status={}", outcome.status_label());
        println!(
            "provider_write_executed={}",
            outcome.provider_write_executed
        );
        println!(
            "thread_id={}",
            outcome.thread_id.as_deref().unwrap_or("none")
        );
        println!("turn_id={}", outcome.turn_id.as_deref().unwrap_or("none"));
        println!(
            "turn_status={}",
            outcome.turn_status.as_deref().unwrap_or("none")
        );
        println!("notifications_seen={}", outcome.notifications_seen);
        println!("server_requests_seen={}", outcome.server_requests_seen);
        println!("raw_payload_retained=false");
        println!("raw_stream_retained=false");
        println!("task_mutation_permitted=false");
    } else {
        println!("execute_provider_write=false");
        println!("provider_write_executed=false");
    }

    Ok(())
}

fn build_codex_turn_start_real_write_smoke_boundary(
    confirm_real_write: bool,
) -> CodexAppServerTurnStartExecutorSmokeBoundaryRecord {
    let authority = authority();
    let envelope = envelope();
    let execution = execution();
    let diagnostics = codex_transport_executor_diagnostics(
        &[],
        &[authority.clone()],
        &[envelope.clone()],
        &[execution.clone()],
        &[],
        &[],
        &[],
    );
    let smoke_intent = if confirm_real_write {
        CodexAppServerTurnStartExecutorSmokeIntent::RealProviderWriteSmokeRequested {
            evidence_ref: "evidence:nucleusd-confirm-real-write".to_owned(),
        }
    } else {
        CodexAppServerTurnStartExecutorSmokeIntent::DisabledByDefault
    };
    let operator_confirmation = if confirm_real_write {
        CodexAppServerTransportExecutorOperatorConfirmation::Confirmed {
            operator_ref: "operator:nucleusd-cli".to_owned(),
            evidence_ref: "evidence:nucleusd-confirm-real-write".to_owned(),
            scope: CodexAppServerTransportExecutorConfirmationScope::RealProviderWriteSmoke,
        }
    } else {
        CodexAppServerTransportExecutorOperatorConfirmation::Missing
    };

    codex_turn_start_executor_smoke_boundary(CodexAppServerTurnStartExecutorSmokeBoundaryInput {
        authority,
        envelope,
        execution,
        diagnostics,
        smoke_intent,
        operator_confirmation,
        raw_payload_policy_confirmed: true,
        raw_stream_policy_confirmed: true,
        task_mutation_requested: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_server::CodexAppServerTurnStartExecutorSmokeBoundaryBlocker;

    #[test]
    fn codex_smoke_boundary_is_blocked_without_confirm_flag() {
        let boundary = build_codex_turn_start_real_write_smoke_boundary(false);

        assert!(matches!(
            boundary.status,
            CodexAppServerTurnStartExecutorSmokeBoundaryStatus::Blocked(blockers)
                if blockers.contains(&CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::SmokeIntentDisabledByDefault)
                    && blockers.contains(&CodexAppServerTurnStartExecutorSmokeBoundaryBlocker::OperatorConfirmationMissing)
        ));
        assert!(!boundary.provider_write_executed);
    }

    #[test]
    fn codex_smoke_boundary_can_be_eligible_with_confirm_flag() {
        let boundary = build_codex_turn_start_real_write_smoke_boundary(true);

        assert_eq!(
            boundary.status,
            CodexAppServerTurnStartExecutorSmokeBoundaryStatus::EligibleForSeparatelyConfirmedRealWriteSmoke
        );
        assert!(!boundary.provider_write_executed);
        assert!(!boundary.task_mutation_permitted);
    }
}
