//! Command adapter records for Git push runner requests.

mod record_builder;
mod types;

pub use types::{
    GitPushRunnerCommandAdapterBlocker, GitPushRunnerCommandAdapterInput,
    GitPushRunnerCommandAdapterRecord, GitPushRunnerCommandAdapterSet,
    GitPushRunnerCommandAdapterStatus, GitPushRunnerCommandKind,
};

use record_builder::command_record;

pub fn git_push_runner_command_adapter(
    input: GitPushRunnerCommandAdapterInput,
) -> GitPushRunnerCommandAdapterSet {
    let mut commands = input
        .authorities
        .authorities
        .iter()
        .cloned()
        .map(|authority| command_record(&input, authority))
        .collect::<Vec<_>>();
    commands.sort_by(|left, right| left.command_id.cmp(&right.command_id));
    let executable_argv_created = commands
        .iter()
        .any(|command| command.executable_argv_created);

    GitPushRunnerCommandAdapterSet {
        command_set_id: "git-push-runner-command-adapter".to_owned(),
        skipped_authority_ids: commands
            .iter()
            .filter(|command| command.status != GitPushRunnerCommandAdapterStatus::Ready)
            .map(|command| command.authority_id.clone())
            .collect(),
        commands,
        executable_argv_created,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        push_executed: false,
        pull_request_created: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
mod tests;
