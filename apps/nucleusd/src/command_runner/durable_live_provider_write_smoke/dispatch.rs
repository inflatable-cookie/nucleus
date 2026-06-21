use crate::cli::CliDurableLiveProviderWriteSmoke;

use nucleus_server::{DurableCodexLiveSmokeDispatchRunInput, DurableCodexLiveSmokeIntent};

pub(super) fn dispatch_input(
    command: &CliDurableLiveProviderWriteSmoke,
) -> DurableCodexLiveSmokeDispatchRunInput {
    DurableCodexLiveSmokeDispatchRunInput {
        intent: dispatch_intent(command),
        run_id: "nucleusd-durable-live-provider-write".to_owned(),
        provider_instance_id: "codex:nucleusd-durable-live-provider-write".to_owned(),
        runtime_session_ref: "runtime-session:nucleusd-durable-live-provider-write".to_owned(),
        task_id: "task:nucleusd-durable-live-provider-write".to_owned(),
        work_item_id: "work:nucleusd-durable-live-provider-write".to_owned(),
        operator_confirmation_ref: "operator:nucleusd-cli".to_owned(),
        evidence_refs: vec!["evidence:nucleusd-durable-live-provider-write-command".to_owned()],
    }
}

fn dispatch_intent(command: &CliDurableLiveProviderWriteSmoke) -> DurableCodexLiveSmokeIntent {
    match (command.confirm_real_write, command.confirm_real_effect) {
        (false, _) => DurableCodexLiveSmokeIntent::DryRunOnly,
        (true, false) => DurableCodexLiveSmokeIntent::ConfirmedRealWrite {
            confirmation_ref: "evidence:nucleusd-confirm-real-write".to_owned(),
        },
        (true, true) => DurableCodexLiveSmokeIntent::ConfirmedRealWriteWithEffect {
            confirmation_ref: "evidence:nucleusd-confirm-real-write".to_owned(),
            effect_ref: "evidence:nucleusd-confirm-real-effect".to_owned(),
        },
    }
}
